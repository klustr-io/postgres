/* Persistent, authenticated COPY BOTH transport. No quorum policy lives here. */
#include "postgres.h"
#include <poll.h>
#include "libpq-fe.h"
#include "storage/fd.h"
#include "native_quorum_copy.h"

struct NativeCopyConnection
{
    char *host, *port, *options;
    const char *token;
    PGconn *connection;
    int state; /* 0 disconnected, 1 connecting, 2 command, 3 COPY BOTH */
    PostgresPollingStatusType connecting;
    bool reserved_fd, write_pending;
    unsigned inflight;
    uint32 request_generation;
    uint64 request_term;
    uint64 socket_version;
};

static void
close_connection(NativeCopyConnection *peer)
{
    if (peer->connection)
        PQfinish(peer->connection);
    peer->connection = NULL;
    peer->socket_version++;
    peer->state = 0;
    peer->inflight = 0;
    peer->write_pending = false;
    if (peer->reserved_fd)
        ReleaseExternalFD();
    peer->reserved_fd = false;
}

NativeCopyConnection *
NativeCopyCreate(const char *url, const char *tenant, const char *timeline, const char *token)
{
    PQconninfoOption *options;
    NativeCopyConnection *peer;
    char *error = NULL;
    const char *host = NULL, *port = NULL;
    bool valid = true;
    if (strncmp(url,"postgresql://",13) != 0 || strpbrk(url,"@?#\r\n\t "))
        return NULL;
    options = PQconninfoParse(url,&error);
    if (error)
        PQfreemem(error);
    if (!options)
        return NULL;
    for (PQconninfoOption *option = options; option->keyword; option++)
    {
        if (strcmp(option->keyword,"host") == 0) host = option->val;
        if (strcmp(option->keyword,"port") == 0) port = option->val;
        if ((strcmp(option->keyword,"user") == 0 || strcmp(option->keyword,"password") == 0 ||
             strcmp(option->keyword,"dbname") == 0) && option->val && *option->val)
            valid = false;
    }
    if (!valid || !host || !*host || strchr(host,'/') || strchr(host,',') || *host == '@' || !port || !*port)
    {
        PQconninfoFree(options);
        return NULL;
    }
    peer = calloc(1,sizeof(*peer));
    if (!peer)
    {
        PQconninfoFree(options);
        return NULL;
    }
    peer->host = strdup(host);
    peer->port = strdup(port);
    peer->options = malloc(strlen(tenant) + strlen(timeline) + 40);
    peer->token = token;
    PQconninfoFree(options);
    if (!peer->host || !peer->port || !peer->options)
    {
        free(peer->host); free(peer->port); free(peer->options); free(peer);
        return NULL;
    }
    snprintf(peer->options,strlen(tenant) + strlen(timeline) + 40,
        "-c tenant_id=%s timeline_id=%s",tenant,timeline);
    return peer;
}

