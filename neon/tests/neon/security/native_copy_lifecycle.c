/* Exercise the production libpq owner with real refused connections. */
#include <assert.h>
#include <dirent.h>
#include "native_quorum_copy.c"

static int reservations;
bool AcquireExternalFD(void) { reservations++; return true; }
void ReleaseExternalFD(void) { assert(reservations > 0); reservations--; }

static int
descriptor_count(void)
{
	DIR *directory = opendir("/proc/self/fd");
	struct dirent *entry;
	int count = 0;
	assert(directory);
	while ((entry = readdir(directory)))
		if (entry->d_name[0] != '.') count++;
	closedir(directory);
	return count;
}

int
main(void)
{
	const char *invalid[] = {
		"http://127.0.0.1:1", "postgresql://user:secret@127.0.0.1:1",
		"postgresql://127.0.0.1:1/database", "postgresql://127.0.0.1:1?sslmode=disable",
		"postgresql://127.0.0.1:1#fragment", "postgresql://127.0.0.1:1\n",
		"postgresql:///tmp/socket", "postgresql://host,other:1"
	};
	for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++)
		assert(NativeCopyCreate(invalid[i], "tenant", "timeline", "token") == NULL);
	NativeCopyConnection *peer = NativeCopyCreate("postgresql://127.0.0.1:1", "tenant", "timeline", "token");
	assert(peer);
	int before = descriptor_count();
	for (int cycle = 0; cycle < 200; cycle++)
	{
		for (int turn = 0; turn < 100; turn++)
		{
			int result = NativeCopyConnectStep(peer);
			assert(reservations >= 0 && reservations <= 1);
			if (result < 0) break;
			usleep(1000);
		}
		NativeCopyReset(peer);
		assert(reservations == 0 && NativeCopySocket(peer) == -1);
		assert(NativeCopyOutstanding(peer) == 0);
		assert(descriptor_count() <= before + 1);
	}
	/* The owner is process-lifetime in PostgreSQL; release it for LeakSanitizer. */
	free(peer->host); free(peer->port); free(peer->options); free(peer);
	puts("PASS: 200 native libpq reconnect/reset cycles; descriptor reservations balanced");
	return 0;
}
