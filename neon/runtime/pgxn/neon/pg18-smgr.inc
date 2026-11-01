/* PG18 storage-manager adapter. Included after the shared Neon SMGR methods. */
static SmgrId neon_smgr_id;

static bool
neon_owns(RelFileLocator rlocator, ProcNumber backend, char relpersistence)
{
	/* Unlogged relations retain the existing Neon local-file handling. */
	return backend == INVALID_PROC_NUMBER;
}

static bool
neon_read_is_local(SMgrRelation reln)
{
	return reln->smgr_relpersistence == RELPERSISTENCE_TEMP ||
		reln->smgr_relpersistence == RELPERSISTENCE_UNLOGGED ||
		RelFileInfoEquals(unlogged_build_rel_info, InfoFromSMgrRel(reln));
}

static uint32
neon_maxcombine(SMgrRelation reln, ForkNumber forknum, BlockNumber blocknum)
{
	if (neon_read_is_local(reln))
		return mdmaxcombine(reln, forknum, blocknum);
	return PG_IOV_MAX;
}

static void
neon_startreadv(PgAioHandle *ioh, SMgrRelation reln, ForkNumber forknum,
				BlockNumber blocknum, void **buffers, BlockNumber nblocks)
{
	if (neon_read_is_local(reln))
	{
		mdstartreadv(ioh, reln, forknum, blocknum, buffers, nblocks);
		return;
	}

	/*
	 * The communicator already pipelines remote requests. Complete its read
	 * synchronously in the issuing backend, before transferring buffer pins to
	 * AIO. Never hand a nonexistent remote file descriptor to an IO worker.
	 */
	pgaio_io_set_target_smgr(ioh, reln, forknum, blocknum, nblocks, false);
	neon_readv(reln, forknum, blocknum, buffers, nblocks);
	pgaio_io_complete_readv(ioh, nblocks);
}

static int
neon_fd(SMgrRelation reln, ForkNumber forknum, BlockNumber blocknum, uint32 *off)
{
	if (!neon_read_is_local(reln))
		elog(ERROR, "remote Neon relation has no local file descriptor");
	return mdfd(reln, forknum, blocknum, off);
}

static bool
neon_download_slru_segment(const char *path, int64 segno)
{
	char *buffer = palloc(BLCKSZ * SLRU_PAGES_PER_SEGMENT);
	char temporary[MAXPGPATH];
	int nblocks;
	int fd;
	int saved_errno = 0;

	nblocks = neon_read_slru_segment(NULL, path, segno, buffer);
	if (nblocks <= 0)
	{
		pfree(buffer);
		return false;
	}
	if (nblocks > SLRU_PAGES_PER_SEGMENT)
		elog(ERROR, "invalid Neon SLRU segment length: %d", nblocks);

	/*
	 * Publish a complete file atomically. Concurrent downloads must never
	 * overwrite an existing segment that another backend may already modify.
	 * O_EXCL prevents clobbering a file left by an earlier process.
	 */
	snprintf(temporary, sizeof(temporary), "%s.neon.%d." UINT64_FORMAT,
			 path, MyProcPid, pg_prng_uint64(&pg_global_prng_state));
	fd = OpenTransientFile(temporary, O_WRONLY | O_CREAT | O_EXCL | PG_BINARY);
	if (fd < 0)
		ereport(ERROR, (errcode_for_file_access(),
						errmsg("could not create file \"%s\": %m", temporary)));

	errno = 0;
	if (pg_pwrite(fd, buffer, nblocks * BLCKSZ, 0) != nblocks * BLCKSZ)
		saved_errno = errno ? errno : ENOSPC;
	else if (pg_fsync(fd) != 0)
		saved_errno = errno;
	if (CloseTransientFile(fd) != 0 && saved_errno == 0)
		saved_errno = errno;
	pfree(buffer);

	if (saved_errno == 0 && link(temporary, path) != 0 && errno != EEXIST)
		saved_errno = errno;
	unlink(temporary);
	if (saved_errno != 0)
	{
		errno = saved_errno;
		ereport(ERROR, (errcode_for_file_access(),
						errmsg("could not install Neon SLRU file \"%s\": %m", path)));
	}
	/* A missing directory entry after a crash can be downloaded again. */
	return true;
}

static void
neon_start_build_hook(SMgrRelation reln)
{
	if (reln->smgr_which == neon_smgr_id)
		neon_start_unlogged_build(reln);
}

static void
neon_finish_build_hook(SMgrRelation reln)
{
	if (reln->smgr_which == neon_smgr_id)
		neon_finish_unlogged_build_phase_1(reln);
}

static void
neon_end_build_hook(SMgrRelation reln)
{
	if (reln->smgr_which == neon_smgr_id)
		neon_end_unlogged_build(reln);
}
