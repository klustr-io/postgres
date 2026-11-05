/*
 * Experimental direct quorum group commit. Default off; this is not a release
 * durability claim. The proposer owns election and a drained data-owner handoff.
 * The sender-owned mode pipelines independent persistent peer connections and
 * publishes a complete-record quorum prefix. The earlier bounded foreground
 * group provider remains available for controlled comparisons.
 * Local WAL remains fsynced before submission. Optional cohort formation waits
 * require concurrent writers. Sender-owned polling can use an explicit bounded
 * spin budget only while the readable WAL tail still needs a quorum.
 */
#include "postgres.h"
#include <curl/curl.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <time.h>
#include <unistd.h>
#ifdef __linux__
#include <linux/futex.h>
#include <sys/syscall.h>
#endif
#include "access/xact.h"
#include "access/xlog.h"
#include "access/xlog_internal.h"
#include "access/xlogrecovery.h"
#include "miscadmin.h"
#include "pgstat.h"
#include "port/atomics.h"
#include "replication/syncrep.h"
#include "replication/walsender_private.h"
#include "storage/fd.h"
#include "storage/latch.h"
#include "storage/lwlock.h"
#include "storage/proc.h"
#include "storage/procarray.h"
#include "storage/pmsignal.h"
#include "storage/shmem.h"
#include "storage/spin.h"
#include "utils/guc.h"
#include "neon.h"
#include "native_quorum.h"
#include "native_quorum_copy.h"

#define NQ_FRAME_BYTES (45 + MAX_SEND_SIZE)
#define NQ_REPLY_BYTES 46
#define NQ_SNAPSHOT_MAX_AGE_US UINT64CONST(2000000)
#define NQ_MAX_GROUPS 4
#define NQ_GROUP_SLOTS (NQ_MAX_GROUPS + 1) /* Separate background repair owner. */
#define NQ_COMPLETION_BUCKETS 64
#define NQ_COMPLETION_SHIFT 9 /* 512-byte WAL ranges, not backend identities. */

typedef struct NativeQuorumView
{
    uint64 version, term, refreshed_us;
    Generation generation;
    int count, old_count, new_count, proposer_procno;
    uint32 old_mask, new_mask;
    uint32 repair_mask; /* Response-local; never shared as durability authority. */
    uint64 ids[MAX_SAFEKEEPERS];
    XLogRecPtr written[MAX_SAFEKEEPERS], flushed[MAX_SAFEKEEPERS];
    XLogRecPtr epoch_start, quorum;
    bool active, poisoned;
} NativeQuorumView;

typedef struct NativeQuorumGroup
{
    uint64 version;
    XLogRecPtr target;
    bool active;
    bool forming;
} NativeQuorumGroup;

typedef struct NativeQuorumShared
{
    slock_t mutex;
    NativeQuorumView view;
    pg_atomic_uint64 provider_commits;
    pg_atomic_uint64 copy_submissions;
    pg_atomic_uint64 cohort_delays;
    pg_atomic_uint64 last_notify_us;
    pg_atomic_uint64 control_reconnects;
    pg_atomic_uint64 pipelined_submissions;
    pg_atomic_uint64 proof_version, proof_prefix;
    pg_atomic_uint32 completion_sequence[NQ_COMPLETION_BUCKETS];
    NativeQuorumGroup groups[NQ_GROUP_SLOTS];
    uint32 inflight_highwater;
} NativeQuorumShared;

typedef struct NativeQuorumPeer
{
    uint64 id;
    char *url;
    CURL *handle;
    unsigned char *body;
    unsigned char reply[NQ_REPLY_BYTES];
    size_t reply_len;
    bool added;
    NativeCopyConnection *copy;
    bool sender_active;
    XLogRecPtr sender_queued_lsn;
    uint64 sender_started_us, sender_retry_us;
} NativeQuorumPeer;

static bool enabled;
static bool copy_transport;
static bool sender_owned;
static bool shared_completion;
static int sender_spin_us;
static int sender_window = 8;
static char *endpoints;
static NativeQuorumShared *shared;
static LWLockPadded *group_locks;
static int inflight_limit = 1;
static int group_delay_us;
static NativeQuorumPeer peers[MAX_SAFEKEEPERS];
static int peer_count;
static bool transport_attempted, transport_ready;
static struct curl_slist *headers;
static CURLM *multi;
static SyncRepCommitProvider_hook_type previous_provider;
/* Proposer-local timers; no process-shared authority or durability lives here. */
static uint64 pending_since_us, last_control_us;
static XLogRecPtr notified_prefix;
static uint64 notified_version;

/* Called under the metadata lock. A reader accepts a prefix only between two
 * equal nonzero version reads. Clear the version before invalidating a proof. */
static bool
publish_proof_locked(void)
{
    uint64 old = pg_atomic_read_u64(&shared->proof_prefix);
    uint64 version = pg_atomic_read_u64(&shared->proof_version);
    if (!shared->view.active || shared->view.poisoned)
    {
        pg_atomic_write_u64(&shared->proof_version,0);
        pg_write_barrier();
        pg_atomic_write_u64(&shared->proof_prefix,0);
        return version != 0;
    }
    if (version != shared->view.version)
    {
        pg_atomic_write_u64(&shared->proof_version,0);
        pg_write_barrier();
    }
    pg_atomic_write_u64(&shared->proof_prefix,shared->view.quorum);
    pg_write_barrier();
    pg_atomic_write_u64(&shared->proof_version,shared->view.version);
    return old != shared->view.quorum || version != shared->view.version;
}

static void
notify_completion(void)
{
#ifdef __linux__
    if (shared_completion)
    {
        uint64 version = pg_atomic_read_u64(&shared->proof_version);
        XLogRecPtr prefix = pg_atomic_read_u64(&shared->proof_prefix);
        uint64 first = notified_prefix >> NQ_COMPLETION_SHIFT;
        uint64 last = prefix >> NQ_COMPLETION_SHIFT;
        /* A reset/re-election wakes every bucket. Large jumps are bounded to
         * one pass, so backlog repair cannot turn into an unbounded loop. */
        if (version != notified_version || prefix < notified_prefix ||
            last - first >= NQ_COMPLETION_BUCKETS)
        {
            first = 0;
            last = NQ_COMPLETION_BUCKETS - 1;
        }
        for (uint64 range = first; range <= last; range++)
        {
            pg_atomic_uint32 *sequence = &shared->completion_sequence[range % NQ_COMPLETION_BUCKETS];
            pg_atomic_fetch_add_u32(sequence,1);
            (void) syscall(SYS_futex,&sequence->value,FUTEX_WAKE,INT_MAX,NULL,NULL,0);
        }
        notified_prefix = prefix;
        notified_version = version;
    }
#endif
}

