//! Internal append transport for a native compute commit-group provider.
//! Append feedback describes one node's progress, never a quorum commit proof.

use anyhow::{Context, Result, bail};
use bytes::{Bytes, BytesMut};
use futures::FutureExt;
use postgres_backend::{CopyStreamHandlerEnd, PostgresBackend, QueryError};
use pq_proto::BeMessage;
use safekeeper_api::membership::SafekeeperGeneration;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite};
use utils::lsn::Lsn;

use crate::safekeeper::{AppendRequest, ProposerAcceptorMessage, SafeKeeper};
use crate::{control_file, wal_storage};

pub const HEADER_BYTES: usize = 1 + 4 + 5 * 8;
pub const MAX_BODY_BYTES: usize = HEADER_BYTES + postgres_ffi::MAX_SEND_SIZE;
const MAX_BATCH_FRAMES: usize = 8;

impl crate::handler::SafekeeperPostgresHandler {
    /// An internal authenticated stream, not an election or public SQL API.
    /// One task owns framing, append completion and its reply on the existing
    /// selected WAL runtime. The dedicated listener isolates ingest from control;
    /// no cross-runtime request task is created per append.
    pub async fn handle_native_wal_append<IO: AsyncRead + AsyncWrite + Unpin>(
        &mut self,
        pgb: &mut PostgresBackend<IO>,
    ) -> Result<(), QueryError> {
        if !self.conf.enable_native_wal_api {
            return Err(QueryError::Other(anyhow::anyhow!(
                "native WAL transport is disabled"
            )));
        }
        // process_query has already checked this connection's tenant scope.
        // Unlike ordinary control commands, native append may never use Trust.
        if !self.native_wal_authenticated() {
            return Err(QueryError::Unauthorized(
                "JWT authentication is required for native WAL".into(),
            ));
        }
        static CONNECTIONS: std::sync::OnceLock<tokio::sync::Semaphore> =
            std::sync::OnceLock::new();
        let _connection = CONNECTIONS
            .get_or_init(|| tokio::sync::Semaphore::new(256))
            .try_acquire()
            .map_err(|_| {
                QueryError::Other(anyhow::anyhow!("native WAL stream admission is full"))
            })?;
        let timeline = self
            .global_timelines
            .get(self.ttid)
            .map_err(|error| QueryError::Other(error.into()))?;
        let resident = timeline
            .wal_residence_guard()
            .await
            .map_err(|error| QueryError::Other(error.into()))?;
        pgb.write_message(&BeMessage::CopyBothResponse).await?;
        let mut reader = pgb.split().context("native WAL stream split")?;
        let result: Result<(), CopyStreamHandlerEnd> = async {
            loop {
                let data = tokio::time::timeout(
                    std::time::Duration::from_secs(60),
                    reader.read_copy_message_limited(MAX_BODY_BYTES),
                )
                .await
                .map_err(|_| anyhow::anyhow!("native WAL stream read deadline exceeded"))??;
                let request = parse_append(data)?;
                let mut requests = vec![request];
                let mut end = None;
                // Consume only already-ready frames. There is no batch-fill
                // delay, and cancelling an unready framed read retains bytes.
                while requests.len() < MAX_BATCH_FRAMES {
                    match reader
                        .read_copy_message_limited(MAX_BODY_BYTES)
                        .now_or_never()
                    {
                        Some(Ok(bytes)) => match parse_append(bytes) {
                            Ok(request) => requests.push(request),
                            Err(error) => {
                                end = Some(error.into());
                                break;
                            }
                        },
                        Some(Err(error)) => {
                            end = Some(error);
                            break;
                        }
                        None => break,
                    }
                }
                // Do not select/cancel this future on EOF. An accepted state
                // mutation completes before a failed write closes the stream.
                let progress = resident.native_append_batch(requests).await?;
                crate::metrics::NATIVE_WAL_BATCHES.inc();
                crate::metrics::NATIVE_WAL_BATCH_FRAMES.inc_by(progress.len() as u64);
                for reply in progress {
                    pgb.write_message_noflush(&BeMessage::CopyData(
                        &reply.to_wire(self.conf.my_id.0),
                    ))?;
                }
                pgb.flush().await.context("flush native batch feedback")?;
                if let Some(end) = end {
                    return Err(end);
                }
            }
        }
        .await;
        pgb.unsplit(reader)?;
        if let Err(end) = result {
            pgb.handle_copy_stream_end(end).await;
        }
        Ok(())
    }
}

