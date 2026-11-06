#ifndef NEON_NATIVE_QUORUM_COPY_H
#define NEON_NATIVE_QUORUM_COPY_H
#include "postgres.h"

typedef struct NativeCopyConnection NativeCopyConnection;
extern NativeCopyConnection *NativeCopyCreate(const char *url, const char *tenant,
    const char *timeline, const char *token);
/* Step one connection without blocking. A result is 1 for a 46-byte progress
 * frame, 0 for pending work, -1 for failure. posted belongs to the caller's
 * current group; an earlier reply can arrive before that group is posted. */
extern int NativeCopyStep(NativeCopyConnection *connection, const void *frame, int length,
    uint32 generation, uint64 term, bool *posted, unsigned char reply[46], bool *current_epoch);
/* Bounded, same-epoch stream credits. A queued frame is never a durable proof. */
extern int NativeCopyPipelineStep(NativeCopyConnection *connection, const void *frame, int length,
    uint32 generation, uint64 term, bool *posted, unsigned char reply[46], bool *current_epoch,
    unsigned window);
extern short NativeCopyPipelineEvents(NativeCopyConnection *connection, bool have_data, unsigned window);
extern unsigned NativeCopyOutstanding(NativeCopyConnection *connection);
/* Authenticate and negotiate COPY without appending any WAL. */
extern int NativeCopyConnectStep(NativeCopyConnection *connection);
extern int NativeCopySocket(NativeCopyConnection *connection);
extern short NativeCopyEvents(NativeCopyConnection *connection);
extern void NativeCopyReset(NativeCopyConnection *connection);
extern uint64 NativeCopySocketVersion(NativeCopyConnection *connection);
#endif
