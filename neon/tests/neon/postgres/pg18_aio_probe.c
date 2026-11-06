/* Exercise the non-file AIO completion API with real PG18 buffer reads.
 * Disk-backed fixtures stand in for remote bytes; this is not a Neon cluster.
 */
#include "postgres.h"
#include "fmgr.h"
#include "miscadmin.h"
#include "catalog/pg_class.h"
#include "storage/aio.h"
#include "storage/bufpage.h"
#include "storage/md.h"
#include "storage/smgr.h"
#include "utils/guc.h"

PG_MODULE_MAGIC;
PGDLLEXPORT void _PG_init(void);
PG_FUNCTION_INFO_V1(test_neon_aio_calls);
PG_FUNCTION_INFO_V1(test_neon_smgr_conflict);

static bool fail_read;
static bool corrupt_read;
static int read_calls;

static bool
probe_owns(RelFileLocator rlocator, ProcNumber backend, char persistence)
{
	return backend == INVALID_PROC_NUMBER &&
		rlocator.relNumber >= FirstNormalObjectId;
}

static void
probe_startreadv(PgAioHandle *ioh, SMgrRelation reln, ForkNumber forknum,
				 BlockNumber blocknum, void **buffers, BlockNumber nblocks)
{
	read_calls++;
	if (fail_read)
		ereport(ERROR, (errcode(ERRCODE_IO_ERROR), errmsg("injected non-file read failure")));
	pgaio_io_set_target_smgr(ioh, reln, forknum, blocknum, nblocks, false);
	mdreadv(reln, forknum, blocknum, buffers, nblocks);
	if (corrupt_read)
		((PageHeader) buffers[0])->pd_upper = 0;
	pgaio_io_complete_readv(ioh, nblocks);
}

static const f_smgr probe_smgr = {
	.smgr_name = "test_neon_aio",
	.smgr_open = mdopen,
	.smgr_close = mdclose,
	.smgr_create = mdcreate,
	.smgr_exists = mdexists,
	.smgr_unlink = mdunlink,
	.smgr_extend = mdextend,
	.smgr_zeroextend = mdzeroextend,
	.smgr_prefetch = mdprefetch,
	.smgr_maxcombine = mdmaxcombine,
	.smgr_readv = mdreadv,
	.smgr_startreadv = probe_startreadv,
	.smgr_writev = mdwritev,
	.smgr_writeback = mdwriteback,
	.smgr_nblocks = mdnblocks,
	.smgr_truncate = mdtruncate,
	.smgr_immedsync = mdimmedsync,
	.smgr_registersync = mdregistersync,
	.smgr_fd = mdfd,
	.smgr_owns = probe_owns,
};

void
_PG_init(void)
{
	SmgrId first;

	if (!process_shared_preload_libraries_in_progress)
		return;
	DefineCustomBoolVariable("test_neon_aio.fail_read", "Inject a read error", NULL,
							 &fail_read, false, PGC_USERSET, 0, NULL, NULL, NULL);
	DefineCustomBoolVariable("test_neon_aio.corrupt_read", "Corrupt a read page", NULL,
							 &corrupt_read, false, PGC_USERSET, 0, NULL, NULL, NULL);
	first = smgrregister(&probe_smgr);
	if (smgrregister(&probe_smgr) != first)
		elog(ERROR, "storage manager registration is not idempotent");
}

Datum
test_neon_aio_calls(PG_FUNCTION_ARGS)
{
	PG_RETURN_INT32(read_calls);
}

Datum
test_neon_smgr_conflict(PG_FUNCTION_ARGS)
{
	f_smgr different = probe_smgr;

	different.smgr_fd = NULL;
	PG_RETURN_INT32(smgrregister(&different));
}