static uint64
now_us(void)
{
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0)
        return 0;
    return ((uint64) ts.tv_sec) * 1000000 + ts.tv_nsec / 1000;
}

static void
snapshot(NativeQuorumView *view)
{
    SpinLockAcquire(&shared->mutex);
    *view = shared->view;
    SpinLockRelease(&shared->mutex);
}

static bool
usable(const NativeQuorumView *view)
{
    uint64 now = now_us();
    return view->active && !view->poisoned && now && view->refreshed_us &&
        now >= view->refreshed_us && now - view->refreshed_us < NQ_SNAPSHOT_MAX_AGE_US;
}

static uint64
get64(const unsigned char *data)
{
    uint64 value = 0;
    for (int i = 0; i < 8; i++)
        value = (value << 8) | data[i];
    return value;
}

static uint32
get32(const unsigned char *data)
{
    return ((uint32) data[0] << 24) | ((uint32) data[1] << 16) |
        ((uint32) data[2] << 8) | data[3];
}

static void
put64(unsigned char *data, uint64 value)
{
    for (int i = 7; i >= 0; i--)
    {
        data[i] = value & 255;
        value >>= 8;
    }
}

static void
put32(unsigned char *data, uint32 value)
{
    for (int i = 3; i >= 0; i--)
    {
        data[i] = value & 255;
        value >>= 8;
    }
}

static size_t
receive_reply(char *data, size_t size, size_t count, void *arg)
{
    NativeQuorumPeer *peer = arg;
    size_t length;
    if (size && count > SIZE_MAX / size)
        return 0;
    length = size * count;
    if (length > sizeof(peer->reply) - peer->reply_len)
        return 0;
    memcpy(peer->reply + peer->reply_len, data, length);
    peer->reply_len += length;
    return length;
}

/* Only HTTPS or literal IPv4 loopback for private fixtures. No URL credentials,
 * query strings, fragments, redirects, ambient HTTP proxies or TLS bypasses. */
static bool
transport_init(void)
{
    char *list, *save, *entry;
    char authorization[8192];
    if (transport_attempted)
        return transport_ready;
    transport_attempted = true;
    if (!endpoints || !*endpoints || !neon_auth_token || !*neon_auth_token ||
        strlen(neon_auth_token) > sizeof(authorization) - 32 ||
        strpbrk(neon_auth_token, "\r\n"))
        return false;
    if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK)
        return false;
    multi = curl_multi_init();
    if (!multi)
        return false;
    snprintf(authorization, sizeof(authorization), "Authorization: Bearer %s", neon_auth_token);
    headers = curl_slist_append(headers, "Content-Type: application/octet-stream");
    headers = curl_slist_append(headers, "Accept: application/vnd.neon.wal-progress-v1");
    headers = curl_slist_append(headers, "Expect:");
    headers = curl_slist_append(headers, authorization);
    memset(authorization, 0, sizeof(authorization));
    if (!headers || !neon_tenant || !neon_timeline)
        return false;
    list = strdup(endpoints);
    if (!list)
        return false;
    save = NULL;
    for (entry = strtok_r(list, ",", &save); entry; entry = strtok_r(NULL, ",", &save))
    {
        char *url, *end;
        NativeQuorumPeer *peer;
        uint64 id;
        if (peer_count >= MAX_SAFEKEEPERS)
            goto invalid;
        errno = 0;
        id = strtoull(entry, &end, 10);
        if (errno || end == entry || *end != '=' || !id)
            goto invalid;
        url = end + 1;
        if ((strncmp(url,"https://",8) != 0 && strncmp(url,"http://127.0.0.1:",17) != 0 &&
             strncmp(url,"postgresql://",13) != 0) ||
            strpbrk(url,"@?#\r\n\t ") || !*url)
            goto invalid;
        for (int i = 0; i < peer_count; i++)
            if (peers[i].id == id)
                goto invalid;
        peer = &peers[peer_count++];
        if (peer_count == 1)
            copy_transport = strncmp(url,"postgresql://",13) == 0;
        else if (copy_transport != (strncmp(url,"postgresql://",13) == 0))
            goto invalid;
        peer->id = id;
        peer->body = malloc(NQ_FRAME_BYTES);
        if (copy_transport)
        {
            peer->copy = NativeCopyCreate(url,neon_tenant,neon_timeline,neon_auth_token);
            if (!peer->body || !peer->copy)
                goto invalid;
            continue;
        }
        peer->url = malloc(strlen(url) + strlen(neon_tenant) + strlen(neon_timeline) + 64);
        peer->handle = curl_easy_init();
        if (!peer->body || !peer->url || !peer->handle)
            goto invalid;
        snprintf(peer->url, strlen(url) + strlen(neon_tenant) + strlen(neon_timeline) + 64,
            "%s/v1/tenant/%s/timeline/%s/wal", url, neon_tenant, neon_timeline);
        curl_easy_setopt(peer->handle, CURLOPT_URL, peer->url);
        curl_easy_setopt(peer->handle, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(peer->handle, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1);
        curl_easy_setopt(peer->handle, CURLOPT_PROXY, "");
        curl_easy_setopt(peer->handle, CURLOPT_FOLLOWLOCATION, 0L);
        curl_easy_setopt(peer->handle, CURLOPT_SSL_VERIFYPEER, 1L);
        curl_easy_setopt(peer->handle, CURLOPT_SSL_VERIFYHOST, 2L);
        curl_easy_setopt(peer->handle, CURLOPT_NOSIGNAL, 1L);
        curl_easy_setopt(peer->handle, CURLOPT_CONNECTTIMEOUT_MS, 100L);
        curl_easy_setopt(peer->handle, CURLOPT_TIMEOUT_MS, 250L);
        curl_easy_setopt(peer->handle, CURLOPT_WRITEFUNCTION, receive_reply);
        curl_easy_setopt(peer->handle, CURLOPT_WRITEDATA, peer);
        curl_easy_setopt(peer->handle, CURLOPT_PRIVATE, peer);
    }
    free(list);
    transport_ready = peer_count > 0;
    return transport_ready;
invalid:
    free(list);
    return false;
}

