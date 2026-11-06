/* PG18 public libpq token hook, including server scope discovery. Tokens are
 * read from the private fixture file, never passed in command-line arguments. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <libpq-fe.h>
static char token[12289];
static int hook(PGauthData type, PGconn *conn, void *data) {
	PGoauthBearerRequest *request = data;
	(void) conn;
	if (type != PQAUTHDATA_OAUTH_BEARER_TOKEN) return 0;
	if (!request->scope || strcmp(request->scope, "postgres:connect") != 0) return -1;
	request->token = token;
	return 1;
}
int main(void) {
	const char *names[] = {"oauth_issuer", "oauth_client_id", "require_auth", NULL};
	const char *values[] = {getenv("OAUTH_ISSUER"), "native-oauth-smoke", "oauth", NULL};
	FILE *file = fopen("/fixture/token", "r");
	PGconn *connection;
	PGresult *result;
	size_t size;
	if (!file) return 2;
	size = fread(token, 1, sizeof(token)-1, file); fclose(file); token[size] = '\0';
	PQsetAuthDataHook(hook);
	connection = PQconnectdbParams(names, values, 0);
	if (PQstatus(connection) != CONNECTION_OK) {
		fprintf(stderr, "%s", PQerrorMessage(connection)); PQfinish(connection); return 1;
	}
	result = PQexec(connection, "CREATE TEMP TABLE oauth_documents (data jsonb); INSERT INTO oauth_documents VALUES ('{\"name\":\"oauth\",\"count\":1}'); UPDATE oauth_documents SET data=jsonb_set(data,'{count}','2'); SELECT system_user, data->>'count' FROM oauth_documents");
	if (PQresultStatus(result) != PGRES_TUPLES_OK || PQntuples(result) != 1 ||
		strncmp(PQgetvalue(result,0,0), "oauth:", 6) != 0 || strcmp(PQgetvalue(result,0,1), "2") != 0) {
		fprintf(stderr, "Native OAuth SQL verification failed\n"); PQclear(result); PQfinish(connection); return 1;
	}
	puts("Native libpq OAUTHBEARER, system_user and ordinary JSONB SQL passed");
	PQclear(result); PQfinish(connection); return 0;
}
