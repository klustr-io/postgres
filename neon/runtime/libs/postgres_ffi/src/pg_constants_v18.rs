// Derived from the pinned PostgreSQL 18 source by neon-ffi-pg18-port.py.
use crate::PgMajorVersion;
pub const MY_PGVERSION: PgMajorVersion = PgMajorVersion::PG18;
pub const XLOG_DBASE_CREATE_FILE_COPY: u8 = 0x00;
pub const XLOG_DBASE_CREATE_WAL_LOG: u8 = 0x10;
pub const XLOG_DBASE_DROP: u8 = 0x20;
pub const BKPIMAGE_APPLY: u8 = 0x02;
pub const BKPIMAGE_COMPRESS_PGLZ: u8 = 0x04;
pub const BKPIMAGE_COMPRESS_LZ4: u8 = 0x08;
pub const BKPIMAGE_COMPRESS_ZSTD: u8 = 0x10;
pub const XLOG_HEAP2_PRUNE_ON_ACCESS: u8 = 0x10;
pub const XLOG_HEAP2_PRUNE_VACUUM_SCAN: u8 = 0x20;
pub const XLOG_HEAP2_PRUNE_VACUUM_CLEANUP: u8 = 0x30;
pub const XLOG_OVERWRITE_CONTRECORD: u8 = 0xD0;
pub const XLOG_CHECKPOINT_REDO: u8 = 0xE0;
pub const XACT_XINFO_HAS_DROPPED_STATS: u32 = 1u32 << 8;
pub const SIZEOF_RELMAPFILE: usize = 524;
pub const PGDATA_SUBDIRS: [&str; 23] = [
    "global",
    "pg_wal/archive_status",
    "pg_wal/summaries",
    "pg_commit_ts",
    "pg_dynshmem",
    "pg_notify",
    "pg_serial",
    "pg_snapshots",
    "pg_subtrans",
    "pg_twophase",
    "pg_multixact",
    "pg_multixact/members",
    "pg_multixact/offsets",
    "base",
    "base/1",
    "pg_replslot",
    "pg_tblspc",
    "pg_stat",
    "pg_stat_tmp",
    "pg_xact",
    "pg_logical",
    "pg_logical/snapshots",
    "pg_logical/mappings",
];
pub fn bkpimg_is_compressed(info: u8) -> bool {
    info & (BKPIMAGE_COMPRESS_PGLZ | BKPIMAGE_COMPRESS_LZ4 | BKPIMAGE_COMPRESS_ZSTD) != 0
}
#[cfg(test)]
mod pg18_constants_tests {
    use super::*;
    #[test]
    fn bindings_are_pg18() {
        assert_eq!(PG_MAJORVERSION_NUM, 18);
        assert_eq!(MY_PGVERSION.major_version_num(), 18);
        assert_eq!(PGDATA_SUBDIRS.len(), 23);
    }
}
