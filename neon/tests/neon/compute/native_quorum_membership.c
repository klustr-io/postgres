/* Focused proof-policy checks. Link with function/data section GC: the test
 * includes the real reducer and discards the PostgreSQL/transport entry points.
 * No running database, network, volume, or copied production algorithm. */
#include "native_quorum.c"

int
main(void)
{
	NativeQuorumView view = {0};
	view.count = 5;
	view.epoch_start = 100;
	view.old_count = view.new_count = 3;
	view.old_mask = 0x07; /* Nodes 0,1,2. */
	view.new_mask = 0x1c; /* Nodes 2,3,4. */
	view.flushed[0] = view.flushed[1] = 200;
	if (quorum_prefix(&view) != 0) return 1; /* Old majority alone. */
	view.flushed[2] = 200;
	if (quorum_prefix(&view) != 0) return 2; /* One shared node is not new majority. */
	view.flushed[3] = 150;
	if (quorum_prefix(&view) != 150) return 3; /* Both majorities, different prefixes. */
	view.flushed[3] = 99;
	if (quorum_prefix(&view) != 0) return 4; /* Old-term prefix cannot vote. */
	view.flushed[3] = 199;
	if (quorum_prefix(&view) != 199) return 5;
	view.new_count = 0;
	view.old_count = 5;
	view.old_mask = 0x1f;
	view.flushed[2] = view.flushed[3] = 0;
	if (quorum_prefix(&view) != 0) return 6; /* Two is not a majority of five. */
	view.flushed[2] = 180;
	if (quorum_prefix(&view) != 180) return 7;
	memset(&view,0,sizeof(view));
	view.epoch_start = 100;
	view.count = view.old_count = MAX_SAFEKEEPERS;
	view.old_mask = UINT32_MAX;
	for (int i = 0; i < 16; i++) view.flushed[i] = 300;
	if (quorum_prefix(&view) != 0) return 8;
	view.flushed[31] = 299;
	if (quorum_prefix(&view) != 299) return 9; /* Highest mask bit, seventeen distinct nodes. */
	{
		NativeQuorumShared state = {0};
		shared = &state;
		enabled = true;
		pg_atomic_init_u64(&state.proof_version,0);
		pg_atomic_init_u64(&state.proof_prefix,0);
		state.view.version = 1;
		state.view.quorum = 300;
		(void) publish_proof_locked();
		if (NativeQuorumDurablePrefix() != 0) return 10; /* Inactive is no proof. */
		state.view.active = true;
		(void) publish_proof_locked();
		if (NativeQuorumDurablePrefix() != 300) return 11;
		state.view.poisoned = true;
		(void) publish_proof_locked();
		if (NativeQuorumDurablePrefix() != 0) return 12;
		state.view.active = state.view.poisoned = false;
		state.view.version++;
		state.view.quorum = 0;
		(void) publish_proof_locked();
		if (NativeQuorumDurablePrefix() != 0) return 13;
		state.view.active = true;
		state.view.quorum = 350;
		(void) publish_proof_locked();
		if (NativeQuorumDurablePrefix() != 350) return 14;
#ifdef __linux__
		shared_completion = true;
		for (int i = 0; i < NQ_COMPLETION_BUCKETS; i++)
			pg_atomic_init_u32(&state.completion_sequence[i],0);
		notified_version = state.view.version;
		notified_prefix = 511;
		state.view.quorum = 1024;
		(void) publish_proof_locked();
		notify_completion();
		for (int i = 0; i < NQ_COMPLETION_BUCKETS; i++)
			if (pg_atomic_read_u32(&state.completion_sequence[i]) != (i <= 2 ? 1 : 0))
				return 15; /* Include both boundary buckets, leave future ranges asleep. */
		state.view.quorum = (NQ_COMPLETION_BUCKETS + 2) * 512;
		(void) publish_proof_locked();
		notify_completion();
		for (int i = 0; i < NQ_COMPLETION_BUCKETS; i++)
			if (pg_atomic_read_u32(&state.completion_sequence[i]) != (i <= 2 ? 2 : 1))
				return 16; /* A full ring jump visits every bucket exactly once. */
		state.view.poisoned = true;
		(void) publish_proof_locked();
		notify_completion();
		for (int i = 0; i < NQ_COMPLETION_BUCKETS; i++)
			if (pg_atomic_read_u32(&state.completion_sequence[i]) != (i <= 2 ? 3 : 2))
				return 17; /* Invalidating an epoch releases every old waiter. */
#endif
	}
	return 0;
}
