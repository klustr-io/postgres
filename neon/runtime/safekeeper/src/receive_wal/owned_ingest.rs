//! Single-owner WAL ingestion. Network prefetch, state transitions, disk
//! completions and replies are driven by one task, rather than MPSC handoffs.
//! A disk/state future is always driven to completion, even after read failure.

use std::collections::VecDeque;
use std::future::Future;

use bytes::BytesMut;
use futures::FutureExt;
use postgres_backend::{CopyStreamHandlerEnd, PostgresBackend, PostgresBackendReader};
use pq_proto::BeMessage;
use safekeeper_api::models::WalReceiverStatus;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::broadcast;
use utils::pageserver_feedback::PageserverFeedback;

use super::read_message;
use crate::metrics::{WAL_RECEIVER_QUEUE_DEPTH_TOTAL, WAL_RECEIVER_QUEUE_SIZE_TOTAL};
use crate::safekeeper::{
    AcceptorProposerMessage, AppendRequest, AppendResponse, ProposerAcceptorMessage,
};
use crate::timeline::WalResidentTimeline;

const MAX_MESSAGES: usize = 32;
const MAX_BYTES: usize = 1024 * 1024;

#[cfg(target_os = "linux")]
mod batch_timer {
    use nix::sys::time::TimeSpec;
    use nix::sys::timerfd::{ClockId, Expiration, TimerFd, TimerFlags, TimerSetTimeFlags};
    use std::io;
    use std::os::fd::{AsFd, AsRawFd, RawFd};
    use std::time::Duration;
    use tokio::io::unix::AsyncFd;

    struct Timer(TimerFd);
    impl AsRawFd for Timer {
        fn as_raw_fd(&self) -> RawFd {
            self.0.as_fd().as_raw_fd()
        }
    }

    /// A kernel microsecond timer, integrated with the existing reactor. No
    /// sleeping worker or busy spin is needed to form a bounded batch.
    pub(super) struct BatchTimer(AsyncFd<Timer>);
    impl BatchTimer {
        pub(super) fn new() -> io::Result<Self> {
            let timer = TimerFd::new(
                ClockId::CLOCK_MONOTONIC,
                TimerFlags::TFD_NONBLOCK | TimerFlags::TFD_CLOEXEC,
            )?;
            Ok(Self(AsyncFd::new(Timer(timer))?))
        }

        pub(super) fn arm(&self, delay: Duration) -> io::Result<()> {
            self.0
                .get_ref()
                .0
                .set(
                    Expiration::OneShot(TimeSpec::from_duration(delay)),
                    TimerSetTimeFlags::empty(),
                )
                .map_err(io::Error::from)
        }

        pub(super) async fn wait(&self) -> io::Result<()> {
            loop {
                let mut ready = self.0.readable().await?;
                match ready.try_io(|fd| {
                    let count = nix::unistd::read(fd.get_ref().0.as_fd(), &mut [0u8; 8])?;
                    if count != 8 {
                        return Err(io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "short timer expiration",
                        ));
                    }
                    Ok(())
                }) {
                    Ok(result) => return result,
                    Err(_) => continue,
                }
            }
        }
    }
}

struct Input {
    messages: VecDeque<ProposerAcceptorMessage>,
    bytes: usize,
    end: Option<CopyStreamHandlerEnd>,
    feedback: Option<PageserverFeedback>,
    feedback_closed: bool,
}

impl Input {
    fn prefetch_ready<IO: AsyncRead + AsyncWrite + Unpin>(
        &mut self,
        reader: &mut PostgresBackendReader<IO>,
        version: u32,
    ) {
        while self.end.is_none() && self.messages.len() < MAX_MESSAGES && self.bytes < MAX_BYTES {
            match read_message(reader, version).now_or_never() {
                Some(Ok(message)) => self.push(message),
                Some(Err(end)) => self.end = Some(end),
                None => break,
            }
        }
    }

    /// Merge only consecutive frames from one elected stream. This changes
    /// filesystem submission granularity, never the quorum or durable prefix.
    /// Membership/term changes and WAL gaps are retained for consensus checks.
    fn coalesce(&mut self, mut append: AppendRequest) -> AppendRequest {
        let mut data: Option<BytesMut> = None;
        let mut count = 1;
        while count < MAX_MESSAGES {
            let Some(ProposerAcceptorMessage::AppendRequest(next)) = self.messages.front() else {
                break;
            };
            let size = data.as_ref().map_or(append.wal_data.len(), BytesMut::len);
            if next.h.generation != append.h.generation
                || next.h.term != append.h.term
                || next.h.begin_lsn != append.h.end_lsn
                || size + next.wal_data.len() > MAX_BYTES
            {
                break;
            }
            let Some(ProposerAcceptorMessage::AppendRequest(next)) = self.pop() else {
                unreachable!();
            };
            let buffer = data.get_or_insert_with(|| BytesMut::from(append.wal_data.as_ref()));
            buffer.extend_from_slice(&next.wal_data);
            append.h.end_lsn = next.h.end_lsn;
            append.h.commit_lsn = append.h.commit_lsn.max(next.h.commit_lsn);
            append.h.truncate_lsn = append.h.truncate_lsn.max(next.h.truncate_lsn);
            count += 1;
        }
        if let Some(data) = data {
            append.wal_data = data.freeze();
        }
        append
    }