static NativeQuorumPeer *
peer_for(uint64 id)
{
    for (int i = 0; i < peer_count; i++)
        if (peers[i].id == id)
            return &peers[i];
    return NULL;
}

static bool
read_local_wal(XLogRecPtr start, size_t length, TimeLineID tli, unsigned char *data)
{
#if PG_VERSION_NUM >= 170000
    /* The caller caps reads at the locally flushed prefix. The core routine
     * verifies buffer identity around its copy and falls back on eviction. */
    Size buffered = WALReadFromBuffers((char *)data,start,length,tli);
    start += buffered;
    data += buffered;
    length -= buffered;
#endif
    while (length)
    {
        XLogSegNo segment;
        char filename[MAXPGPATH];
        int fd;
        size_t count = Min(length, wal_segment_size - XLogSegmentOffset(start, wal_segment_size));
        size_t done = 0;
        XLByteToSeg(start, segment, wal_segment_size);
        XLogFilePath(filename, tli, segment, wal_segment_size);
        fd = OpenTransientFile(filename, O_RDONLY | PG_BINARY);
        if (fd < 0)
            return false;
        while (done < count)
        {
            ssize_t got = pg_pread(fd, data + done, count - done,
                XLogSegmentOffset(start, wal_segment_size) + done);
            if (got < 0 && errno == EINTR)
                continue;
            if (got <= 0)
            {
                CloseTransientFile(fd);
                return false;
            }
            done += got;
        }
        CloseTransientFile(fd);
        start += count;
        data += count;
        length -= count;
    }
    return true;
}

static XLogRecPtr
membership_prefix(const NativeQuorumView *view, uint32 mask, int members)
{
    XLogRecPtr values[MAX_SAFEKEEPERS];
    int count = 0;
    if (members <= 0 || members > MAX_SAFEKEEPERS)
        return InvalidXLogRecPtr;
    for (int i = 0; i < view->count; i++)
        if ((mask & (UINT32_C(1) << i)) && view->flushed[i] >= view->epoch_start)
            values[count++] = view->flushed[i];
    if (count < members / 2 + 1)
        return InvalidXLogRecPtr;
    /* Fixed small arrays: descending order and the majority's lowest prefix. */
    for (int i = 1; i < count; i++)
        for (int j = i; j > 0 && values[j] > values[j-1]; j--)
        {
            XLogRecPtr value = values[j];
            values[j] = values[j-1];
            values[j-1] = value;
        }
    return values[members / 2];
}

static XLogRecPtr
quorum_prefix(const NativeQuorumView *view)
{
    XLogRecPtr result = membership_prefix(view, view->old_mask, view->old_count);
    if (view->new_count)
        result = Min(result, membership_prefix(view, view->new_mask, view->new_count));
    return result;
}

static int
prepare_frame(NativeQuorumPeer *peer, NativeQuorumView *view, int index,
    XLogRecPtr start, XLogRecPtr available, TimeLineID tli, bool maintenance)
{
    size_t length;
    if (start > available)
        return 0;
    if (start == available && view->flushed[index] >= available)
        return 0; /* This peer already proved the entire readable prefix. */
    length = maintenance ? 0 : Min(available-start,MAX_SEND_SIZE);
    peer->reply_len = 0;
    peer->body[0] = 'a';
    put32(peer->body + 1,view->generation);
    put64(peer->body + 5,view->term);
    put64(peer->body + 13,start);
    put64(peer->body + 21,start + length);
    put64(peer->body + 29,view->quorum);
    put64(peer->body + 37,0);
    if (length && !read_local_wal(start,length,tli,peer->body + 45))
        return 0;
    return length + 45;
}

static bool
accept_progress(NativeQuorumView *view, NativeQuorumPeer *peer)
{
    int index = -1;
    if (peer->reply_len != NQ_REPLY_BYTES || peer->reply[0] != 1)
        return false;
    for (int i = 0; i < view->count; i++)
        if (view->ids[i] == peer->id)
            index = i;
    if (index < 0 || get64(peer->reply + 14) != peer->id ||
        get32(peer->reply + 2) != view->generation || get64(peer->reply + 6) != view->term ||
        peer->reply[1] >= 3)
    {
        elog(LOG,"native quorum response rejected: node=" UINT64_FORMAT " received_node=" UINT64_FORMAT
            " generation=%u expected_generation=%u term=" UINT64_FORMAT " expected_term=" UINT64_FORMAT " outcome=%u",
            peer->id,get64(peer->reply + 14),get32(peer->reply + 2),view->generation,
            get64(peer->reply + 6),view->term,peer->reply[1]);
        view->poisoned = true;
        return false;
    }
    /* Record ends can include alignment/segment-switch padding beyond physical
     * write_lsn. Both are bounded by this compute's locally flushed WAL. */
    if (get64(peer->reply + 30) > GetFlushRecPtr(NULL) || get64(peer->reply + 22) > GetFlushRecPtr(NULL))
        return false;
    view->written[index] = get64(peer->reply + 22);
    view->flushed[index] = get64(peer->reply + 30);
    if (peer->reply[1] == 2)
        view->repair_mask |= UINT32_C(1) << index;
    return true;
}

/* One elected process owns all data connections. Each peer advances
 * independently; a slow minority cannot hold the next majority frame behind
 * its reply. There are no foreground owners, overlapping appends or group
 * locks in this mode. Socket readiness drives the next bounded step. */
