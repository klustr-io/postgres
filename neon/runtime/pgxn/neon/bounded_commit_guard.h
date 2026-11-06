#ifndef NEON_BOUNDED_COMMIT_GUARD_H
#define NEON_BOUNDED_COMMIT_GUARD_H
#include "postgres.h"
#include "access/xlogdefs.h"
#include "access/xlog_internal.h"
#include "walproposer.h"

static inline bool
BoundedCommitHasLiveQuorum(WalProposer *wp)
{
    int count = 0;
    int i;

    if (wp->state != WPS_ELECTED)
        return false;
    if (wp->safekeepers_generation == INVALID_GENERATION &&
        wp->mconf.generation == INVALID_GENERATION)
    {
        for (i = 0; i < wp->n_safekeepers; i++)
            if (wp->safekeeper[i].state == SS_ACTIVE)
                count++;
        return wp->quorum > 0 && count >= wp->quorum;
    }
    if (wp->mconf.members.len == 0 || wp->mconf.members.len > MAX_SAFEKEEPERS ||
        wp->mconf.new_members.len > MAX_SAFEKEEPERS)
        return false;
    for (i = 0; i < wp->mconf.members.len; i++)
        if (wp->members_safekeepers[i] && wp->members_safekeepers[i]->state == SS_ACTIVE)
            count++;
    if (count < wp->mconf.members.len / 2 + 1)
        return false;
    if (wp->mconf.new_members.len > 0)
    {
        count = 0;
        for (i = 0; i < wp->mconf.new_members.len; i++)
            if (wp->new_members_safekeepers[i] && wp->new_members_safekeepers[i]->state == SS_ACTIVE)
                count++;
        if (count < wp->mconf.new_members.len / 2 + 1)
            return false;
    }
    return true;
}

/* GetXLogInsertRecPtr() names the next record position, including a virtual
 * page header when no record has yet been inserted on that page. XLogFlush()
 * requires the end of generated WAL, before that header. Match PostgreSQL's
 * XLogBytePosToEndRecPtr() boundary semantics without exporting a core API. */
static inline XLogRecPtr
BoundedCommitWalEnd(XLogRecPtr next_record, int segment_size)
{
    uint64 segment_offset = next_record % segment_size;

    if (segment_offset == SizeOfXLogLongPHD)
        return next_record - SizeOfXLogLongPHD;
    if (segment_offset >= XLOG_BLCKSZ &&
        next_record % XLOG_BLCKSZ == SizeOfXLogShortPHD)
        return next_record - SizeOfXLogShortPHD;
    return next_record;
}
extern void BoundedCommitGuardInit(void);
extern void BoundedCommitGuardShmemRequest(void);
extern void BoundedCommitGuardShmemInit(void);
extern void BoundedCommitGuardPublishQuorum(XLogRecPtr lsn);
extern void BoundedCommitGuardSetQuorumAvailable(bool available);
extern void BoundedCommitGuardReset(void);
#endif