    fn push(&mut self, message: ProposerAcceptorMessage) {
        self.bytes += message.size();
        WAL_RECEIVER_QUEUE_DEPTH_TOTAL.inc();
        WAL_RECEIVER_QUEUE_SIZE_TOTAL.add(message.size() as i64);
        self.messages.push_back(message);
    }

    fn pop(&mut self) -> Option<ProposerAcceptorMessage> {
        let message = self.messages.pop_front()?;
        self.bytes -= message.size();
        WAL_RECEIVER_QUEUE_DEPTH_TOTAL.dec();
        WAL_RECEIVER_QUEUE_SIZE_TOTAL.sub(message.size() as i64);
        Some(message)
    }

    fn receive_feedback(
        &mut self,
        result: Result<PageserverFeedback, broadcast::error::RecvError>,
    ) {
        match result {
            Ok(feedback) => self.feedback = Some(feedback),
            Err(broadcast::error::RecvError::Closed) => self.feedback_closed = true,
            Err(broadcast::error::RecvError::Lagged(_)) => {}
        }
    }

    /// The framing reader retains partial frames across cancellation. Only its
    /// read future is cancelled here: the state/disk operation never is.
    async fn finish<IO, F>(
        &mut self,
        reader: &mut PostgresBackendReader<IO>,
        feedback: &mut broadcast::Receiver<PageserverFeedback>,
        version: u32,
        operation: F,
    ) -> F::Output
    where
        IO: AsyncRead + AsyncWrite + Unpin,
        F: Future,
    {
        tokio::pin!(operation);
        loop {
            tokio::select! {
                biased;
                result = &mut operation => return result,
                result = read_message(reader, version), if self.end.is_none()
                    && self.messages.len() < MAX_MESSAGES && self.bytes < MAX_BYTES => {
                    match result {
                        Ok(message) => self.push(message),
                        Err(end) => self.end = Some(end),
                    }
                }
                result = feedback.recv(), if !self.feedback_closed => self.receive_feedback(result),
            }
        }
    }
}

impl Drop for Input {
    fn drop(&mut self) {
        while self.pop().is_some() {}
    }
}

