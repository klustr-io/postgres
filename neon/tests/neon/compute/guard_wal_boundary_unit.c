#include "postgres.h"
#include "bounded_commit_guard.h"

int
main(void)
{
	static WalProposer wp;
	const int segments[] = {1024 * 1024, 16 * 1024 * 1024, 1024 * 1024 * 1024};
	int s;

	wp.state = WPS_ELECTED;
	wp.n_safekeepers = 3;
	wp.quorum = 2;
	wp.safekeeper[0].state = wp.safekeeper[1].state = SS_ACTIVE;
	if (!BoundedCommitHasLiveQuorum(&wp)) return 10;
	wp.safekeeper[1].state = SS_OFFLINE;
	if (BoundedCommitHasLiveQuorum(&wp)) return 11;
	wp.safekeeper[1].state = SS_ACTIVE;
	wp.state = WPS_CAMPAIGN;
	if (BoundedCommitHasLiveQuorum(&wp)) return 12;
	wp.state = WPS_ELECTED;
	wp.safekeepers_generation = wp.mconf.generation = 1;
	wp.mconf.members.len = wp.mconf.new_members.len = 3;
	for (s = 0; s < 3; s++)
	{
		wp.members_safekeepers[s] = &wp.safekeeper[s];
		wp.new_members_safekeepers[s] = &wp.safekeeper[s + 2];
	}
	if (BoundedCommitHasLiveQuorum(&wp)) return 13;
	wp.safekeeper[3].state = wp.safekeeper[4].state = SS_ACTIVE;
	if (!BoundedCommitHasLiveQuorum(&wp)) return 14;
	wp.safekeeper[0].state = SS_OFFLINE;
	if (BoundedCommitHasLiveQuorum(&wp)) return 15;

	for (s = 0; s < lengthof(segments); s++)
	{
		int segment_size = segments[s];
		XLogRecPtr base = ((XLogRecPtr) segment_size) * 5;
		int page;

		if (BoundedCommitWalEnd(base + SizeOfXLogLongPHD, segment_size) != base)
			return 1;
		if (BoundedCommitWalEnd(base, segment_size) != base)
			return 2;
		if (BoundedCommitWalEnd(base + SizeOfXLogLongPHD + 8, segment_size) !=
			base + SizeOfXLogLongPHD + 8)
			return 3;
		for (page = 1; page < segment_size / XLOG_BLCKSZ; page++)
		{
			XLogRecPtr start = base + ((XLogRecPtr) page) * XLOG_BLCKSZ;
			if (BoundedCommitWalEnd(start + SizeOfXLogShortPHD, segment_size) != start)
				return 4;
			if (BoundedCommitWalEnd(start + SizeOfXLogShortPHD + 8, segment_size) !=
				start + SizeOfXLogShortPHD + 8)
				return 5;
			if (BoundedCommitWalEnd(start + SizeOfXLogLongPHD, segment_size) !=
				start + SizeOfXLogLongPHD)
				return 6;
		}
	}
	return 0;
}
