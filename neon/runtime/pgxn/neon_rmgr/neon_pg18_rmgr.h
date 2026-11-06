#ifndef NEON_RMGR_H
#define NEON_RMGR_H
#if PG_MAJORVERSION_NUM >= 16
#include "access/xlog_internal.h"
#include "replication/decode.h"
#include "replication/logical.h"

extern void neon_pg18_desc(StringInfo buf, XLogReaderState *record);
extern void neon_pg18_decode(LogicalDecodingContext *ctx, XLogRecordBuffer *buf);
extern const char *neon_pg18_identify(uint8 info);

#endif
#endif //NEON_RMGR_H

