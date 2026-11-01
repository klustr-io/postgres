/* Exercise the exact state invariants behind the two native-library findings. */
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include "gzguts.h"
#include <libxml/tree.h>
#include <libxml/valid.h>

int main(void) {
	int descriptors[2];
	static unsigned char bytes[1048576];
	unsigned random_state = 0x12345678;
	for (size_t i = 0; i < sizeof(bytes); i++) {
		random_state ^= random_state << 13;
		random_state ^= random_state >> 17;
		random_state ^= random_state << 5;
		bytes[i] = (unsigned char)random_state;
	}
	assert(pipe(descriptors) == 0);
	assert(fcntl(descriptors[1], F_SETFL, O_NONBLOCK) == 0);
	while (write(descriptors[1], bytes, sizeof(bytes)) > 0) {}
	assert(errno == EAGAIN || errno == EWOULDBLOCK);
	gzFile gzip = gzdopen(descriptors[1], "w");
	assert(gzip && gzbuffer(gzip, 32) == 0);
	(void)gzwrite(gzip, bytes, sizeof(bytes));
	gz_statep state = (gz_statep)gzip;
	assert(state->again);
	/* A stalled direct write must never retain the caller's buffer. */
	assert(state->strm.avail_in == 0 && state->strm.next_in == state->in);
	(void)gzprintf(gzip, "%s", "safe-after-stall");
	(void)gzclose(gzip);
	close(descriptors[0]);
	puts("PASS CVE-2026-85091: nonblocking gzwrite state reset and subsequent gzprintf");

	xmlDocPtr document = xmlNewDoc(BAD_CAST "1.0");
	xmlNodePtr node = xmlNewNode(NULL, BAD_CAST "root");
	xmlDocSetRootElement(document, node);
	xmlAttrPtr attribute = xmlNewProp(node, BAD_CAST "id", BAD_CAST "identity");
	assert(xmlAddID(NULL, document, BAD_CAST "identity", attribute));
	assert(xmlGetID(document, BAD_CAST "identity") == attribute);
	/* libxslt can overwrite atype while the ID table still owns the entry. */
	attribute->atype = XML_ATTRIBUTE_CDATA;
	assert(xmlRemoveProp(attribute) == 0);
	assert(xmlGetID(document, BAD_CAST "identity") == NULL);
	xmlFreeDoc(document);
	xmlCleanupParser();
	puts("PASS CVE-2025-7425: ID-table cleanup survives attribute type corruption");
	return 0;
}