static void
sender_step(NativeQuorumView *view)
{
    TimeLineID tli;
    XLogRecPtr available = GetFlushRecPtr(&tli);
    uint64 now = now_us();
    bool advanced = false;
    view->repair_mask = 0;
    for (int i = 0; i < view->count && !view->poisoned; i++)
    {
        NativeQuorumPeer *peer = peer_for(view->ids[i]);
        if (!peer || now < peer->sender_retry_us)
            continue;
        if (peer->sender_active && now - peer->sender_started_us >= 1000000)
        {
            NativeCopyReset(peer->copy);
            peer->sender_active = false;
            peer->sender_queued_lsn = view->written[i];
        }
        /* Drain available replies and fill bounded stream credits. Queued LSNs
         * are scheduling hints only; the reducer still uses confirmed flush. */
        for (int turn = 0; turn < 2 * sender_window; turn++)
        {
            bool current_epoch = false;
            bool posted = false;
            bool was_active = peer->sender_active;
            bool had_outstanding = NativeCopyOutstanding(peer->copy) != 0;
            XLogRecPtr start = Max(view->written[i],peer->sender_queued_lsn);
            int length = (NativeCopyOutstanding(peer->copy) >= sender_window ||
                (had_outstanding && start >= available)) ? 0 :
                prepare_frame(peer,view,i,start,available,tli,false);
            int result = NativeCopyPipelineStep(peer->copy,peer->body,length,
                view->generation,view->term,&posted,peer->reply,&current_epoch,sender_window);
            if (posted)
            {
                peer->sender_queued_lsn = start + length - 45;
                pg_atomic_fetch_add_u64(&shared->copy_submissions,1);
                if (NativeCopyOutstanding(peer->copy) > 1)
                    pg_atomic_fetch_add_u64(&shared->pipelined_submissions,1);
                if (!had_outstanding)
                    peer->sender_started_us = now;
            }
            peer->sender_active = NativeCopyOutstanding(peer->copy) != 0 ||
                (result == 0 && !posted && length > 0);
            if (!was_active && peer->sender_active)
                peer->sender_started_us = now;
            if (result < 0)
            {
                peer->sender_active = false;
                peer->sender_queued_lsn = view->written[i];
                peer->sender_retry_us = now + 50000;
                break;
            }
            if (result == 1)
            {
                peer->sender_started_us = now;
                if (current_epoch)
                {
                    peer->reply_len = NQ_REPLY_BYTES;
                    (void) accept_progress(view,peer);
                    if (peer->reply[1] == 2)
                    {
                        /* A restarted peer lost the queued prefix. Abandon
                         * credits and resend from its actual written cursor. */
                        NativeCopyReset(peer->copy);
                        peer->sender_active = false;
                        peer->sender_queued_lsn = view->written[i];
                        break;
                    }
                }
            }
            if (view->poisoned || (result == 0 && !posted))
                break;
        }
    }
    view->quorum = Max(view->quorum,quorum_prefix(view));
    SpinLockAcquire(&shared->mutex);
    if (view->version == shared->view.version && shared->view.active)
    {
        shared->view = *view;
        advanced = publish_proof_locked();
    }
    SpinLockRelease(&shared->mutex);
    if (advanced)
        notify_completion();
}

bool
NativeQuorumSenderOwned(void)
{
    return enabled && sender_owned;
}

bool
NativeQuorumPreflightPending(void)
{
    bool connecting = false;
    uint64 now = now_us();
    if (!enabled || !shared || shared->view.active || !copy_transport)
        return false;
    for (int i = 0; i < peer_count; i++)
    {
        if (now < peers[i].sender_retry_us)
            return false; /* Retry on subsequent work, without an idle hot loop. */
        if (peers[i].copy && NativeCopySocket(peers[i].copy) >= 0)
            connecting = true;
    }
    return connecting;
}

int
NativeQuorumSenderSocket(int index, uint32 *events, uint64 *version)
{
    NativeQuorumPeer *peer;
    short wanted;
    *events = WL_SOCKET_READABLE;
    *version = 0;
    if (!NativeQuorumSenderOwned() || !shared || !shared->view.active || shared->view.poisoned ||
        index < 0 || index >= peer_count || !peers[index].copy)
        return -1;
    peer = &peers[index];
    *version = NativeCopySocketVersion(peer->copy);
    wanted = NativeCopyPipelineEvents(peer->copy,
        GetFlushRecPtr(NULL) > peer->sender_queued_lsn ||
        (peer->sender_active && !NativeCopyOutstanding(peer->copy)),sender_window);
    if (wanted & POLLOUT)
        *events |= WL_SOCKET_WRITEABLE;
    return NativeCopySocket(peer->copy);
}

static bool
send_copy_group(NativeQuorumView *view, XLogRecPtr required, bool maintenance)
{
    bool posted[MAX_SAFEKEEPERS] = {false};
    bool done[MAX_SAFEKEEPERS] = {false};
    NativeQuorumPeer *nodes[MAX_SAFEKEEPERS];
    int lengths[MAX_SAFEKEEPERS];
    TimeLineID tli;
    XLogRecPtr available = GetFlushRecPtr(&tli);
    uint64 started = now_us();
    view->repair_mask = 0;
    for (int i = 0; i < view->count; i++)
    {
        nodes[i] = peer_for(view->ids[i]);
        lengths[i] = nodes[i] ? prepare_frame(nodes[i],view,i,view->written[i],available,tli,maintenance) : 0;
        if (!lengths[i]) done[i] = true;
    }
    do
    {
        struct pollfd sockets[MAX_SAFEKEEPERS];
        int count = 0;
        for (int i = 0; i < view->count; i++)
        {
            NativeQuorumPeer *peer = nodes[i];
            bool current_epoch = false;
            int result;
            bool was_posted = posted[i];
            if (done[i]) continue;
            result = NativeCopyStep(peer->copy,peer->body,lengths[i],view->generation,view->term,
                &posted[i],peer->reply,&current_epoch);
            if (!was_posted && posted[i])
                pg_atomic_fetch_add_u64(&shared->copy_submissions,1);
            if (result < 0)
                done[i] = true;
            else if (result == 1)
            {
                /* An earlier group can leave a minority reply pending. Keep
                 * its connection and consume its proof only in the same epoch. */
                if (current_epoch)
                {
                    peer->reply_len = NQ_REPLY_BYTES;
                    (void) accept_progress(view,peer);
                }
                if (posted[i]) done[i] = true;
            }
            if (!done[i])
            {
                int fd = NativeCopySocket(peer->copy);
                if (fd >= 0)
                {
                    sockets[count].fd = fd;
                    sockets[count].events = NativeCopyEvents(peer->copy);
                    sockets[count].revents = 0;
                    count++;
                }
            }
        }
        view->quorum = Max(view->quorum,quorum_prefix(view));
        if (view->poisoned || ProcDiePending || QueryCancelPending)
            break;
        if (required && view->quorum >= required)
            return true;
        if (!count || now_us() - started >= 250000)
            break;
        if (poll(sockets,count,1) < 0 && errno != EINTR)
            break;
    } while (now_us() - started < 250000);
    return false;
}

/* One group owns all request buffers until handles have been removed. The
 * server retains accepted mutations when we abandon a slow minority request. */
