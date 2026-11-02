/* Native PG18 validator. The controller owns JWT validation and resource/role
 * authorization. Endpoint-bound mTLS protects that decision. Failure is closed;
 * bearer tokens and response bodies must never enter PostgreSQL logs. */
#include "postgres.h"
#include "fmgr.h"
#include "miscadmin.h"
#include "catalog/pg_authid.h"
#include "catalog/pg_auth_members.h"
#include "libpq/oauth.h"
#include "utils/acl.h"
#include "utils/builtins.h"
#include "utils/catcache.h"
#include "utils/guc.h"
#include "utils/json.h"
#include "utils/jsonb.h"
#include "utils/syscache.h"
#include <curl/curl.h>

PG_MODULE_MAGIC;
void _PG_init(void);
static char *validator_url, *ca_file, *cert_file, *key_file;

void
_PG_init(void)
{
    DefineCustomStringVariable("klustr_oauth.validator_url", "Endpoint-bound HTTPS authorization URL", NULL,
                               &validator_url, "", PGC_SIGHUP, 0, NULL, NULL, NULL);
    DefineCustomStringVariable("klustr_oauth.ca_file", "Validator CA bundle", NULL,
                               &ca_file, "", PGC_SIGHUP, 0, NULL, NULL, NULL);
    DefineCustomStringVariable("klustr_oauth.cert_file", "Endpoint client certificate", NULL,
                               &cert_file, "", PGC_SIGHUP, 0, NULL, NULL, NULL);
    DefineCustomStringVariable("klustr_oauth.key_file", "Endpoint client private key", NULL,
                               &key_file, "", PGC_SIGHUP, 0, NULL, NULL, NULL);
    MarkGUCPrefixReserved("klustr_oauth");
}

/* Check every membership, including SET-only grants. Do not permit native OAuth
 * to become an administrative login even if a fleet role binding is mistaken. */
static bool
restricted_role(const char *role)
{
    Oid roleid = get_role_oid(role, true);
    List *members;
    ListCell *cell;
    bool safe = OidIsValid(roleid);
    if (!safe) return false;
    members = list_make1_oid(roleid);
    foreach(cell, members)
    {
        Oid id = lfirst_oid(cell);
        HeapTuple tuple = SearchSysCache1(AUTHOID, ObjectIdGetDatum(id));
        Form_pg_authid auth;
        CatCList *grants;
        int i;
        if (!HeapTupleIsValid(tuple)) {safe = false; break;}
        auth = (Form_pg_authid) GETSTRUCT(tuple);
        safe = !(auth->rolsuper || auth->rolcreatedb || auth->rolcreaterole || auth->rolreplication || auth->rolbypassrls ||
                 (id == roleid && !auth->rolcanlogin) ||
                 strcmp(NameStr(auth->rolname), "neon_superuser") == 0 ||
                 strcmp(NameStr(auth->rolname), "pg_read_server_files") == 0 ||
                 strcmp(NameStr(auth->rolname), "pg_write_server_files") == 0 ||
                 strcmp(NameStr(auth->rolname), "pg_execute_server_program") == 0);
        ReleaseSysCache(tuple);
        if (!safe) break;
        grants = SearchSysCacheList1(AUTHMEMMEMROLE, ObjectIdGetDatum(id));
        for (i = 0; i < grants->n_members; i++)
        {
            Form_pg_auth_members grant = (Form_pg_auth_members) GETSTRUCT(&grants->members[i]->tuple);
            if (!list_member_oid(members, grant->roleid)) members = lappend_oid(members, grant->roleid);
        }
        ReleaseSysCacheList(grants);
        CHECK_FOR_INTERRUPTS();
        if (list_length(members) > 4096) {safe = false; break;}
    }
    list_free(members);
    return safe;
}

typedef struct ResponseBuffer { char data[16385]; size_t used; } ResponseBuffer;
static size_t
receive_body(char *data, size_t size, size_t count, void *argument)
{
    ResponseBuffer *buffer = argument;
    size_t bytes;
    if (size != 0 && count > (16384 - buffer->used) / size) return 0;
    bytes = size * count;
    memcpy(buffer->data + buffer->used, data, bytes);
    buffer->used += bytes;
    return bytes;
}

static JsonbValue *
field(Jsonb *body, const char *name)
{
    JsonbValue key;
    key.type = jbvString; key.val.string.val = (char *) name; key.val.string.len = strlen(name);
    return findJsonbValueFromContainer(&body->root, JB_FOBJECT, &key);
}

static bool
decode_result(char *response, ValidatorModuleResult *result)
{
    volatile bool valid = false;
    MemoryContext saved = CurrentMemoryContext;
    PG_TRY();
    {
        Jsonb *body = DatumGetJsonbP(DirectFunctionCall1(jsonb_in, CStringGetDatum(response)));
        JsonbValue *authorized = field(body, "authorized"), *identity = field(body, "authn_id");
        if (authorized && authorized->type == jbvBool && authorized->val.boolean &&
            identity && identity->type == jbvString && identity->val.string.len > 0 && identity->val.string.len <= 2048)
        {
            result->authn_id = pnstrdup(identity->val.string.val, identity->val.string.len);
            result->authorized = true;
            valid = true;
        }
    }
    PG_CATCH();
    {
        /* Never report a parser exception containing provider response data. */
        MemoryContextSwitchTo(saved);
        FlushErrorState();
    }
    PG_END_TRY();
    return valid;
}

