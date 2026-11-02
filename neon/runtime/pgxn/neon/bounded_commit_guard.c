/* Opt-in commit-path admission. This is not a replacement for WAL consensus.
 * A stale quorum cannot be made durable by stopping new acknowledgements:
 * compound failures during extended replication loss need a stated fault model.
 */
#include "postgres.h"
#include <time.h>
#include "access/xact.h"
#include "access/xlog.h"
#include "access/xlogrecovery.h"
#include "fmgr.h"
#include "miscadmin.h"
#include "port/atomics.h"
#include "postmaster/bgworker.h"
#include "postmaster/interrupt.h"
#include "replication/syncrep.h"
#include "storage/ipc.h"
#include "storage/latch.h"
#include "storage/condition_variable.h"
#include "storage/proc.h"
#include "storage/shmem.h"
#include "tcop/dest.h"
#include "tcop/tcopprot.h"
#include "utils/builtins.h"
#include "utils/guc.h"
#include "utils/pg_lsn.h"
#include "utils/wait_event.h"
#include "bounded_commit_guard.h"

typedef struct BoundedCommitShared
{
    pg_atomic_uint64 quorum_lsn;
    pg_atomic_uint64 verified_prefix_at_us;
    pg_atomic_uint64 pending_prefix_lsn;
    pg_atomic_uint64 fast_acks;
    pg_atomic_uint64 waits;
    pg_atomic_uint64 wait_us;
    pg_atomic_uint32 draining;
    pg_atomic_uint32 quorum_available;
    ConditionVariable changed;
} BoundedCommitShared;

static BoundedCommitShared *shared;
static bool enabled = false;
static int max_age_ms = 750;
static int max_lag_mb = 64;
static SyncRepCommitGuard_hook_type previous_hook;

PGDLLEXPORT void bounded_commit_guard_main(Datum arg);
PG_FUNCTION_INFO_V1(bounded_commit_guard_status);
PG_FUNCTION_INFO_V1(bounded_commit_guard_drain);

static uint64
monotonic_us(void)
{
    struct timespec ts;
#ifdef CLOCK_BOOTTIME
    const clockid_t clock_id = CLOCK_BOOTTIME;
#else
    const clockid_t clock_id = CLOCK_MONOTONIC;
#endif
    if (clock_gettime(clock_id, &ts) != 0)
        return 0; /* Invalid clock disables fast ACKs; durable quorum remains safe. */
    return ((uint64) ts.tv_sec) * 1000000 + ts.tv_nsec / 1000;
}

static void
terminate_after_commit(void)
{
    /* Match PostgreSQL's own sync-rep termination protocol: ERROR/FATAL here
     * would interrupt an already committed transaction before cleanup. */
    ereport(WARNING, (errmsg("bounded commit wait interrupted; transaction outcome is unknown")));
    whereToSendOutput = DestNone;
    QueryCancelPending = false;
    ProcDiePending = true;
    InterruptPending = true;
}

static bool
wait_tick(bool committing)
{
    /* A post-commit cancellation must never bypass the guard and return success.
     * Disconnect instead: the transaction outcome is unknown to the client. */
    if (committing && (ProcDiePending || QueryCancelPending))
    {
        terminate_after_commit();
        return false;
    }
    /* Commit waiters reset their latch before subscribing and rechecking the
     * predicate. Resetting here would lose a quorum notification delivered
     * between that recheck and WaitLatch(). The background sampler still polls. */
    if (!committing)
        ResetLatch(MyLatch);
    (void) WaitLatch(MyLatch, WL_LATCH_SET | WL_TIMEOUT | WL_EXIT_ON_PM_DEATH,
                     10L, WAIT_EVENT_SYNC_REP);
    if (!committing)
        CHECK_FOR_INTERRUPTS();
    return true;
}