pub fn parse_append(body: Bytes) -> Result<AppendRequest> {
    if body.len() < HEADER_BYTES || body.len() > MAX_BODY_BYTES || body[0] != b'a' {
        bail!("expected one bounded protocol-v3 append frame");
    }
    let length = body.len();
    let ProposerAcceptorMessage::AppendRequest(append) = ProposerAcceptorMessage::parse(body, 3)?
    else {
        bail!("only append frames are accepted");
    };
    if length != HEADER_BYTES + append.wal_data.len()
        || append.h.end_lsn.0.checked_sub(append.h.begin_lsn.0)
            != Some(append.wal_data.len() as u64)
    {
        bail!("append frame contains trailing bytes");
    }
    Ok(append)
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppendOutcome {
    Appended,
    AlreadyPresent,
    Gap,
    Fenced,
    Mismatch,
}

#[derive(Debug, Serialize)]
pub struct AppendProgress {
    pub outcome: AppendOutcome,
    pub generation: SafekeeperGeneration,
    pub term: u64,
    pub write_lsn: Lsn,
    pub flush_lsn: Lsn,
    pub commit_lsn: Lsn,
}

impl AppendProgress {
    /// Fixed-width internal response. All integers use network byte order.
    /// Node identity is supplied by the authenticated listener configuration.
    pub fn to_wire(&self, node_id: u64) -> Vec<u8> {
        let mut result = Vec::with_capacity(46);
        result.push(1);
        result.push(match self.outcome {
            AppendOutcome::Appended => 0,
            AppendOutcome::AlreadyPresent => 1,
            AppendOutcome::Gap => 2,
            AppendOutcome::Fenced => 3,
            AppendOutcome::Mismatch => 4,
        });
        result.extend_from_slice(&self.generation.into_inner().to_be_bytes());
        for value in [
            self.term,
            node_id,
            self.write_lsn.0,
            self.flush_lsn.0,
            self.commit_lsn.0,
        ] {
            result.extend_from_slice(&value.to_be_bytes());
        }
        result
    }

    fn snapshot<C: control_file::Storage, W: wal_storage::Storage>(
        sk: &SafeKeeper<C, W>,
        outcome: AppendOutcome,
    ) -> Self {
        Self {
            outcome,
            generation: sk.state.mconf.generation,
            term: sk.state.acceptor_state.term,
            write_lsn: sk.wal_store.write_lsn(),
            flush_lsn: sk.flush_lsn(),
            commit_lsn: sk.state.inmem.commit_lsn,
        }
    }
}

/// Caller holds the timeline write guard across validation, mutation and snapshot.
/// This does not create a timeline, grant votes, adopt terms or truncate a stream.
pub async fn append<C: control_file::Storage, W: wal_storage::Storage>(
    sk: &mut SafeKeeper<C, W>,
    mut request: AppendRequest,
    flush: bool,
) -> Result<AppendProgress> {
    let elected = sk
        .state
        .acceptor_state
        .term_history
        .0
        .last()
        .map(|entry| entry.term);
    if request.h.generation != sk.state.mconf.generation
        || request.h.term != sk.state.acceptor_state.term
        || elected != Some(request.h.term)
        || sk.term_start_lsn == Lsn::INVALID
    {
        return Ok(AppendProgress::snapshot(sk, AppendOutcome::Fenced));
    }
    let written = sk.wal_store.write_lsn();
    if request.h.begin_lsn > written {
        return Ok(AppendProgress::snapshot(sk, AppendOutcome::Gap));
    }
    let overlap = (written.0 - request.h.begin_lsn.0).min(request.wal_data.len() as u64) as usize;
    if overlap != 0
        && !sk
            .wal_store
            .verify_wal(request.h.begin_lsn, &request.wal_data[..overlap])
            .await?
    {
        return Ok(AppendProgress::snapshot(sk, AppendOutcome::Mismatch));
    }
    let duplicate = !request.wal_data.is_empty() && overlap == request.wal_data.len();
    let native_data = !request.wal_data.is_empty();
    let request_term = request.h.term;
    request.wal_data = request.wal_data.slice(overlap..);
    request.h.begin_lsn = written;
    request.h.end_lsn = written + request.wal_data.len() as u64;
    let message = if flush {
        ProposerAcceptorMessage::AppendRequest(request)
    } else {
        ProposerAcceptorMessage::NoFlushAppendRequest(request)
    };
    sk.process_msg(&message).await?;
    if native_data {
        sk.native_append_term = Some(request_term);
    }
    Ok(AppendProgress::snapshot(
        sk,
        if duplicate {
            AppendOutcome::AlreadyPresent
        } else {
            AppendOutcome::Appended
        },
    ))
}

/// Validate each frame in order, retain its outcome, then flush accepted WAL
/// once. Replies describe the resulting complete-record durable prefix; neither
/// receipt nor an intermediate NoFlush append is ever returned as a flush proof.
pub async fn append_batch<C: control_file::Storage, W: wal_storage::Storage>(
    sk: &mut SafeKeeper<C, W>,
    mut requests: Vec<AppendRequest>,
) -> Result<Vec<AppendProgress>> {
    anyhow::ensure!(
        !requests.is_empty() && requests.len() <= MAX_BATCH_FRAMES,
        "invalid native batch size"
    );
    anyhow::ensure!(
        requests
            .iter()
            .all(|request| request.wal_data.len() <= postgres_ffi::MAX_SEND_SIZE),
        "native batch frame too large"
    );
    if requests.len() == 1 {
        return Ok(vec![append(sk, requests.pop().unwrap(), true).await?]);
    }
    // Coalesce the normal, nonoverlapping, single-epoch stream into one owned
    // filesystem submission. Mixed terms, gaps, retries and empty control
    // frames retain ordered per-frame validation below.
    let first = &requests[0];
    let mut next = sk.wal_store.write_lsn();
    let mut contiguous = true;
    let mut bytes = 0;
    for request in &requests {
        contiguous &= request.h.generation == first.h.generation
            && request.h.term == first.h.term
            && !request.wal_data.is_empty()
            && request.h.begin_lsn == next
            && request.h.end_lsn.0.checked_sub(request.h.begin_lsn.0)
                == Some(request.wal_data.len() as u64);
        next = request.h.end_lsn;
        bytes += request.wal_data.len();
    }
    if contiguous {
        let count = requests.len();
        let mut header = first.h.clone();
        header.end_lsn = next;
        let mut data = BytesMut::with_capacity(bytes);
        for request in requests {
            header.commit_lsn = header.commit_lsn.max(request.h.commit_lsn);
            header.truncate_lsn = header.truncate_lsn.max(request.h.truncate_lsn);
            data.extend_from_slice(&request.wal_data);
        }
        let progress = append(
            sk,
            AppendRequest {
                h: header,
                wal_data: data.freeze(),
            },
            true,
        )
        .await?;
        return Ok((0..count)
            .map(|_| AppendProgress::snapshot(sk, progress.outcome))
            .collect());
    }
    let mut outcomes = Vec::with_capacity(requests.len());
    let mut commit = None;
    for request in requests {
        let candidate = request.h.commit_lsn;
        let progress = match append(sk, request, false).await {
            Ok(progress) => progress,
            Err(error) => {
                // Earlier accepted frames complete even if a later mutation
                // fails. No response can expose the unflushed intermediate state.
                if let Some(commit) = commit {
                    sk.flush_native_batch(commit).await?;
                }
                return Err(error);
            }
        };
        if matches!(
            progress.outcome,
            AppendOutcome::Appended | AppendOutcome::AlreadyPresent
        ) {
            commit = Some(commit.map_or(candidate, |previous: Lsn| previous.max(candidate)));
        }
        outcomes.push(progress.outcome);
    }
    if let Some(commit) = commit {
        sk.flush_native_batch(commit).await?;
    }
    Ok(outcomes
        .into_iter()
        .map(|outcome| AppendProgress::snapshot(sk, outcome))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame() -> Vec<u8> {
        let mut bytes = vec![b'a'];
        bytes.extend_from_slice(&1u32.to_be_bytes());
        for value in [2u64, 100, 103, 0, 0] {
            bytes.extend_from_slice(&value.to_be_bytes());
        }
        bytes.extend_from_slice(b"wal");
        bytes
    }
    #[test]
    fn accepts_only_exact_append_frames() {
        let valid = frame();
        assert_eq!(
            parse_append(Bytes::from(valid.clone()))
                .unwrap()
                .wal_data
                .as_ref(),
            b"wal"
        );
        for length in 0..valid.len() {
            assert!(parse_append(Bytes::copy_from_slice(&valid[..length])).is_err());
        }
        let mut extra = valid.clone();
        extra.push(0);
        assert!(parse_append(Bytes::from(extra)).is_err());
        let mut wrong = valid;
        wrong[0] = b'e';
        assert!(parse_append(Bytes::from(wrong)).is_err());
    }
}