static bool
validate(const ValidatorModuleState *state, const char *token, const char *role, ValidatorModuleResult *result)
{
    CURL *easy;
    CURLM *multi;
    struct curl_slist *headers;
    ResponseBuffer response = {{0}, 0};
    StringInfoData body;
    volatile bool success = false;
    (void) state;
    result->authorized = false;
    result->authn_id = NULL;
    if (!token || strlen(token) > 12288 || !restricted_role(role)) return true;
    if (!validator_url || strncmp(validator_url, "https://", 8) != 0 ||
        !ca_file || !*ca_file || !cert_file || !*cert_file || !key_file || !*key_file) return false;
    initStringInfo(&body);
    appendStringInfoString(&body, "{\"token\":"); escape_json(&body, token);
    appendStringInfoString(&body, ",\"role\":"); escape_json(&body, role);
    appendStringInfoString(&body, ",\"database\":"); escape_json(&body, MyProcPort->database_name);
    appendStringInfoString(&body, ",\"issuer\":"); escape_json(&body, MyProcPort->hba->oauth_issuer);
    appendStringInfoString(&body, ",\"scope\":"); escape_json(&body, MyProcPort->hba->oauth_scope);
    appendStringInfoChar(&body, '}');
    easy = curl_easy_init(); multi = curl_multi_init();
    headers = curl_slist_append(NULL, "Content-Type: application/json");
    if (!easy || !multi || !headers) {
        if (easy) curl_easy_cleanup(easy);
        if (multi) curl_multi_cleanup(multi);
        curl_slist_free_all(headers); explicit_bzero(body.data, body.len); pfree(body.data);
        return false;
    }
    PG_TRY();
    {
        bool configured =
            curl_easy_setopt(easy, CURLOPT_URL, validator_url) == CURLE_OK &&
            curl_easy_setopt(easy, CURLOPT_PROTOCOLS_STR, "https") == CURLE_OK &&
            curl_easy_setopt(easy, CURLOPT_FOLLOWLOCATION, 0L) == CURLE_OK &&
            curl_easy_setopt(easy, CURLOPT_PROXY, "") == CURLE_OK &&
            curl_easy_setopt(easy, CURLOPT_SSL_VERIFYPEER, 1L) == CURLE_OK &&
            curl_easy_setopt(easy, CURLOPT_SSL_VERIFYHOST, 2L) == CURLE_OK &&
            curl_easy_setopt(easy, CURLOPT_CAINFO, ca_file) == CURLE_OK &&
            curl_easy_setopt(easy, CURLOPT_SSLCERT, cert_file) == CURLE_OK &&
            curl_easy_setopt(easy, CURLOPT_SSLKEY, key_file) == CURLE_OK &&
            curl_easy_setopt(easy, CURLOPT_NOSIGNAL, 1L) == CURLE_OK &&
            curl_easy_setopt(easy, CURLOPT_CONNECTTIMEOUT_MS, 2000L) == CURLE_OK &&
            curl_easy_setopt(easy, CURLOPT_TIMEOUT_MS, 5000L) == CURLE_OK &&
            curl_easy_setopt(easy, CURLOPT_HTTPHEADER, headers) == CURLE_OK &&
            curl_easy_setopt(easy, CURLOPT_POSTFIELDS, body.data) == CURLE_OK &&
            curl_easy_setopt(easy, CURLOPT_POSTFIELDSIZE, (long) body.len) == CURLE_OK &&
            curl_easy_setopt(easy, CURLOPT_WRITEFUNCTION, receive_body) == CURLE_OK &&
            curl_easy_setopt(easy, CURLOPT_WRITEDATA, &response) == CURLE_OK;
        if (configured && curl_multi_add_handle(multi, easy) == CURLM_OK)
        {
            int running = 1;
            CURLMcode code = CURLM_OK;
            while (running && code == CURLM_OK)
            {
                CHECK_FOR_INTERRUPTS(); /* Outside libcurl frames: safe PostgreSQL longjmp. */
                code = curl_multi_perform(multi, &running);
                if (running && code == CURLM_OK) code = curl_multi_poll(multi, NULL, 0, 100, NULL);
            }
            if (code == CURLM_OK)
            {
                int remaining;
                CURLMsg *message;
                while ((message = curl_multi_info_read(multi, &remaining)))
                {
                    long status = 0;
                    if (message->msg == CURLMSG_DONE && message->data.result == CURLE_OK &&
                        curl_easy_getinfo(easy, CURLINFO_RESPONSE_CODE, &status) == CURLE_OK && status == 200)
                    {
                        response.data[response.used] = '\0';
                        success = decode_result(response.data, result);
                    }
                }
            }
        }
    }
    PG_FINALLY();
    {
        curl_multi_remove_handle(multi, easy); curl_easy_cleanup(easy); curl_multi_cleanup(multi);
        curl_slist_free_all(headers); explicit_bzero(body.data, body.len); pfree(body.data);
    }
    PG_END_TRY();
    return success;
}

static void startup(ValidatorModuleState *state) {
    (void) state;
    if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) ereport(ERROR, (errmsg("OAuth validator initialization failed")));
}
static void shutdown_validator(ValidatorModuleState *state) {(void) state; curl_global_cleanup();}

const OAuthValidatorCallbacks *
_PG_oauth_validator_module_init(void)
{
    static const OAuthValidatorCallbacks callbacks = {PG_OAUTH_VALIDATOR_MAGIC, startup, shutdown_validator, validate};
    return &callbacks;
}