static bool
send_group(NativeQuorumView *view, XLogRecPtr required, bool maintenance)
{
    TimeLineID tli;
    XLogRecPtr available = GetFlushRecPtr(&tli);
    int running = 0;
    bool result = false;
    if (copy_transport)
        return send_copy_group(view,required,maintenance);
    view->repair_mask = 0;
    for (int i = 0; i < view->count; i++)
    {
        NativeQuorumPeer *peer = peer_for(view->ids[i]);
        int length;
        if (!peer)
            continue;
        length = prepare_frame(peer,view,i,view->written[i],available,tli,maintenance);
        if (!length)
            continue;
        curl_easy_setopt(peer->handle, CURLOPT_POSTFIELDS, peer->body);
        curl_easy_setopt(peer->handle, CURLOPT_POSTFIELDSIZE, (long) length);
        if (curl_multi_add_handle(multi,peer->handle) == CURLM_OK)
            peer->added = true;
    }
    do
    {
        CURLMsg *message;
        int remaining;
        if (curl_multi_perform(multi, &running) != CURLM_OK)
            break;
        while ((message = curl_multi_info_read(multi, &remaining)) != NULL)
        {
            NativeQuorumPeer *peer = NULL;
            long code = 0;
            curl_easy_getinfo(message->easy_handle, CURLINFO_PRIVATE, &peer);
            curl_easy_getinfo(message->easy_handle, CURLINFO_RESPONSE_CODE, &code);
            if (!peer || message->msg != CURLMSG_DONE || message->data.result != CURLE_OK ||
                (code != 200 && code != 409) || peer->reply_len != NQ_REPLY_BYTES || peer->reply[0] != 1)
                continue;
            if ((code == 200 && peer->reply[1] > 1) || (code == 409 && peer->reply[1] != 2))
            {
                if (peer->reply[1] >= 3)
                    (void) accept_progress(view,peer);
                if (view->poisoned) goto finished;
                continue;
            }
            (void) accept_progress(view,peer);
            if (view->poisoned) goto finished;
        }
        view->quorum = Max(view->quorum, quorum_prefix(view));
        if (!maintenance && required && view->quorum >= required)
        {
            result = true;
            break;
        }
        if (ProcDiePending || QueryCancelPending || !running)
            break;
        /* Bounded socket wait, never a deliberate batch-fill delay. */
        if (curl_multi_poll(multi,NULL,0,10,NULL) != CURLM_OK)
            break;
    } while (running);
finished:
    for (int i = 0; i < peer_count; i++)
        if (peers[i].added)
        {
            curl_multi_remove_handle(multi,peers[i].handle);
            peers[i].added = false;
        }
    return result;
}

/* Wait without acquiring a successor's ownership. A lock found free with an
 * active reservation means the earlier backend abandoned it; invalidate that
 * scheduling hint while holding the actual lock. Reservations are not proofs. */
static void
wait_group(int index)
{
    if (LWLockAcquireOrWait(&group_locks[index].lock,LW_EXCLUSIVE))
    {
        SpinLockAcquire(&shared->mutex);
        shared->groups[index].active = false;
        SpinLockRelease(&shared->mutex);
        LWLockRelease(&group_locks[index].lock);
    }
}

/* Returns a held slot, -1 for ordinary sync-rep fallback, or -2 for an already
 * proven prefix. Never holds the metadata spinlock across LWLock acquisition,
 * local I/O or network operations. The same WAL bytes may be submitted by two
 * groups; native append verifies and trims their overlap atomically. */
static int
acquire_group(XLogRecPtr required, bool background, NativeQuorumView *view)
{
    for (;;)
    {
        NativeQuorumGroup pending[NQ_GROUP_SLOTS];
        int covering = -1;
        int oldest = 0;
        bool reservation_raced = false;
        XLogRecPtr available = GetFlushRecPtr(NULL);
        if (ProcDiePending || QueryCancelPending)
            return -1;
        SpinLockAcquire(&shared->mutex);
        *view = shared->view;
        for (int i = 0; i < inflight_limit; i++)
            if (shared->groups[i].active && shared->groups[i].forming &&
                shared->groups[i].version == view->version)
                shared->groups[i].target = Max(shared->groups[i].target,available);
        memcpy(pending,shared->groups,sizeof(pending));
        SpinLockRelease(&shared->mutex);
        if (!usable(view))
            return -1;
        if (!background && view->quorum >= required)
            return -2;
        for (int i = 0; i < inflight_limit; i++)
        {
            if (!pending[i].active || pending[i].version != view->version)
                continue;
            if (pending[i].target < pending[oldest].target)
                oldest = i;
            if (pending[i].target >= (background ? available : required))
                covering = i;
        }
        if (covering >= 0)
        {
            if (background)
                return -1;
            wait_group(covering);
            continue;
        }
        for (int i = background ? NQ_MAX_GROUPS : 0;
             i < (background ? NQ_GROUP_SLOTS : inflight_limit); i++)
        {
            bool changed = false;
            bool covered = false;
            int count = 0;
            if (!LWLockConditionalAcquire(&group_locks[i].lock,LW_EXCLUSIVE))
                continue;
            SpinLockAcquire(&shared->mutex);
            changed = shared->view.version != view->version || !shared->view.active || shared->view.poisoned;
            for (int j = 0; j < inflight_limit; j++)
                if (j != i && shared->groups[j].active && shared->groups[j].version == view->version &&
                    shared->groups[j].target >= (background ? available : required))
                    covered = true;
            if (!changed && !covered)
            {
                *view = shared->view;
                shared->groups[i].version = view->version;
                shared->groups[i].target = available;
                shared->groups[i].active = true;
                shared->groups[i].forming = true;
                for (int j = 0; j < inflight_limit; j++)
                    if (shared->groups[j].active && shared->groups[j].version == view->version)
                        count++;
                shared->inflight_highwater = Max(shared->inflight_highwater,count);
            }
            SpinLockRelease(&shared->mutex);
            if (!changed && !covered)
                return i;
            LWLockRelease(&group_locks[i].lock);
            if (changed)
                return -1;
            reservation_raced = true;
            break; /* Another leader reserved the prefix; recheck its slot. */
        }
        if (reservation_raced)
            continue;
        if (background)
            return -1;
        snapshot(view);
        if (!usable(view))
            return -1;
        if (view->quorum >= required)
            return -2;
        wait_group(oldest);
    }
}