static int
copy_step(NativeCopyConnection *peer, const void *frame, int length,
    uint32 generation, uint64 term, bool *posted, unsigned char reply[46], bool *current_epoch,
    unsigned window)
{
    /* Idle owners still consume EOF, but need not reconnect until data exists. */
    if (!peer->connection && length == 0)
        return 0;
    if (!peer->connection)
    {
        const char *keywords[] = {"host","port","user","dbname","password","options",
            "application_name","sslmode","gssencmode","connect_timeout",NULL};
        const char *values[] = {peer->host,peer->port,"native_wal","replication",peer->token,peer->options,
            "neon_native_quorum",strcmp(peer->host,"127.0.0.1") == 0 ? "disable" : "verify-full",
            "disable","1",NULL};
        if (!AcquireExternalFD())
            return -1;
        peer->reserved_fd = true;
        peer->connection = PQconnectStartParams(keywords,values,0);
        peer->socket_version++;
        if (!peer->connection)
            goto failed;
        peer->state = 1;
        peer->connecting = PGRES_POLLING_WRITING;
    }
    if (peer->state == 1)
    {
        peer->connecting = PQconnectPoll(peer->connection);
        /* libpq can replace a socket while trying resolved addresses. Even
         * reuse of the same fd number must rebuild its epoll registration. */
        peer->socket_version++;
        if (peer->connecting == PGRES_POLLING_FAILED)
            goto failed;
        if (peer->connecting != PGRES_POLLING_OK)
            return 0;
        if (PQsetnonblocking(peer->connection,1) != 0 ||
            PQsendQuery(peer->connection,"START_WAL_APPEND") != 1)
            goto failed;
        peer->state = 2;
    }
    if (peer->state == 2)
    {
        if (PQconsumeInput(peer->connection) != 1)
            goto failed;
        if (!PQisBusy(peer->connection))
        {
            PGresult *result = PQgetResult(peer->connection);
            bool copy = result && PQresultStatus(result) == PGRES_COPY_BOTH;
            if (result) PQclear(result);
            if (!copy)
                goto failed;
            peer->state = 3;
        }
    }
    if (peer->state == 3)
    {
        if (peer->inflight)
        {
            char *data = NULL;
            int count = PQgetCopyData(peer->connection,&data,1);
            if (count == 0)
            {
                if (PQconsumeInput(peer->connection) != 1)
                    goto failed;
                count = PQgetCopyData(peer->connection,&data,1);
            }
            if (count > 0)
            {
                if (count != 46)
                {
                    PQfreemem(data);
                    goto failed;
                }
                memcpy(reply,data,46);
                PQfreemem(data);
                *current_epoch = generation == peer->request_generation && term == peer->request_term;
                peer->inflight--;
                return 1;
            }
            if (count < 0)
                goto failed;
        }
        else if (length == 0 && PQconsumeInput(peer->connection) != 1)
            goto failed;
        if (peer->inflight < window && !*posted && length > 0 &&
            (!peer->inflight || (generation == peer->request_generation && term == peer->request_term)))
        {
            int sent = PQputCopyData(peer->connection,frame,length);
            if (sent < 0)
                goto failed;
            if (sent == 1)
            {
                *posted = true;
                peer->inflight++;
                peer->request_generation = generation;
                peer->request_term = term;
            }
        }
    }
    {
        int pending = PQflush(peer->connection);
        if (pending < 0)
            goto failed;
        peer->write_pending = pending != 0;
    }
    return 0;
failed:
    close_connection(peer);
    return -1;
}

int
NativeCopyStep(NativeCopyConnection *peer, const void *frame, int length,
    uint32 generation, uint64 term, bool *posted, unsigned char reply[46], bool *current_epoch)
{
    return copy_step(peer,frame,length,generation,term,posted,reply,current_epoch,1);
}

int
NativeCopyPipelineStep(NativeCopyConnection *peer, const void *frame, int length,
    uint32 generation, uint64 term, bool *posted, unsigned char reply[46], bool *current_epoch,
    unsigned window)
{
    Assert(window >= 1 && window <= 8);
    return copy_step(peer,frame,length,generation,term,posted,reply,current_epoch,window);
}

int
NativeCopyConnectStep(NativeCopyConnection *peer)
{
    bool posted = false, current_epoch = false;
    unsigned char reply[46];
    int result;
    if (peer->inflight)
        return -1; /* Preflight must not consume an existing data request. */
    /* Internal connect-only sentinel: no COPY payload is queued. */
    result = copy_step(peer,NULL,peer->state == 3 ? 0 : -1,0,0,&posted,reply,&current_epoch,1);
    if (result < 0 || peer->state != 3)
        return result < 0 ? -1 : 0;
    {
        char *data = NULL;
        int count = PQgetCopyData(peer->connection,&data,1);
        if (data) PQfreemem(data);
        if (count != 0)
        {
            close_connection(peer);
            return -1; /* Ended COPY or unsolicited data is not readiness. */
        }
    }
    return 1;
}

int
NativeCopySocket(NativeCopyConnection *peer)
{
    return peer->connection ? PQsocket(peer->connection) : -1;
}

short
NativeCopyEvents(NativeCopyConnection *peer)
{
    if (peer->state == 1)
        return peer->connecting == PGRES_POLLING_READING ? POLLIN : POLLOUT;
    if (peer->state == 3 && !peer->inflight)
        return POLLOUT;
    return POLLIN | (peer->write_pending ? POLLOUT : 0);
}

short
NativeCopyPipelineEvents(NativeCopyConnection *peer, bool have_data, unsigned window)
{
    if (peer->state == 1)
        return peer->connecting == PGRES_POLLING_READING ? POLLIN : POLLOUT;
    return POLLIN | ((peer->write_pending ||
        (peer->state == 3 && have_data && peer->inflight < window)) ? POLLOUT : 0);
}

unsigned
NativeCopyOutstanding(NativeCopyConnection *peer)
{
    return peer->inflight;
}

void
NativeCopyReset(NativeCopyConnection *peer)
{
    close_connection(peer);
}

uint64
NativeCopySocketVersion(NativeCopyConnection *peer)
{
    return peer->socket_version;
}