static void
commit_guard(XLogRecPtr lsn, bool commit)
{
    uint64 started = 0;
    bool waiting = false;
    if (previous_hook)
        previous_hook(lsn, commit);
    if (!enabled || RecoveryInProgress())
        return;
    if (!shared)
    {
        terminate_after_commit();
        return;
    }
    for (;;)
    {
        uint64 quorum, frontier, now;
        bool durable, eligible;
        /* Register before reading the predicate so quorum progress cannot fall
         * into a check/sleep race. Broadcast removes waiters, so rearm after
         * every wake. The common already-durable/eligible path never queues. */
        if (waiting)
        {
            ResetLatch(MyLatch);
            ConditionVariablePrepareToSleep(&shared->changed);
        }
        quorum = pg_atomic_read_u64(&shared->quorum_lsn);
        frontier = pg_atomic_read_u64(&shared->verified_prefix_at_us);
        now = monotonic_us();
        durable = quorum != 0 && lsn <= quorum;
        eligible = synchronous_commit <= SYNCHRONOUS_COMMIT_LOCAL_FLUSH &&
            pg_atomic_read_u32(&shared->quorum_available) != 0 &&
            quorum != 0 && frontier != 0 && now >= frontier &&
            now - frontier < ((uint64) max_age_ms) * 1000 &&
            lsn >= quorum && lsn - quorum <= ((uint64) max_lag_mb) * 1024 * 1024 &&
            pg_atomic_read_u32(&shared->draining) == 0;
        if (durable || eligible)
        {
            if (!durable)
                pg_atomic_fetch_add_u64(&shared->fast_acks, 1);
            if (started)
                pg_atomic_fetch_add_u64(&shared->wait_us, now - started);
            if (waiting)
                ConditionVariableCancelSleep();
            return;
        }
        if (!started)
        {
            started = now;
            pg_atomic_fetch_add_u64(&shared->waits, 1);
        }
        if (!waiting)
        {
            waiting = true;
            continue;
        }
        /* Do not use ConditionVariableSleep here: its interrupt processing
         * must not turn an already-committed transaction into an ERROR. Keep
         * the existing unknown-outcome/disconnect cancellation protocol. */
        if (!wait_tick(true))
        {
            ConditionVariableCancelSleep();
            return;
        }
    }
}

void
BoundedCommitGuardInit(void)
{
    BackgroundWorker worker;
    DefineCustomBoolVariable("neon.bounded_async_commit", "Enable bounded asynchronous commit admission.",
        "Off/local commits take bounded admission; synchronous commits retain the durable quorum barrier.",
        &enabled, false, PGC_POSTMASTER, 0, NULL, NULL, NULL);
    DefineCustomIntVariable("neon.bounded_async_max_age", "Maximum age of the verified external WAL frontier.",
        "Stopping fast ACKs is not a universal compound-failure RPO guarantee.",
        &max_age_ms, 750, 10, 750, PGC_POSTMASTER, GUC_UNIT_MS, NULL, NULL, NULL);
    DefineCustomIntVariable("neon.bounded_async_max_wal", "Maximum WAL bytes ahead of quorum for fast ACKs.",
        NULL, &max_lag_mb, 64, 1, 1024, PGC_POSTMASTER, GUC_UNIT_MB, NULL, NULL, NULL);
    previous_hook = SyncRepCommitGuard_hook;
    SyncRepCommitGuard_hook = commit_guard;
    if (!enabled)
        return;
    memset(&worker, 0, sizeof(worker));
    worker.bgw_flags = BGWORKER_SHMEM_ACCESS | BGWORKER_BACKEND_DATABASE_CONNECTION;
    worker.bgw_start_time = BgWorkerStart_RecoveryFinished;
    worker.bgw_restart_time = 1;
    snprintf(worker.bgw_library_name, BGW_MAXLEN, "neon");
    snprintf(worker.bgw_function_name, BGW_MAXLEN, "bounded_commit_guard_main");
    snprintf(worker.bgw_name, BGW_MAXLEN, "Neon bounded commit guard");
    snprintf(worker.bgw_type, BGW_MAXLEN, "Neon bounded commit guard");
    RegisterBackgroundWorker(&worker);
}

void BoundedCommitGuardShmemRequest(void)
{
    RequestAddinShmemSpace(MAXALIGN(sizeof(BoundedCommitShared)));
}

void BoundedCommitGuardShmemInit(void)
{
    bool found;
    shared = ShmemInitStruct("Neon bounded commit guard", sizeof(BoundedCommitShared), &found);
    if (!found)
    {
        memset(shared, 0, sizeof(*shared));
        pg_atomic_init_u64(&shared->quorum_lsn, 0);
        pg_atomic_init_u64(&shared->verified_prefix_at_us, 0);
        pg_atomic_init_u64(&shared->pending_prefix_lsn, 0);
        pg_atomic_init_u64(&shared->fast_acks, 0);
        pg_atomic_init_u64(&shared->waits, 0);
        pg_atomic_init_u64(&shared->wait_us, 0);
        pg_atomic_init_u32(&shared->draining, 0);
        pg_atomic_init_u32(&shared->quorum_available, 0);
        ConditionVariableInit(&shared->changed);
    }
}

void BoundedCommitGuardPublishQuorum(XLogRecPtr lsn)
{
    if (shared)
    {
        uint64 previous = pg_atomic_read_u64(&shared->quorum_lsn);
        pg_atomic_write_u64(&shared->quorum_lsn, lsn);
        if (lsn != previous)
            ConditionVariableBroadcast(&shared->changed);
    }
}