static bool
flush_group(XLogRecPtr required, bool background)
{
    NativeQuorumView view;
    bool proved = false;
    uint64 started;
    int slot;
    if (!shared || !transport_init())
        return false;
    slot = acquire_group(required,background,&view);
    if (slot < 0)
        return slot == -2;
    snapshot(&view);
    if (!usable(&view))
        goto unlocked;
    /* Only source groups form a cohort; background repair never waits to fill
     * a batch. Match PostgreSQL's active-XID heuristic for avoiding a delay in
     * an otherwise idle database. Followers can extend the reservation while
     * it is forming, but no reservation advances a durable prefix. */
    if (!background && group_delay_us && MinimumActiveBackends(5))
    {
        pg_atomic_fetch_add_u64(&shared->cohort_delays,1);
        pg_usleep(group_delay_us);
    }
    {
        XLogRecPtr available = GetFlushRecPtr(NULL);
        SpinLockAcquire(&shared->mutex);
        if (shared->groups[slot].version == view.version)
        {
            shared->groups[slot].forming = false;
            shared->groups[slot].target = available;
        }
        SpinLockRelease(&shared->mutex);
    }
    started = now_us();
    /* Limit each ownership turn, even if a large backlog needs more turns. */
    for (int round = 0; round < (background ? 1 : 16); round++)
    {
        bool maintenance = false;
        if (!background && view.quorum >= required)
        {
            proved = true;
            break;
        }
        proved = send_group(&view, required, maintenance);
        SpinLockAcquire(&shared->mutex);
        if (view.version != shared->view.version || !shared->view.active)
        {
            SpinLockRelease(&shared->mutex);
            proved = false;
            break;
        }
        for (int i = 0; i < view.count; i++)
        {
            /* A gap response can move a scheduling cursor backward after a
             * peer restart. A stale gap only causes a verified duplicate, so
             * favor repair over an indefinitely stuck optimistic cursor. */
            if (view.repair_mask & (UINT32_C(1) << i))
                shared->view.written[i] = Min(shared->view.written[i],view.written[i]);
            else
                shared->view.written[i] = Max(shared->view.written[i],view.written[i]);
            shared->view.flushed[i] = Max(shared->view.flushed[i],view.flushed[i]);
        }
        shared->view.quorum = Max(shared->view.quorum,quorum_prefix(&shared->view));
        shared->view.poisoned |= view.poisoned;
        (void) publish_proof_locked();
        view = shared->view;
        SpinLockRelease(&shared->mutex);
        proved = !background && view.quorum >= required;
        if (proved || view.poisoned || ProcDiePending || QueryCancelPending)
            break;
        if (now_us() - started >= 250000)
            break;
    }
    if (!background && view.proposer_procno >= 0 && view.proposer_procno < ProcGlobal->allProcCount)
    {
        uint64 now = now_us();
        uint64 previous = pg_atomic_read_u64(&shared->last_notify_us);
        /* Frontend ACKs use the quorum proof directly. Coalesce control-plane
         * notifications; its periodic pump still drains the final idle tail. */
        if (now >= previous && now - previous >= 1000 &&
            pg_atomic_compare_exchange_u64(&shared->last_notify_us,&previous,now))
            SetLatch(&ProcGlobal->allProcs[view.proposer_procno].procLatch);
    }
unlocked:
    SpinLockAcquire(&shared->mutex);
    shared->groups[slot].active = false;
    SpinLockRelease(&shared->mutex);
    LWLockRelease(&group_locks[slot].lock);
    return proved && !view.poisoned;
}

static bool
wait_shared_prefix(XLogRecPtr required)
{
#ifdef __linux__
    struct timespec timeout = {.tv_sec = 0, .tv_nsec = 10000000};
    pg_atomic_uint32 *completion = &shared->completion_sequence[
        (required >> NQ_COMPLETION_SHIFT) % NQ_COMPLETION_BUCKETS];
    for (;;)
    {
        uint32 sequence = pg_atomic_read_u32(completion);
        XLogRecPtr prefix;
        int result, saved_errno;
        pg_read_barrier();
        prefix = NativeQuorumDurablePrefix();
        if (prefix >= required)
            return true;
        if (!pg_atomic_read_u64(&shared->proof_version) || ProcDiePending || QueryCancelPending)
            return false;
        /* Preserve the ordinary configuration-release boundary. The final
         * durability guard still rejects an unreplicated acknowledgement. */
        if (WalSndCtl && ((((volatile WalSndCtlData *) WalSndCtl)->sync_standbys_status) &
            (SYNC_STANDBY_INIT | SYNC_STANDBY_DEFINED)) == SYNC_STANDBY_INIT)
            return false;
        pgstat_report_wait_start(WAIT_EVENT_SYNC_REP);
        result = syscall(SYS_futex,&completion->value,FUTEX_WAIT,sequence,&timeout,NULL,0);
        saved_errno = errno;
        pgstat_report_wait_end();
        if (!PostmasterIsAlive())
            ereport(FATAL,(errmsg("postmaster exited during native quorum wait")));
        if (result < 0 && saved_errno != EAGAIN && saved_errno != EINTR && saved_errno != ETIMEDOUT)
            return false; /* Ordinary guarded synchronous replication fallback. */
    }
#else
    return false;
#endif
}

static bool
commit_provider(XLogRecPtr lsn, bool commit)
{
    if (previous_provider && previous_provider(lsn,commit))
        return true;
    if (!enabled || !SyncRepRequested() || RecoveryInProgress() ||
        !SyncRepStandbyNames || strcmp(SyncRepStandbyNames,"walproposer") != 0 ||
        (commit && synchronous_commit == SYNCHRONOUS_COMMIT_REMOTE_APPLY))
        return false;
    if (sender_owned)
    {
        if (shared_completion && shared && wait_shared_prefix(lsn))
        {
            pg_atomic_fetch_add_u64(&shared->provider_commits,1);
            return true;
        }
        return false;
    }
    if (flush_group(lsn,false))
    {
        pg_atomic_fetch_add_u64(&shared->provider_commits,1);
        return true;
    }
    return false;
}

