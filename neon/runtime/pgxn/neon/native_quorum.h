/* Experimental native commit-group provider. No SQL/application API changes. */
#ifndef NEON_NATIVE_QUORUM_H
#define NEON_NATIVE_QUORUM_H
#include "postgres.h"
#include "walproposer.h"

extern void NativeQuorumInit(void);
extern void NativeQuorumShmemRequest(void);
extern void NativeQuorumShmemInit(void);
extern void NativeQuorumReset(void);
/* Called only by the elected proposer, before broadcasting new local WAL. */
extern bool NativeQuorumPump(WalProposer *wp);
/* True transfers this stream to control-only appends; never sends WAL twice. */
extern bool NativeQuorumControlOnly(Safekeeper *sk);
extern XLogRecPtr NativeQuorumDurablePrefix(void);
extern uint64 NativeQuorumProviderCommits(void);
extern uint32 NativeQuorumInflightHighwater(void);
extern uint64 NativeQuorumCopySubmissions(void);
extern uint64 NativeQuorumCohortDelays(void);
extern void NativeQuorumControlReconnected(void);
extern uint64 NativeQuorumControlReconnects(void);
extern uint64 NativeQuorumPipelinedSubmissions(void);
extern bool NativeQuorumSenderOwned(void);
extern bool NativeQuorumPreflightPending(void);
extern int NativeQuorumSenderSocket(int index, uint32 *events, uint64 *version);
/* PG adapter publishes an already verified quorum through the ordered queue. */
extern void WalProposerPublishNativeQuorum(WalProposer *wp, XLogRecPtr quorum);
#endif
