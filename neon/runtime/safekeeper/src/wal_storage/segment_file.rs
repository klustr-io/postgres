//! WAL segment I/O scheduling. The engines use the same filesystem operations
//! and durable completion boundary; the experimental inline engine avoids
//! round trips through Tokio's filesystem worker queue.

use std::io::{self, Seek, SeekFrom, Write};

use tokio::fs::File;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::runtime::{Handle, RuntimeFlavor};

#[derive(Debug, Clone, Copy, Default, clap::ValueEnum)]
pub enum WalIoEngine {
    #[default]
    Tokio,
    /// Experimental single-owner ingestion with coalesced write/sync batches.
    Owned,
    /// Experimental owner executes filesystem batches on the bounded WAL runtime.
    Direct,
    /// Experimental: execute segment syscalls in block_in_place sections.
    Inline,
    /// Experimental completion-driven WAL owner and Linux io_uring I/O.
    #[cfg(target_os = "linux")]
    Uring,
}

impl WalIoEngine {
    pub fn uses_owned_ingest(self) -> bool {
        match self {
            Self::Owned | Self::Direct => true,
            #[cfg(target_os = "linux")]
            Self::Uring => true,
            _ => false,
        }
    }

    pub async fn initialize(self) -> io::Result<()> {
        #[cfg(not(unix))]
        if matches!(self, Self::Owned) {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "owned WAL batches require Unix positional writes",
            ));
        }
        #[cfg(target_os = "linux")]
        if matches!(self, Self::Uring) {
            check_uring().await?;
        }
        Ok(())
    }
}

pub(super) enum WalSegmentFile {
    Tokio(File),
    Owned {
        file: std::sync::Arc<std::fs::File>,
        position: u64,
    },
    Inline(std::fs::File),
    Direct(std::fs::File),
    #[cfg(target_os = "linux")]
    Uring {
        file: std::sync::Arc<std::fs::File>,
        position: u64,
    },
}