void
NativeQuorumInit(void)
{
    DefineCustomBoolVariable("neon.experimental_native_quorum",
        "Use the experimental native quorum commit-group provider.",
        "Not qualified for production; retains local WAL fsync.", &enabled, false,
        PGC_POSTMASTER, 0, NULL,NULL,NULL);
    DefineCustomStringVariable("neon.native_quorum_endpoints",
        "Internal node_id=postgresql://host:port or HTTPS append endpoints, comma separated.",
        "Node ids must match elected membership; only literal loopback permits HTTP.",
        &endpoints,"",PGC_POSTMASTER,GUC_SUPERUSER_ONLY,NULL,NULL,NULL);
    DefineCustomIntVariable("neon.native_quorum_inflight_groups",
        "Maximum experimental native WAL groups in flight.",
        "A reservation is never a durability acknowledgement.", &inflight_limit,1,1,NQ_MAX_GROUPS,
        PGC_POSTMASTER,0,NULL,NULL,NULL);
    DefineCustomIntVariable("neon.native_quorum_group_delay_us",
        "Requested source group formation delay with concurrent active writers.",
        "Experimental; does not alter the durable quorum requirement.", &group_delay_us,0,0,1000,
        PGC_POSTMASTER,0,NULL,NULL,NULL);
    DefineCustomBoolVariable("neon.native_quorum_sender_owned",
        "Use one elected, continuously pipelined native COPY WAL sender.",
        "Experimental; uses the ordered synchronous queue and requires COPY transport.",
        &sender_owned,false,PGC_POSTMASTER,0,NULL,NULL,NULL);
    DefineCustomBoolVariable("neon.native_quorum_shared_completion",
        "Use a process-shared prefix notification for native sender completion.",
        "Experimental Linux cohort wake; other platforms retain the ordinary ordered queue.",
        &shared_completion,false,PGC_POSTMASTER,0,NULL,NULL,NULL);
    DefineCustomIntVariable("neon.native_quorum_sender_spin_us",
        "Bounded sender-only polling while WAL still needs a durable quorum.",
        "Experimental CPU/latency tradeoff; idle and caught-up senders do not spin.",
        &sender_spin_us,0,0,100,PGC_POSTMASTER,0,NULL,NULL,NULL);
    DefineCustomIntVariable("neon.native_quorum_stream_window",
        "Maximum outstanding append frames per native sender connection.",
        "Experimental bounded stream credits; queued bytes do not satisfy quorum.",
        &sender_window,8,1,8,PGC_POSTMASTER,0,NULL,NULL,NULL);
    previous_provider = SyncRepCommitProvider_hook;
    SyncRepCommitProvider_hook = commit_provider;
}

void
NativeQuorumShmemRequest(void)
{
    RequestAddinShmemSpace(MAXALIGN(sizeof(NativeQuorumShared)));
    RequestNamedLWLockTranche("neon native quorum group",NQ_GROUP_SLOTS);
}

void
NativeQuorumShmemInit(void)
{
    bool found;
    shared = ShmemInitStruct("Neon native quorum group",sizeof(*shared),&found);
    group_locks = GetNamedLWLockTranche("neon native quorum group");
    if (!found)
    {
        memset(shared,0,sizeof(*shared));
        SpinLockInit(&shared->mutex);
        shared->view.proposer_procno = -1;
        pg_atomic_init_u64(&shared->provider_commits,0);
        pg_atomic_init_u64(&shared->copy_submissions,0);
        pg_atomic_init_u64(&shared->cohort_delays,0);
        pg_atomic_init_u64(&shared->last_notify_us,0);
        pg_atomic_init_u64(&shared->control_reconnects,0);
        pg_atomic_init_u64(&shared->pipelined_submissions,0);
        pg_atomic_init_u64(&shared->proof_version,0);
        pg_atomic_init_u64(&shared->proof_prefix,0);
        for (int i = 0; i < NQ_COMPLETION_BUCKETS; i++)
            pg_atomic_init_u32(&shared->completion_sequence[i],0);
    }
}

void
NativeQuorumReset(void)
{
    if (!shared)
        return;
    SpinLockAcquire(&shared->mutex);
    shared->view.active = false;
    shared->view.poisoned = false;
    shared->view.quorum = 0;
    shared->view.version++;
    memset(shared->groups,0,sizeof(shared->groups));
    (void) publish_proof_locked();
    SpinLockRelease(&shared->mutex);
    notify_completion();
    pending_since_us = last_control_us = 0;
    for (int i = 0; i < peer_count; i++)
        if (peers[i].copy)
        {
            NativeCopyReset(peers[i].copy);
            peers[i].sender_active = false;
            peers[i].sender_queued_lsn = 0;
        }
}

XLogRecPtr
NativeQuorumDurablePrefix(void)
{
    uint64 version, checked;
    XLogRecPtr prefix;
    if (!enabled || !shared)
        return InvalidXLogRecPtr;
    /* A completed durable proof does not expire when a database becomes idle.
     * A new election/reset invalidates its version and active bit explicitly. */
    version = pg_atomic_read_u64(&shared->proof_version);
    pg_read_barrier();
    prefix = pg_atomic_read_u64(&shared->proof_prefix);
    pg_read_barrier();
    checked = pg_atomic_read_u64(&shared->proof_version);
    return version && version == checked ? prefix : InvalidXLogRecPtr;
}

uint64
NativeQuorumProviderCommits(void)
{
    return shared ? pg_atomic_read_u64(&shared->provider_commits) : 0;
}

uint64
NativeQuorumCopySubmissions(void)
{
    return shared ? pg_atomic_read_u64(&shared->copy_submissions) : 0;
}

uint64
NativeQuorumCohortDelays(void)
{
    return shared ? pg_atomic_read_u64(&shared->cohort_delays) : 0;
}

void
NativeQuorumControlReconnected(void)
{
    if (shared) pg_atomic_fetch_add_u64(&shared->control_reconnects,1);
}

uint64
NativeQuorumControlReconnects(void)
{
    return shared ? pg_atomic_read_u64(&shared->control_reconnects) : 0;
}

uint64
NativeQuorumPipelinedSubmissions(void)
{
    return shared ? pg_atomic_read_u64(&shared->pipelined_submissions) : 0;
}

uint32
NativeQuorumInflightHighwater(void)
{
    uint32 result;
    if (!shared)
        return 0;
    SpinLockAcquire(&shared->mutex);
    result = shared->inflight_highwater;
    SpinLockRelease(&shared->mutex);
    return result;
}

bool
NativeQuorumControlOnly(Safekeeper *sk)
{
    NativeQuorumView view;
    if (!enabled || !shared || sk->wp->config->syncSafekeepers)
        return false;
    snapshot(&view);
    /* Poison/staleness blocks acknowledgements, never silently transfers data
     * ownership back to the old writer. Only a new election can reset it. */
    return view.active;
}