void BoundedCommitGuardSetQuorumAvailable(bool available)
{
    if (shared)
    {
        uint32 value = available ? 1 : 0;
        if (pg_atomic_exchange_u32(&shared->quorum_available, value) != value)
            ConditionVariableBroadcast(&shared->changed);
    }
}

void BoundedCommitGuardReset(void)
{
    if (shared)
    {
        pg_atomic_write_u64(&shared->quorum_lsn, 0);
        pg_atomic_write_u64(&shared->verified_prefix_at_us, 0);
        pg_atomic_write_u32(&shared->quorum_available, 0);
        ConditionVariableBroadcast(&shared->changed);
    }
}

void
bounded_commit_guard_main(Datum arg)
{
    XLogRecPtr target = InvalidXLogRecPtr;
    uint64 captured_at = 0;
    pqsignal(SIGTERM, die);
    BackgroundWorkerUnblockSignals();
    BackgroundWorkerInitializeConnection("postgres", NULL, 0);
    for (;;)
    {
        CHECK_FOR_INTERRUPTS();
        if (target == InvalidXLogRecPtr)
        {
            /* Time belongs to the sampled WAL prefix, never the later receipt
             * of feedback. Repeated stale feedback cannot refresh admission. */
            captured_at = monotonic_us();
            target = BoundedCommitWalEnd(GetXLogInsertRecPtr(), wal_segment_size);
            pg_atomic_write_u64(&shared->pending_prefix_lsn, target);
            if (target > GetFlushRecPtr(NULL))
                XLogFlush(target); /* Publish idle tails without client activity. */
        }
        if (pg_atomic_read_u32(&shared->quorum_available) != 0 &&
            pg_atomic_read_u64(&shared->quorum_lsn) >= target)
        {
            pg_atomic_write_u64(&shared->verified_prefix_at_us, captured_at);
            ConditionVariableBroadcast(&shared->changed);
            target = InvalidXLogRecPtr;
        }
        wait_tick(false);
    }
}

Datum
bounded_commit_guard_status(PG_FUNCTION_ARGS)
{
    char buffer[768];
    uint64 frontier, now, quorum, pending;
    if (!superuser())
        ereport(ERROR, (errcode(ERRCODE_INSUFFICIENT_PRIVILEGE), errmsg("superuser required")));
    if (!shared)
        ereport(ERROR, (errmsg("Neon must be loaded through shared_preload_libraries")));
    frontier = pg_atomic_read_u64(&shared->verified_prefix_at_us);
    quorum = pg_atomic_read_u64(&shared->quorum_lsn);
    pending = pg_atomic_read_u64(&shared->pending_prefix_lsn);
    now = monotonic_us();
    snprintf(buffer, sizeof(buffer),
        "{\"enabled\":%s,\"max_age_ms\":%d,\"max_wal_bytes\":%llu,\"age_ms\":%lld,"
        "\"quorum_lsn\":\"%X/%X\",\"pending_prefix_lsn\":\"%X/%X\","
        "\"fast_acks\":%llu,\"waits\":%llu,\"wait_us\":%llu,\"draining\":%s,\"quorum_available\":%s}",
        enabled ? "true" : "false", max_age_ms, (unsigned long long) max_lag_mb * 1024 * 1024,
        frontier && now >= frontier ? (long long) ((now - frontier) / 1000) : -1LL,
        LSN_FORMAT_ARGS(quorum),
        LSN_FORMAT_ARGS(pending),
        (unsigned long long) pg_atomic_read_u64(&shared->fast_acks),
        (unsigned long long) pg_atomic_read_u64(&shared->waits),
        (unsigned long long) pg_atomic_read_u64(&shared->wait_us),
        pg_atomic_read_u32(&shared->draining) ? "true" : "false",
        pg_atomic_read_u32(&shared->quorum_available) ? "true" : "false");
    PG_RETURN_TEXT_P(cstring_to_text(buffer));
}

Datum
bounded_commit_guard_drain(PG_FUNCTION_ARGS)
{
    XLogRecPtr target;
    if (!superuser())
        ereport(ERROR, (errcode(ERRCODE_INSUFFICIENT_PRIVILEGE), errmsg("superuser required")));
    if (!shared)
        ereport(ERROR, (errmsg("Neon must be loaded through shared_preload_libraries")));
    if (!enabled)
        ereport(ERROR, (errmsg("bounded commit guard is disabled")));
    /* Sticky until postmaster restart. The caller stops admission first and
     * persists this returned frontier before removing the compute instance. */
    pg_atomic_write_u32(&shared->draining, 1);
    target = BoundedCommitWalEnd(GetXLogInsertRecPtr(), wal_segment_size);
    XLogFlush(target);
    while (pg_atomic_read_u64(&shared->quorum_lsn) < target)
        wait_tick(false);
    PG_RETURN_LSN(target);
}