impl WalSegmentFile {
    pub(super) async fn new(file: File, engine: WalIoEngine) -> io::Result<Self> {
        match engine {
            WalIoEngine::Tokio => Ok(Self::Tokio(file)),
            WalIoEngine::Owned => Ok(Self::Owned {
                file: std::sync::Arc::new(file.into_std().await),
                position: 0,
            }),
            WalIoEngine::Direct => {
                if Handle::current().runtime_flavor() != RuntimeFlavor::MultiThread {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "direct WAL ingestion requires the separate multi-thread WAL runtime",
                    ));
                }
                Ok(Self::Direct(file.into_std().await))
            }
            WalIoEngine::Inline => {
                if Handle::current().runtime_flavor() != RuntimeFlavor::MultiThread {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "inline WAL I/O requires a multi-thread Tokio runtime",
                    ));
                }
                // Wait for any pending Tokio operation before transferring FD ownership.
                Ok(Self::Inline(file.into_std().await))
            }
            #[cfg(target_os = "linux")]
            WalIoEngine::Uring => {
                check_uring().await?;
                Ok(Self::Uring {
                    file: std::sync::Arc::new(file.into_std().await),
                    position: 0,
                })
            }
        }
    }

    pub(super) async fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        match self {
            Self::Tokio(file) => file.write_all(data).await,
            Self::Direct(file) => file.write_all(data),
            Self::Owned { file, position } => {
                if super::native_inline_io() {
                    Self::owned_operation(file, *position, data, false)?;
                    crate::metrics::NATIVE_WAL_INLINE_WRITES.inc();
                } else {
                    Self::write_owned(std::sync::Arc::clone(file), *position, data.to_vec(), false)
                        .await?;
                }
                *position += data.len() as u64;
                Ok(())
            }
            Self::Inline(file) => tokio::task::block_in_place(|| file.write_all(data)),
            #[cfg(target_os = "linux")]
            Self::Uring { file, position } => {
                let mut buffer = data.to_vec();
                let mut retries = 0;
                while !buffer.is_empty() {
                    let system = tokio_epoll_uring::thread_local_system().await;
                    let ((_, returned), result) = system
                        .write(std::sync::Arc::clone(file), *position, buffer)
                        .await;
                    match result {
                        Ok(0) => {
                            return Err(io::Error::new(
                                io::ErrorKind::WriteZero,
                                "short WAL segment write",
                            ));
                        }
                        Ok(written) => {
                            *position += written as u64;
                            if written == returned.len() {
                                return Ok(());
                            }
                            buffer = returned[written..].to_vec();
                            retries = 0;
                        }
                        Err(tokio_epoll_uring::Error::Op(error))
                            if retries < 2
                                && matches!(
                                    error.raw_os_error(),
                                    Some(nix::libc::EINTR | nix::libc::ECANCELED)
                                ) =>
                        {
                            // Positional writes are idempotent at the same offset.
                            buffer = returned;
                            retries += 1;
                        }
                        Err(error) => return Err(uring_error(error)),
                    }
                }
                Ok(())
            }
        }
    }

    /// One owned batch crosses the worker boundary once, including its durable
    /// completion. The file and byte buffer outlive every syscall on that worker.
    pub(super) async fn write_and_sync_data(
        &mut self,
        data: &[u8],
        sync: bool,
    ) -> io::Result<std::time::Duration> {
        if let Self::Direct(file) = self {
            file.write_all(data)?;
            let started = std::time::Instant::now();
            if sync {
                file.sync_data()?;
            }
            return Ok(started.elapsed());
        }
        if let Self::Owned { file, position } = self {
            let length = data.len();
            let duration = if super::native_inline_io() {
                let elapsed = Self::owned_operation(file, *position, data, sync)?;
                crate::metrics::NATIVE_WAL_INLINE_WRITES.inc();
                elapsed
            } else {
                Self::write_owned(std::sync::Arc::clone(file), *position, data.to_vec(), sync)
                    .await?
            };
            *position += length as u64;
            return Ok(duration);
        }
        self.write_all(data).await?;
        self.flush().await?;
        let started = std::time::Instant::now();
        if sync {
            self.sync_data().await?;
        }
        Ok(started.elapsed())
    }

    fn owned_operation(
        file: &std::fs::File,
        offset: u64,
        data: &[u8],
        sync: bool,
    ) -> io::Result<std::time::Duration> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileExt;
            file.write_all_at(data, offset)?;
        }
        #[cfg(not(unix))]
        {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "owned WAL batches require Unix positional writes",
            ));
        }
        let started = std::time::Instant::now();
        if sync {
            file.sync_data()?;
        }
        Ok(started.elapsed())
    }

    async fn write_owned(
        file: std::sync::Arc<std::fs::File>,
        offset: u64,
        data: Vec<u8>,
        sync: bool,
    ) -> io::Result<std::time::Duration> {
        tokio::task::spawn_blocking(move || Self::owned_operation(&file, offset, &data, sync))
            .await
            .map_err(io::Error::other)?
    }

    pub(super) async fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Tokio(file) => file.flush().await,
            Self::Direct(file) => file.flush(),
            Self::Owned { .. } => Ok(()),
            Self::Inline(file) => tokio::task::block_in_place(|| file.flush()),
            // Every io_uring write waits for its kernel completion already.
            #[cfg(target_os = "linux")]
            Self::Uring { .. } => Ok(()),
        }
    }

    pub(super) async fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        match self {
            Self::Tokio(file) => file.seek(position).await,
            Self::Direct(file) => file.seek(position),
            Self::Owned {
                position: current, ..
            } => match position {
                SeekFrom::Start(offset) => {
                    *current = offset;
                    Ok(offset)
                }
                _ => Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "WAL segments require an absolute offset",
                )),
            },
            Self::Inline(file) => tokio::task::block_in_place(|| file.seek(position)),
            #[cfg(target_os = "linux")]
            Self::Uring {
                position: current, ..
            } => match position {
                SeekFrom::Start(offset) => {
                    *current = offset;
                    Ok(offset)
                }
                _ => Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "WAL segments require an absolute offset",
                )),
            },
        }
    }

    pub(super) async fn set_len(&self, length: u64) -> io::Result<()> {
        match self {
            Self::Tokio(file) => file.set_len(length).await,
            Self::Direct(file) => file.set_len(length),
            Self::Owned { file, .. } => {
                let file = std::sync::Arc::clone(file);
                tokio::task::spawn_blocking(move || file.set_len(length))
                    .await
                    .map_err(io::Error::other)?
            }
            Self::Inline(file) => tokio::task::block_in_place(|| file.set_len(length)),
            #[cfg(target_os = "linux")]
            Self::Uring { file, .. } => {
                let file = std::sync::Arc::clone(file);
                // Segment sizing is off the append path. Keep it off the reactor.
                tokio::task::spawn_blocking(move || file.set_len(length))
                    .await
                    .map_err(io::Error::other)?
            }
        }
    }

    pub(super) async fn sync_all(&self) -> io::Result<()> {
        match self {
            Self::Tokio(file) => file.sync_all().await,
            Self::Direct(file) => file.sync_all(),
            Self::Owned { file, .. } => {
                let file = std::sync::Arc::clone(file);
                tokio::task::spawn_blocking(move || file.sync_all())
                    .await
                    .map_err(io::Error::other)?
            }
            Self::Inline(file) => tokio::task::block_in_place(|| file.sync_all()),
            #[cfg(target_os = "linux")]
            Self::Uring { file, .. } => {
                let system = tokio_epoll_uring::thread_local_system().await;
                let (_, result) = system.fsync(std::sync::Arc::clone(file)).await;
                result.map_err(uring_error)
            }
        }
    }

    pub(super) async fn sync_data(&self) -> io::Result<()> {
        match self {
            Self::Tokio(file) => file.sync_data().await,
            Self::Direct(file) => file.sync_data(),
            Self::Owned { file, .. } => {
                let file = std::sync::Arc::clone(file);
                tokio::task::spawn_blocking(move || file.sync_data())
                    .await
                    .map_err(io::Error::other)?
            }
            Self::Inline(file) => tokio::task::block_in_place(|| file.sync_data()),
            #[cfg(target_os = "linux")]
            Self::Uring { file, .. } => {
                let system = tokio_epoll_uring::thread_local_system().await;
                let (_, result) = system.fdatasync(std::sync::Arc::clone(file)).await;
                result.map_err(uring_error)
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn uring_error(error: tokio_epoll_uring::Error<io::Error>) -> io::Error {
    match error {
        tokio_epoll_uring::Error::Op(error) => error,
        tokio_epoll_uring::Error::System(error) => io::Error::other(error),
    }
}

/// Fail closed when the requested engine is unavailable. The library reuses
/// thread-local rings on the hot path; no ring or OS thread is owned per tenant.
#[cfg(target_os = "linux")]
pub(crate) async fn check_uring() -> io::Result<()> {
    static AVAILABLE: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
    AVAILABLE
        .get_or_try_init(|| async {
            let system = tokio_epoll_uring::System::launch()
                .await
                .map_err(io::Error::other)?;
            system.initiate_shutdown().await;
            Ok::<(), io::Error>(())
        })
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn engines_preserve_segment_write_flush_and_truncation() -> anyhow::Result<()> {
        assert_round_trip(&[
            WalIoEngine::Tokio,
            WalIoEngine::Inline,
            WalIoEngine::Owned,
            WalIoEngine::Direct,
        ])
        .await
    }

    async fn assert_round_trip(engines: &[WalIoEngine]) -> anyhow::Result<()> {
        for &engine in engines {
            let directory = camino_tempfile::tempdir()?;
            let path = directory.path().join("segment");
            let file = File::create(&path).await?;
            let mut file = WalSegmentFile::new(file, engine).await?;
            file.set_len(8192).await?;
            file.seek(SeekFrom::Start(4096)).await?;
            file.write_and_sync_data(b"durable-wal", true).await?;
            file.flush().await?;
            file.sync_data().await?;
            file.set_len(4107).await?;
            file.sync_all().await?;
            drop(file);
            let mut restored = File::open(&path).await?;
            assert_eq!(restored.metadata().await?.len(), 4107);
            restored.seek(SeekFrom::Start(4096)).await?;
            let mut tail = Vec::new();
            restored.read_to_end(&mut tail).await?;
            assert_eq!(tail, b"durable-wal");
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn uring_preserves_segment_and_reports_io_failure() -> anyhow::Result<()> {
        assert_round_trip(&[WalIoEngine::Uring]).await?;
        assert_write_error(WalIoEngine::Uring).await
    }

    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn engines_report_io_failure() -> anyhow::Result<()> {
        for engine in [
            WalIoEngine::Tokio,
            WalIoEngine::Inline,
            WalIoEngine::Owned,
            WalIoEngine::Direct,
        ] {
            assert_write_error(engine).await?;
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    async fn assert_write_error(engine: WalIoEngine) -> anyhow::Result<()> {
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .open("/dev/full")
            .await?;
        let mut file = WalSegmentFile::new(file, engine).await?;
        let result = match file.write_all(b"not-durable").await {
            Err(error) => Err(error),
            Ok(()) => file.flush().await,
        };
        assert_eq!(result.unwrap_err().raw_os_error(), Some(nix::libc::ENOSPC));
        Ok(())
    }

    #[tokio::test]
    async fn inline_engine_rejects_current_thread_runtime() -> anyhow::Result<()> {
        for engine in [WalIoEngine::Inline, WalIoEngine::Direct] {
            let file = File::from_std(camino_tempfile::tempfile()?);
            let error = WalSegmentFile::new(file, engine).await.err().unwrap();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        }
        Ok(())
    }
}