bool
NativeQuorumPump(WalProposer *wp)
{
    NativeQuorumView view;
    bool active;
    if (!enabled || !shared || wp->config->syncSafekeepers || wp->state != WPS_ELECTED ||
        !transport_init() || peer_count != wp->n_safekeepers)
        return false;
    if (sender_owned && !copy_transport)
        elog(FATAL,"native quorum sender ownership requires COPY endpoints");
    snapshot(&view);
    active = view.active;
    if (active && (view.term != wp->propTerm || view.generation != wp->mconf.generation))
    {
        NativeQuorumReset();
        elog(FATAL,"native quorum membership changed; restarting proposer for controlled handover");
    }
    if (!active)
    {
        memset(&view,0,sizeof(view));
        view.count = wp->n_safekeepers;
        view.term = wp->propTerm;
        view.generation = wp->mconf.generation;
        view.epoch_start = wp->propTermStartLsn;
        view.quorum = wp->commitLsn;
#if PG_VERSION_NUM >= 170000
        view.proposer_procno = MyProcNumber;
#else
        view.proposer_procno = MyProc->pgprocno;
#endif
        for (int i = 0; i < view.count; i++)
        {
            Safekeeper *sk = &wp->safekeeper[i];
            if (sk->state != SS_ACTIVE || sk->active_state != SS_ACTIVE_SEND ||
                sk->streamingAt != wp->availableLsn || sk->appendResponse.flushLsn < wp->availableLsn ||
                sk->appendResponse.term != view.term || sk->appendResponse.generation != view.generation ||
                !peer_for(sk->greetResponse.nodeId))
                return false;
            view.ids[i] = sk->greetResponse.nodeId;
            for (int j = 0; j < i; j++)
                if (view.ids[j] == view.ids[i])
                    return false;
            view.written[i] = view.flushed[i] = sk->appendResponse.flushLsn;
        }
        if (copy_transport)
        {
            bool ready = true;
            uint64 now = now_us();
            for (int i = 0; i < view.count; i++)
            {
                NativeQuorumPeer *peer = peer_for(view.ids[i]);
                int result;
                if (now < peer->sender_retry_us)
                {
                    ready = false;
                    continue;
                }
                if (!peer->sender_started_us)
                    peer->sender_started_us = now;
                else if (now - peer->sender_started_us >= 1000000)
                {
                    NativeCopyReset(peer->copy);
                    peer->sender_started_us = now;
                }
                result = NativeCopyConnectStep(peer->copy);
                if (result != 1)
                {
                    ready = false;
                    if (result < 0)
                    {
                        peer->sender_retry_us = now + 50000;
                        peer->sender_started_us = 0;
                    }
                }
                else
                    peer->sender_started_us = 0;
            }
            /* Keep the elected legacy data writer until authenticated COPY
             * negotiation succeeds. Failure before handoff is not a reason
             * to strand ordinary durable commits on an unusable replacement. */
            if (!ready)
                return false;
        }
        if (view.generation == INVALID_GENERATION && wp->safekeepers_generation == INVALID_GENERATION)
        {
            view.old_count = view.count;
            view.old_mask = view.count == 32 ? UINT32_MAX : (UINT32_C(1) << view.count) - 1;
        }
        else
        {
            view.old_count = wp->mconf.members.len;
            view.new_count = wp->mconf.new_members.len;
            if (!view.old_count || view.old_count > MAX_SAFEKEEPERS || view.new_count > MAX_SAFEKEEPERS)
                return false;
            for (int i = 0; i < view.count; i++)
            {
                for (int j = 0; j < wp->mconf.members.len; j++)
                    if (view.ids[i] == wp->mconf.members.m[j].node_id)
                        view.old_mask |= UINT32_C(1) << i;
                for (int j = 0; j < wp->mconf.new_members.len; j++)
                    if (view.ids[i] == wp->mconf.new_members.m[j].node_id)
                        view.new_mask |= UINT32_C(1) << i;
            }
        }
        view.quorum = quorum_prefix(&view);
        if (view.quorum < view.epoch_start)
            return false;
        view.active = true;
        SpinLockAcquire(&shared->mutex);
        view.version = shared->view.version + 1;
        shared->view = view;
        (void) publish_proof_locked();
        SpinLockRelease(&shared->mutex);
        notify_completion();
        elog(LOG,"experimental native quorum append ownership activated");
    }
    SpinLockAcquire(&shared->mutex);
    shared->view.refreshed_us = now_us();
    SpinLockRelease(&shared->mutex);
    snapshot(&view);
    if (sender_owned)
    {
        uint64 spin_started = now_us();
        do
        {
            XLogRecPtr available;
            if (view.poisoned || ProcDiePending || QueryCancelPending)
                break;
            sender_step(&view);
            snapshot(&view);
            if (!usable(&view))
                break;
            WalProposerPublishNativeQuorum(wp,view.quorum);
            available = GetFlushRecPtr(NULL);
            if (!sender_spin_us || view.quorum >= available || now_us() - spin_started >= sender_spin_us)
                break;
        } while (true);
    }
    else
    {
    XLogRecPtr available = GetFlushRecPtr(NULL);
    bool need_data = view.quorum < available;
    for (int i = 0; i < view.count; i++)
        if (view.flushed[i] < available)
            need_data = true;
    if (need_data)
    {
        uint64 now = now_us();
        if (!pending_since_us)
            pending_since_us = now;
        /* Foreground groups lead without a fill delay. Only the background
         * owner gives them a short head start before draining asynchronous or
         * otherwise idle tails; it never waits on their group lock. */
        if (now - pending_since_us >= 1000)
            (void) flush_group(InvalidXLogRecPtr,true);
    }
    else
        pending_since_us = 0;
    }
    snapshot(&view);
    if (!view.poisoned && ((view.quorum > wp->commitLsn && now_us() - last_control_us >= 1000) ||
                          now_us() - last_control_us >= 100000))
    {
        wp->commitLsn = Max(wp->commitLsn,view.quorum);
        last_control_us = now_us();
        /* The quorum proof is already complete. This makes it visible to
         * pageservers and the ordinary feedback path without a second HTTP
         * round trip in every frontend commit group. */
        WalProposerBroadcast(wp,wp->availableLsn,wp->availableLsn);
    }
    return true;
}
