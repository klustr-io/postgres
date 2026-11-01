use std::io::SeekFrom;

use anyhow::{Context, Result};
use async_compression::Level;
use async_compression::tokio::bufread::ZstdDecoder;
use async_compression::tokio::write::ZstdEncoder;
use async_compression::zstd::CParameter;
use camino::Utf8Path;
use nix::NixPath;
use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncBufRead, AsyncSeekExt, AsyncWriteExt};
use tokio_tar::{Archive, Builder, HeaderMode};
use walkdir::WalkDir;

/// Creates a Zstandard tarball.
pub async fn create_zst_tarball(path: &Utf8Path, tarball: &Utf8Path) -> Result<(File, u64)> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .read(true)
        .write(true)
        .open(&tarball)
        .await
        .with_context(|| format!("tempfile creation {tarball}"))?;

    let mut paths = Vec::new();
    for entry in WalkDir::new(path) {
        let entry = entry?;
        let metadata = entry.metadata().expect("error getting dir entry metadata");
        // Also allow directories so that we also get empty directories
        if !(metadata.is_file() || metadata.is_dir()) {
            continue;
        }
        let path = entry.into_path();
        paths.push(path);
    }
    // Do a sort to get a more consistent listing
    paths.sort_unstable();
    let zstd = ZstdEncoder::with_quality_and_params(
        file,
        Level::Default,
        &[CParameter::enable_long_distance_matching(true)],
    );
    let mut builder = Builder::new(zstd);
    // Use reproducible header mode
    builder.mode(HeaderMode::Deterministic);
    for p in paths {
        let rel_path = p.strip_prefix(path)?;
        if rel_path.is_empty() {
            // The top directory should not be compressed,
            // the tar crate doesn't like that
            continue;
        }
        builder.append_path_with_name(&p, rel_path).await?;
    }
    let mut zstd = builder.into_inner().await?;
    zstd.shutdown().await?;
    let mut compressed = zstd.into_inner();
    let compressed_len = compressed.metadata().await?.len();
    compressed.seek(SeekFrom::Start(0)).await?;
    Ok((compressed, compressed_len))
}

/// Creates a Zstandard tarball.
pub async fn extract_zst_tarball(
    path: &Utf8Path,
    tarball: impl AsyncBufRead + Unpin,
) -> Result<()> {
    let decoder = Box::pin(ZstdDecoder::new(tarball));
    let mut archive = Archive::new(decoder);
    archive.unpack(path).await?;
    Ok(())
}

/// Normalize an archive name before a caller joins it to an extraction root.
/// Manual extraction must not trust a header path as a filesystem path.
pub fn checked_archive_path(path: &std::path::Path) -> anyhow::Result<std::path::PathBuf> {
    use std::path::Component;
    let mut relative = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(name) => relative.push(name),
            Component::CurDir => {},
            _ => anyhow::bail!("archive entry must remain within its root: {}", path.display()),
        }
    }
    Ok(relative)
}

#[cfg(test)]
mod tar_security_tests {
    use super::*;
    use futures::StreamExt;
    use tokio::io::AsyncReadExt;

    fn header(name: &str, size: u64, kind: u8) -> tokio_tar::Header {
        let mut header = tokio_tar::Header::new_ustar();
        header.set_path(name).unwrap();
        header.set_size(size);
        header.set_mode(0o600);
        header.as_mut_bytes()[156] = kind;
        header.set_cksum();
        header
    }

    fn append(archive: &mut Vec<u8>, header: &tokio_tar::Header, data: &[u8]) {
        archive.extend_from_slice(header.as_bytes());
        archive.extend_from_slice(data);
        archive.resize(archive.len().next_multiple_of(512), 0);
    }

    #[test]
    fn manual_extraction_rejects_paths_outside_root() {
        for path in ["../escape", "a/../../escape", "/absolute/escape"] {
            assert!(checked_archive_path(std::path::Path::new(path)).is_err());
        }
        assert_eq!(checked_archive_path(std::path::Path::new("./global/pg_control")).unwrap(),
            std::path::PathBuf::from("global/pg_control"));
    }

    #[tokio::test]
    async fn pax_size_does_not_expose_embedded_headers() {
        let body = "size=1024
";
        let mut length = body.len() + 2;
        let pax = loop {
            let line = format!("{length} {body}");
            if line.len() == length { break line; }
            length = line.len();
        };
        let mut tar = Vec::new();
        append(&mut tar, &header("pax", pax.len() as u64, b'x'), pax.as_bytes());
        let mut payload = header("smuggled", 0, b'0').as_bytes().to_vec();
        payload.resize(1024, 0);
        append(&mut tar, &header("payload", 0, b'0'), &payload);
        tar.resize(tar.len() + 1024, 0);
        let mut entries = Archive::new(std::io::Cursor::new(tar)).entries().unwrap();
        let mut entry = entries.next().await.unwrap().unwrap();
        assert_eq!(entry.path().unwrap().as_ref(), std::path::Path::new("payload"));
        assert_eq!(entry.effective_size(), 1024);
        let mut contents = Vec::new();
        entry.read_to_end(&mut contents).await.unwrap();
        assert_eq!(contents.len(), 1024);
        drop(entry);
        assert!(entries.next().await.is_none());
    }

    #[tokio::test]
    async fn unpack_does_not_write_parent_paths() {
        let root = camino_tempfile::tempdir().unwrap();
        let destination = root.path().join("destination");
        tokio::fs::create_dir(&destination).await.unwrap();
        let mut entry_header = header("escape", 3, b'0');
        entry_header.as_mut_bytes()[..100].fill(0);
        entry_header.as_mut_bytes()[..9].copy_from_slice(b"../escape");
        entry_header.set_cksum();
        let mut tar = Vec::new();
        append(&mut tar, &entry_header, b"bad");
        tar.resize(tar.len() + 1024, 0);
        let mut archive = Archive::new(std::io::Cursor::new(tar));
        let _result = archive.unpack(&destination).await;
        assert!(!root.path().join("escape").exists());
    }
}