pub(super) async fn run<IO: AsyncRead + AsyncWrite + Unpin>(
    timeline: WalResidentTimeline,
    first: ProposerAcceptorMessage,
    reader: &mut PostgresBackendReader<IO>,
    writer: &mut PostgresBackend<IO>,
    mut feedback: broadcast::Receiver<PageserverFeedback>,
    version: u32,
    connection_id: u32,
    batch_delay_us: u64,
) -> Result<(), CopyStreamHandlerEnd> {
    #[cfg(target_os = "linux")]
    let batch_timer = if batch_delay_us == 0 {
        None
    } else {
        Some(batch_timer::BatchTimer::new().map_err(anyhow::Error::from)?)
    };
    let registration = timeline.get_walreceivers().register(Some(connection_id));
    let mut input = Input {
        messages: VecDeque::new(),
        bytes: 0,
        end: None,
        feedback: None,
        feedback_closed: false,
    };
    input.push(first);
    let mut output = BytesMut::with_capacity(128);
    let mut last_response: Option<AppendResponse> = None;

    let outcome: Result<(), CopyStreamHandlerEnd> = async {
        loop {
            if timeline.is_cancelled() { return Err(CopyStreamHandlerEnd::Cancelled); }
            // Drain already-ready frames before issuing a file operation.
            input.prefetch_ready(reader, version);
            let message = if let Some(message) = input.pop() {
                message
            } else {
                if let Some(end) = input.end.take() { return Err(end); }
                if input.feedback.is_some() && last_response.is_some() {
                    let mut response = last_response.clone().unwrap();
                    response.pageserver_feedback = input.feedback.take();
                    output.clear();
                    AcceptorProposerMessage::AppendResponse(response).serialize(&mut output, version)?;
                    let wire_message = BeMessage::CopyData(&output);
                    // No disk operation is pending, so cancellation of output is safe.
                    tokio::select! {
                        result = writer.write_message(&wire_message) => { result?; }
                        _ = timeline.cancel.cancelled() => return Err(CopyStreamHandlerEnd::Cancelled),
                    }
                    continue;
                }
                tokio::select! {
                    result = read_message(reader, version) => match result {
                        Ok(message) => input.push(message),
                        Err(end) => input.end = Some(end),
                    },
                    result = feedback.recv(), if !input.feedback_closed => input.receive_feedback(result),
                    _ = timeline.cancel.cancelled() => return Err(CopyStreamHandlerEnd::Cancelled),
                }
                continue;
            };

            if matches!(&message, ProposerAcceptorMessage::Elected(_)) {
                registration.get().status = WalReceiverStatus::Streaming;
            }
            let message = match message {
                ProposerAcceptorMessage::AppendRequest(append) => {
                    #[cfg(target_os = "linux")]
                    if !append.wal_data.is_empty() && input.messages.len() < MAX_MESSAGES && input.bytes < MAX_BYTES {
                        if let Some(timer) = &batch_timer {
                            timer.arm(std::time::Duration::from_micros(batch_delay_us)).map_err(anyhow::Error::from)?;
                            input.finish(reader, &mut feedback, version, timer.wait()).await.map_err(anyhow::Error::from)?;
                            input.prefetch_ready(reader, version);
                        }
                    }
                    let append = input.coalesce(append);
                    // One batch includes its durability completion. No second
                    // scheduling round or explicit FlushWAL message is needed.
                    ProposerAcceptorMessage::AppendRequest(append)
                }
                message => message,
            };
            let reply = input.finish(reader, &mut feedback, version, timeline.process_msg(&message)).await?;
            if let Some(mut reply) = reply {
                if let AcceptorProposerMessage::AppendResponse(response) = &mut reply {
                    if input.feedback.is_some() { response.pageserver_feedback = input.feedback.take(); }
                    last_response = Some(response.clone());
                }
                output.clear();
                reply.serialize(&mut output, version)?;
                let wire_message = BeMessage::CopyData(&output);
                let send = async {
                    tokio::select! {
                        result = writer.write_message(&wire_message) => result.map(|_| ()).map_err(CopyStreamHandlerEnd::from),
                        _ = timeline.cancel.cancelled() => Err(CopyStreamHandlerEnd::Cancelled),
                    }
                };
                input.finish(reader, &mut feedback, version, send).await?;
            }
        }
    }.await;

    // Every processed append has completed its durability operation. Prefetched
    // frames left after an error were never acknowledged and may be retransmitted.
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::safekeeper::AppendRequestHeader;
    use bytes::Bytes;
    use safekeeper_api::membership::SafekeeperGeneration as Generation;
    use utils::lsn::Lsn;

    fn input() -> Input {
        Input {
            messages: VecDeque::new(),
            bytes: 0,
            end: None,
            feedback: None,
            feedback_closed: false,
        }
    }

    fn append(start: u64, data: &'static [u8]) -> AppendRequest {
        AppendRequest {
            h: AppendRequestHeader {
                generation: Generation::new(1),
                term: 2,
                begin_lsn: Lsn(start),
                end_lsn: Lsn(start + data.len() as u64),
                commit_lsn: Lsn(start),
                truncate_lsn: Lsn(start),
            },
            wal_data: Bytes::from_static(data),
        }
    }

    #[test]
    fn coalesces_consecutive_data_and_frontier_frames() {
        let mut queue = input();
        queue.push(ProposerAcceptorMessage::AppendRequest(append(12, b"cd")));
        queue.push(ProposerAcceptorMessage::AppendRequest(append(14, b"")));
        let merged = queue.coalesce(append(10, b"ab"));
        assert_eq!(merged.wal_data.as_ref(), b"abcd");
        assert_eq!(merged.h.begin_lsn, Lsn(10));
        assert_eq!(merged.h.end_lsn, Lsn(14));
        assert_eq!(merged.h.commit_lsn, Lsn(14));
        assert_eq!(merged.h.truncate_lsn, Lsn(14));
        assert!(queue.messages.is_empty());
        assert_eq!(queue.bytes, 0);
    }

    #[test]
    fn preserves_term_generation_gap_and_control_boundaries() {
        for barrier in 0..4 {
            let mut queue = input();
            let mut next = append(12, b"cd");
            match barrier {
                0 => next.h.term += 1,
                1 => next.h.generation = Generation::new(2),
                2 => next = append(13, b"cd"),
                _ => {}
            }
            queue.push(if barrier == 3 {
                ProposerAcceptorMessage::FlushWAL
            } else {
                ProposerAcceptorMessage::AppendRequest(next)
            });
            let merged = queue.coalesce(append(10, b"ab"));
            assert_eq!(merged.wal_data.as_ref(), b"ab");
            assert_eq!(queue.messages.len(), 1);
        }
    }

    #[test]
    fn bounds_frame_coalescing() {
        let mut queue = input();
        for offset in 1..=MAX_MESSAGES {
            queue.push(ProposerAcceptorMessage::AppendRequest(append(
                offset as u64,
                b"a",
            )));
        }
        let merged = queue.coalesce(append(0, b"a"));
        assert_eq!(merged.wal_data.len(), MAX_MESSAGES);
        assert_eq!(queue.messages.len(), 1);
    }
}
