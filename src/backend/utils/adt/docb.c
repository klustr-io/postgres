/*-------------------------------------------------------------------------
 * docb.c
 *    Native document deltas and selective JSON projections.
 *
 * Full values are canonical JSONB.  A stored delta is an immutable splice of
 * an exclusively owned old TOAST value.  Ordinary TOAST heap/index WAL persists
 * both the root and its replacement bytes.  No in-place mutation or new WAL
 * resource manager is involved.  A chain is owned by one logical column; copy
 * and flatten boundaries always materialize a self-contained full value.
 *-------------------------------------------------------------------------
 */
#include "postgres.h"

#include "access/detoast.h"
#include "access/heaptoast.h"
#include "access/toast_internals.h"
#include "access/transam.h"
#include "catalog/dependency.h"
#include "catalog/pg_namespace_d.h"
#include "catalog/pg_type.h"
#include "catalog/pg_type_d.h"
#include "commands/extension.h"
#include "fmgr.h"
#include "miscadmin.h"
#include "replication/slot.h"
#include "storage/lwlock.h"
#include "utils/array.h"
#include "utils/builtins.h"
#include "utils/docb.h"
#include "utils/fmgrprotos.h"
#include "utils/hsearch.h"
#include "utils/jsonb.h"
#include "utils/lsyscache.h"
#include "utils/rel.h"
#include "utils/syscache.h"

#define DOCB_DELTA_MAGIC 0x444F4305U	/* DOC, format version 5 */
#define DOCB_MAX_DEPTH 1
#define DOCB_HEAD_SIZE 512
#define DOCB_MAX_SPANS 64
#define DOCB_LITERAL PG_UINT32_MAX
#define DOCB_ANCHOR_SIZE 64

int docb_jsonb_storage = DOCB_STORAGE_DOCB;

static bool
docb_jsonb_relation_enabled(Relation rel)
{
	int			policy = rel->rd_options ?
		((StdRdOptions *) rel->rd_options)->jsonb_storage : DOCB_STORAGE_INHERIT;

	return (policy == DOCB_STORAGE_INHERIT ? docb_jsonb_storage : policy) == DOCB_STORAGE_DOCB;
}

/* No bootstrap catalog change: only the packaged, owned pg_catalog type opts in. */
bool
docb_is_type(Oid typeid)
{
	Oid			registered;
	Oid			extension;

	if (typeid < FirstNormalObjectId)
		return false;
	typeid = getBaseType(typeid);
	if (typeid < FirstNormalObjectId)
		return false;
	registered = GetSysCacheOid2(TYPENAMENSP, Anum_pg_type_oid,
								 CStringGetDatum("docb"), ObjectIdGetDatum(PG_CATALOG_NAMESPACE));
	if (typeid != registered)
		return false;
	extension = get_extension_oid("docb", true);
	return OidIsValid(extension) && getExtensionOfObject(TypeRelationId, typeid) == extension;
}

/*
 * A new logical slot's consistent point waits for pre-existing writers.  Heap
 * mutation has already assigned our XID before this check.  Once a database's
 * slot is allocated (including an inactive one), subsequent DOCB writes must
 * supply independent TOAST data to the standard logical decoder.  Thus merely
 * enabling wal_level=logical does not sacrifice the delta path, while creating
 * a CDC consumer safely selects full-value writes.  No slot horizon is weakened.
 */
static bool
docb_has_logical_slot(void)
{
	int			i;
	bool		found = false;

	LWLockAcquire(ReplicationSlotControlLock, LW_SHARED);
	for (i = 0; i < max_replication_slots; i++)
	{
		ReplicationSlot *slot = &ReplicationSlotCtl->replication_slots[i];

		if (slot->in_use && SlotIsLogical(slot) && slot->data.database == MyDatabaseId)
		{
			found = true;
			break;
		}
	}
	LWLockRelease(ReplicationSlotControlLock);
	return found;
}

typedef struct DocbDelta
{
	int32		vl_len_;
	uint32		tcinfo;
	uint32		magic;
	uint32		depth;
	uint32		oldlen;
	uint32		newlen;
	uint32		nspans;
	uint32		inserted;
	uint32		headlen;
	uint32		chainbytes;
	char		base[TOAST_POINTER_SIZE];
	uint16		reserved;
	char		data[FLEXIBLE_ARRAY_MEMBER];
} DocbDelta;

typedef struct DocbSpan
{
	uint32		position;
	uint32		length;
	uint32		oldoffset;		/* DOCB_LITERAL means bytes in this record */
	uint32		dataoffset;
} DocbSpan;

#define DOCB_DELTA_HDRSZ offsetof(DocbDelta, data)
#define DOCB_METADATA_MAX (DOCB_DELTA_HDRSZ + DOCB_MAX_SPANS * sizeof(DocbSpan) + DOCB_HEAD_SIZE)
#define DOCB_SPANS(delta) ((DocbSpan *) (delta)->data)
#define DOCB_HEAD(delta) ((delta)->data + (delta)->nspans * sizeof(DocbSpan))

/* Cache metadata within one expression only; never outlive its snapshot. */
typedef struct DocbReader
{
	struct varlena *value;
	DocbDelta  *delta;
	struct DocbReader *base;
	struct varlena *prefix;
} DocbReader;

static void
docb_reader_release(DocbReader *reader)
{
	if (reader->base)
	{
		docb_reader_release(reader->base);
		pfree(reader->base);
	}
	if (reader->delta)
		pfree(reader->delta);
	if (reader->prefix)
		pfree(reader->prefix);
}

static bool
docb_is_delta(struct varlena *value)
{
	struct varatt_external ext;

	if (VARATT_IS_EXTERNAL_ONDISK(value))
	{
		VARATT_EXTERNAL_GET_POINTER(ext, value);
		return VARATT_EXTERNAL_IS_COMPRESSED(ext) &&
			VARATT_EXTERNAL_GET_COMPRESS_METHOD(ext) == TOAST_DOCB_COMPRESSION_ID;
	}
	return VARATT_IS_COMPRESSED(value) &&
		TOAST_COMPRESS_METHOD(value) == TOAST_DOCB_COMPRESSION_ID;
}

/* Read policy never gates decoding values that are already stored as deltas. */
bool
docb_is_delta_value(Datum value)
{
	return docb_is_delta((struct varlena *) DatumGetPointer(value));
}

/* Read the encoded representation, without interpreting its compression ID. */
static struct varlena *
docb_encoded_slice(struct varlena *value, uint32 offset, uint32 length)
{
	struct varatt_external ext;
	char		pointer[TOAST_POINTER_SIZE];

	VARATT_EXTERNAL_GET_POINTER(ext, value);
	ext.va_rawsize = VARATT_EXTERNAL_GET_EXTSIZE(ext) + VARHDRSZ;
	ext.va_extinfo = VARATT_EXTERNAL_GET_EXTSIZE(ext);
	SET_VARTAG_EXTERNAL(pointer, VARTAG_ONDISK);
	memcpy(VARDATA_EXTERNAL(pointer), &ext, sizeof(ext));
	return detoast_attr_slice((struct varlena *) pointer, offset, length);
}

static void
docb_validate_delta(DocbDelta *delta, uint32 encoded_size)
{
	struct varatt_external base;
	uint32		covered = 0;
	uint32		literals = 0;
	uint32		i;

	if (encoded_size < DOCB_DELTA_HDRSZ ||
		delta->magic != DOCB_DELTA_MAGIC ||
		delta->depth == 0 || delta->depth > DOCB_MAX_DEPTH ||
		delta->oldlen < sizeof(uint32) || delta->newlen < sizeof(uint32) ||
		delta->nspans == 0 || delta->nspans > DOCB_MAX_SPANS ||
		delta->inserted > delta->newlen || delta->reserved != 0 ||
		delta->headlen != Min(delta->newlen, DOCB_HEAD_SIZE) ||
		delta->chainbytes < encoded_size ||
		delta->chainbytes > delta->newlen / 2 ||
		(uint64) DOCB_DELTA_HDRSZ + delta->nspans * sizeof(DocbSpan) + delta->headlen + delta->inserted != encoded_size ||
		TOAST_COMPRESS_EXTSIZE(delta) != delta->newlen ||
		!VARATT_IS_EXTERNAL_ONDISK(delta->base))
		ereport(ERROR, (errcode(ERRCODE_DATA_CORRUPTED),
						errmsg("invalid DOCB delta record")));
	VARATT_EXTERNAL_GET_POINTER(base, delta->base);
	if (base.va_rawsize != delta->oldlen + VARHDRSZ)
		ereport(ERROR, (errcode(ERRCODE_DATA_CORRUPTED),
						errmsg("DOCB delta base size mismatch")));
	for (i = 0; i < delta->nspans; i++)
	{
		DocbSpan   *span = &DOCB_SPANS(delta)[i];

		if (span->position != covered || span->length == 0 ||
			span->length > delta->newlen - covered)
			ereport(ERROR, (errcode(ERRCODE_DATA_CORRUPTED), errmsg("invalid DOCB span coverage")));
		if (span->oldoffset == DOCB_LITERAL)
		{
			if (span->dataoffset != literals || span->length > delta->inserted - literals)
				ereport(ERROR, (errcode(ERRCODE_DATA_CORRUPTED), errmsg("invalid DOCB literal span")));
			literals += span->length;
		}
		else if (span->oldoffset > delta->oldlen || span->length > delta->oldlen - span->oldoffset)
			ereport(ERROR, (errcode(ERRCODE_DATA_CORRUPTED), errmsg("invalid DOCB base span")));
		covered += span->length;
	}
	if (covered != delta->newlen || literals != delta->inserted)
		ereport(ERROR, (errcode(ERRCODE_DATA_CORRUPTED), errmsg("incomplete DOCB delta")));
}

static DocbDelta *
docb_delta_header(struct varlena *value)
{
	struct varlena *slice;
	DocbDelta  *delta;
	uint32		size;
	struct varatt_external ext;

	VARATT_EXTERNAL_GET_POINTER(ext, value);
	size = VARATT_EXTERNAL_GET_EXTSIZE(ext) + VARHDRSZ;
	if (size < DOCB_DELTA_HDRSZ)
		ereport(ERROR, (errcode(ERRCODE_DATA_CORRUPTED), errmsg("truncated DOCB delta")));
	slice = docb_encoded_slice(value, 0, Min(size, DOCB_METADATA_MAX) - VARHDRSZ);
	delta = palloc0(DOCB_METADATA_MAX);
	memcpy(VARDATA(delta), VARDATA(slice), VARSIZE(slice) - VARHDRSZ);
	SET_VARSIZE_COMPRESSED(delta, size);
	pfree(slice);
	docb_validate_delta(delta, size);
	{
		struct varatt_external base;

		VARATT_EXTERNAL_GET_POINTER(base, delta->base);
		if (base.va_toastrelid != ext.va_toastrelid || base.va_valueid == ext.va_valueid)
			ereport(ERROR, (errcode(ERRCODE_DATA_CORRUPTED), errmsg("invalid DOCB base identity")));
	}
	return delta;
}

/* Logical byte ranges exclude the normal four-byte varlena header. */
static void
docb_read(DocbReader *reader, uint32 offset, uint32 length,
		  char *output, unsigned level)
{
	struct varlena *value = reader->value;
	struct varlena *slice;
	DocbDelta  *delta;
	uint32		size;
	uint32		end;
	uint32		amount;
	uint32		position = offset;
	uint32		i;

	check_stack_depth();
	CHECK_FOR_INTERRUPTS();
	if (level > DOCB_MAX_DEPTH)
		ereport(ERROR, (errcode(ERRCODE_DATA_CORRUPTED), errmsg("DOCB delta chain exceeds limit")));
	size = toast_raw_datum_size(PointerGetDatum(value)) - VARHDRSZ;
	if (offset > size || length > size - offset)
		ereport(ERROR, (errcode(ERRCODE_DATA_CORRUPTED), errmsg("DOCB range exceeds value")));
	if (!length)
		return;
	if (!docb_is_delta(value))
	{
		if (!VARATT_IS_EXTENDED(value))
		{
			memcpy(output, VARDATA(value) + offset, length);
			return;
		}
		/* Metadata and short leaves usually live in the first TOAST chunk. */
		if (offset + length <= TOAST_MAX_CHUNK_SIZE)
		{
			if (!reader->prefix)
				reader->prefix = detoast_attr_slice(value, 0, Min(size, TOAST_MAX_CHUNK_SIZE));
			memcpy(output, VARDATA(reader->prefix) + offset, length);
			return;
		}
		slice = detoast_attr_slice(value, offset, length);
		if (VARSIZE_ANY_EXHDR(slice) != length)
			elog(ERROR, "short DOCB range read");
		memcpy(output, VARDATA_ANY(slice), length);
		pfree(slice);
		return;
	}
	if (VARATT_IS_EXTERNAL_ONDISK(value))
	{
		if (!reader->delta)
			reader->delta = docb_delta_header(value);
		delta = reader->delta;
	}
	else
	{
		delta = (DocbDelta *) value;
		docb_validate_delta(delta, VARSIZE(value));
	}
	if (!reader->base)
	{
		if (docb_is_delta((struct varlena *) delta->base))
			ereport(ERROR, (errcode(ERRCODE_DATA_CORRUPTED), errmsg("DOCB base must be a full value")));
		reader->base = palloc0(sizeof(DocbReader));
		reader->base->value = (struct varlena *) delta->base;
	}
	end = offset + length;

	/*
	 * A small current-value head prevents metadata/small projections from
	 * traversing old roots.  It is copied in the same WAL-protected record.
	 */
	if (position < delta->headlen)
	{
		amount = Min(end, delta->headlen) - position;
		memcpy(output, DOCB_HEAD(delta) + position, amount);
		output += amount;
		position += amount;
	}
	for (i = 0; i < delta->nspans && position < end; i++)
	{
		DocbSpan   *span = &DOCB_SPANS(delta)[i];
		uint32		relative;

		if (position >= span->position + span->length)
			continue;
		relative = position - span->position;
		amount = Min(end - position, span->length - relative);
		if (span->oldoffset != DOCB_LITERAL)
			docb_read(reader->base, span->oldoffset + relative, amount, output, level + 1);
		else if (VARATT_IS_EXTERNAL_ONDISK(value))
		{
			uint32		encodedoffset = DOCB_DELTA_HDRSZ + delta->nspans * sizeof(DocbSpan) +
				delta->headlen + span->dataoffset + relative;

			if (encodedoffset + amount <= Min(VARSIZE(delta), DOCB_METADATA_MAX))
				memcpy(output, ((char *) delta) + encodedoffset, amount);
			else
			{
				slice = docb_encoded_slice(value, encodedoffset - VARHDRSZ, amount);
				memcpy(output, VARDATA(slice), amount);
				pfree(slice);
			}
		}
		else
			memcpy(output, DOCB_HEAD(delta) + delta->headlen + span->dataoffset + relative, amount);
		output += amount;
		position += amount;
	}
}

struct varlena *
docb_decompress(struct varlena *value)
{
	uint32		size = toast_raw_datum_size(PointerGetDatum(value));
	struct varlena *result = palloc(size);
	DocbReader	reader = {0};

	reader.value = value;
	SET_VARSIZE(result, size);
	docb_read(&reader, 0, size - VARHDRSZ, VARDATA(result), 0);
	docb_reader_release(&reader);
	return result;
}

typedef struct DocbAnchor
{
	uint64		hash;
	uint32		offset;
} DocbAnchor;

static uint64
docb_anchor_hash(const char *data)
{
	uint64		hash = 0;
	unsigned	i;

	for (i = 0; i < DOCB_ANCHOR_SIZE; i++)
		hash = hash * 257 + (unsigned char) data[i] + 1;
	return hash;
}

static bool
docb_add_span(DocbSpan *spans, uint32 *count, uint32 position,
			  uint32 length, uint32 oldoffset)
{
	DocbSpan   *last;

	if (!length)
		return true;
	if (*count)
	{
		last = &spans[*count - 1];
		if ((oldoffset == DOCB_LITERAL && last->oldoffset == DOCB_LITERAL) ||
			(oldoffset != DOCB_LITERAL && last->oldoffset != DOCB_LITERAL &&
			 last->oldoffset + last->length == oldoffset))
		{
			last->length += length;
			return true;
		}
	}
	if (*count == DOCB_MAX_SPANS)
		return false;
	last = &spans[(*count)++];
	last->position = position;
	last->length = length;
	last->oldoffset = oldoffset;
	last->dataoffset = 0;
	return true;
}

/*
 * Only used when prefix/suffix cannot describe a cheap update.  Index fixed
 * old-value anchors, then roll a hash across the new bytes to discover shifted
 * unchanged runs.  Every hash match is verified byte-for-byte.  This is bounded
 * workspace, not a semantic JSON-path patch interpreter; arbitrary metadata and
 * length changes are safe because reconstruction is of canonical bytes.
 */
static bool
docb_find_spans(const char *olddata, uint32 oldlen, const char *newdata,
				uint32 newlen, DocbSpan *spans, uint32 *count)
{
	HASHCTL		control = {0};
	HTAB	   *anchors;
	uint32		position;
	uint32		pending = 0;
	uint64		hash;
	uint64		power = 1;
	unsigned	i;
	bool		success = true;

	/*
	 * Bound auxiliary memory/CPU; larger documents retain a correct full
	 * fallback.
	 */
	if (Max(oldlen, newlen) > 16 * 1024 * 1024)
		return false;
	control.keysize = sizeof(uint64);
	control.entrysize = sizeof(DocbAnchor);
	control.hcxt = CurrentMemoryContext;
	anchors = hash_create("DOCB unchanged anchors", oldlen / DOCB_ANCHOR_SIZE,
						  &control, HASH_ELEM | HASH_BLOBS | HASH_CONTEXT);
	for (position = 0; position + DOCB_ANCHOR_SIZE <= oldlen; position += DOCB_ANCHOR_SIZE)
	{
		bool		found;
		DocbAnchor *anchor;

		hash = docb_anchor_hash(olddata + position);
		anchor = hash_search(anchors, &hash, HASH_ENTER, &found);
		if (!found)
			anchor->offset = position;
	}
	for (i = 1; i < DOCB_ANCHOR_SIZE; i++)
		power *= 257;
	position = 0;
	*count = 0;
	hash = docb_anchor_hash(newdata);
	while (position + DOCB_ANCHOR_SIZE <= newlen)
	{
		DocbAnchor *anchor = hash_search(anchors, &hash, HASH_FIND, NULL);

		if (anchor && memcmp(olddata + anchor->offset, newdata + position, DOCB_ANCHOR_SIZE) == 0)
		{
			uint32		length = DOCB_ANCHOR_SIZE;
			uint32		maximum = Min(oldlen - anchor->offset, newlen - position);

			while (maximum - length >= 64 &&
				   memcmp(olddata + anchor->offset + length, newdata + position + length, 64) == 0)
				length += 64;
			while (length < maximum && olddata[anchor->offset + length] == newdata[position + length])
				length++;
			if (!docb_add_span(spans, count, pending, position - pending, DOCB_LITERAL) ||
				!docb_add_span(spans, count, position, length, anchor->offset))
			{
				success = false;
				break;
			}
			position += length;
			pending = position;
			if (position + DOCB_ANCHOR_SIZE <= newlen)
				hash = docb_anchor_hash(newdata + position);
		}
		else
		{
			if (position + DOCB_ANCHOR_SIZE < newlen)
				hash = (hash - ((unsigned char) newdata[position] + 1) * power) * 257 +
					(unsigned char) newdata[position + DOCB_ANCHOR_SIZE] + 1;
			position++;
		}
		CHECK_FOR_INTERRUPTS();
	}
	if (success)
		success = docb_add_span(spans, count, pending, newlen - pending, DOCB_LITERAL);
	hash_destroy(anchors);
	return success;
}

static DocbDelta *
docb_make_delta(struct varlena *oldflat, struct varlena *flat, struct varlena *base,
				uint32 depth, uint32 chainbytes, uint32 prefix, uint32 suffix)
{
	DocbSpan	spans[DOCB_MAX_SPANS];
	uint32		count = 0;
	uint32		newlen = VARSIZE(flat) - VARHDRSZ;
	uint32		oldlen = VARSIZE(oldflat) - VARHDRSZ;
	uint32		literals = newlen - prefix - suffix;
	uint32		headlen = Min(newlen, DOCB_HEAD_SIZE);
	uint32		encoded;
	uint32		i;
	DocbDelta  *delta;

	docb_add_span(spans, &count, 0, prefix, 0);
	docb_add_span(spans, &count, prefix, literals, DOCB_LITERAL);
	docb_add_span(spans, &count, newlen - suffix, suffix, oldlen - suffix);
	encoded = DOCB_DELTA_HDRSZ + count * sizeof(DocbSpan) + headlen + literals;
	if (encoded >= newlen / 4)
	{
		if (!docb_find_spans(VARDATA(oldflat), oldlen, VARDATA(flat), newlen, spans, &count))
			return NULL;
		literals = 0;
		for (i = 0; i < count; i++)
			if (spans[i].oldoffset == DOCB_LITERAL)
				literals += spans[i].length;
		encoded = DOCB_DELTA_HDRSZ + count * sizeof(DocbSpan) + headlen + literals;
	}
	if (encoded >= newlen / 4 || (uint64) chainbytes + encoded > newlen / 2)
		return NULL;
	delta = palloc0(encoded);
	SET_VARSIZE_COMPRESSED(delta, encoded);
	TOAST_COMPRESS_SET_SIZE_AND_COMPRESS_METHOD(delta, newlen, TOAST_DOCB_COMPRESSION_ID);
	delta->magic = DOCB_DELTA_MAGIC;
	delta->depth = depth + 1;
	delta->oldlen = oldlen;
	delta->newlen = newlen;
	delta->nspans = count;
	delta->inserted = literals;
	delta->headlen = headlen;
	delta->chainbytes = chainbytes + encoded;
	memcpy(delta->base, base, TOAST_POINTER_SIZE);
	memcpy(DOCB_HEAD(delta), VARDATA(flat), headlen);
	literals = 0;
	for (i = 0; i < count; i++)
	{
		if (spans[i].oldoffset == DOCB_LITERAL)
		{
			spans[i].dataoffset = literals;
			memcpy(DOCB_HEAD(delta) + headlen + literals,
				   VARDATA(flat) + spans[i].position, spans[i].length);
			literals += spans[i].length;
		}
		DOCB_SPANS(delta)[i] = spans[i];
	}
	return delta;
}

/*
 * Keep a compressible base in one ordinary TOAST chunk.  This bounds the bytes
 * fetched even for a late projection, without introducing a second format.
 * Larger compressed streams would require reading unrelated chunks for a slice,
 * so retain seekable uncompressed bases there.  Honor the column's compression
 * choice and EXTERNAL's request to avoid compression.
 */
static Datum
docb_save_full(Relation rel, struct varlena *flat, Form_pg_attribute att,
			   int options)
{
	struct varlena *packed = NULL;
	struct varlena *value = flat;
	Datum		stored;

	if (att->attstorage == TYPSTORAGE_EXTENDED ||
		att->attstorage == TYPSTORAGE_MAIN)
	{
		Datum		compressed;

		compressed = toast_compress_datum(PointerGetDatum(flat), att->attcompression);
		packed = (struct varlena *) DatumGetPointer(compressed);
		if (packed && VARSIZE(packed) - VARHDRSZ <= TOAST_MAX_CHUNK_SIZE &&
			(uint64) VARSIZE(packed) * 4 <= VARSIZE(flat))
			value = packed;
	}
	stored = toast_save_datum(rel, PointerGetDatum(value), NULL, options);
	if (packed)
		pfree(packed);
	return stored;
}

/*
 * Only the full base owned by this same row/column may become a dependency. Values
 * arriving from another row have already been flattened by toast_tuple_init.
 * Consolidate changes against that base: old delta metadata can be retired
 * without deleting the base.  Logical decoding requires self-contained new
 * TOAST chunks, so a database with a logical slot deliberately uses full values.
 */
void
docb_toast_prepare(ToastTupleContext *ttc, int options)
{
	int			i;

	for (i = 0; i < ttc->ttc_rel->rd_att->natts; i++)
	{
		Form_pg_attribute att = TupleDescAttr(ttc->ttc_rel->rd_att, i);
		ToastAttrInfo *info = &ttc->ttc_attr[i];
		struct varlena *newvalue;
		struct varlena *oldvalue = NULL;
		struct varlena *oldflat = NULL;
		struct varlena *flat;
		Datum		stored;
		uint32		newlen;
		uint32		oldlen;
		uint32		prefix = 0;
		uint32		suffix = 0;
		bool		share = false;

		if (att->attisdropped || att->attlen != -1 ||
			(info->tai_colflags & TOASTCOL_IGNORE) || ttc->ttc_isnull[i] ||
			!(docb_is_type(att->atttypid) ||
			  (docb_jsonb_relation_enabled(ttc->ttc_rel) &&
			   getBaseType(att->atttypid) == JSONBOID)))
			continue;
		newvalue = (struct varlena *) DatumGetPointer(ttc->ttc_values[i]);
		flat = detoast_attr(newvalue);
		newlen = VARSIZE(flat) - VARHDRSZ;
		/* Small independent values retain normal inline tuple handling. */
		if (newlen < TOAST_TUPLE_THRESHOLD)
		{
			if (flat != newvalue)
			{
				if (info->tai_colflags & TOASTCOL_NEEDS_FREE)
					pfree(newvalue);
				ttc->ttc_values[i] = PointerGetDatum(flat);
				info->tai_size = VARSIZE(flat);
				info->tai_colflags |= TOASTCOL_NEEDS_FREE;
				ttc->ttc_flags |= TOAST_NEEDS_CHANGE | TOAST_NEEDS_FREE;
			}
			continue;
		}
		if (ttc->ttc_oldvalues && !ttc->ttc_oldisnull[i] &&
			(info->tai_colflags & TOASTCOL_NEEDS_DELETE_OLD) &&
			(!RelationIsLogicallyLogged(ttc->ttc_rel) || !docb_has_logical_slot()) &&
			!OidIsValid(ttc->ttc_rel->rd_toastoid))
		{
			struct varatt_external ext;
			struct varlena *basevalue;
			DocbDelta  *prior = NULL;

			oldvalue = (struct varlena *) DatumGetPointer(ttc->ttc_oldvalues[i]);
			VARATT_EXTERNAL_GET_POINTER(ext, oldvalue);
			if (ext.va_toastrelid != ttc->ttc_rel->rd_rel->reltoastrelid)
				elog(ERROR, "DOCB dependency belongs to another TOAST relation");
			if (docb_is_delta(oldvalue))
			{
				prior = docb_delta_header(oldvalue);
				basevalue = (struct varlena *) prior->base;
				if (docb_is_delta(basevalue))
					ereport(ERROR, (errcode(ERRCODE_DATA_CORRUPTED), errmsg("DOCB base must be a full value")));
			}
			else
				basevalue = oldvalue;
			{
				oldflat = detoast_attr(basevalue);
				oldlen = VARSIZE(oldflat) - VARHDRSZ;
				/* Compare unchanged runs in blocks, then locate the boundary. */
				while (Min(oldlen, newlen) - prefix >= 64 &&
					   memcmp(VARDATA(oldflat) + prefix, VARDATA(flat) + prefix, 64) == 0)
					prefix += 64;
				while (prefix < Min(oldlen, newlen) &&
					   VARDATA(oldflat)[prefix] == VARDATA(flat)[prefix])
					prefix++;
				while (Min(oldlen, newlen) - prefix - suffix >= 64 &&
					   memcmp(VARDATA(oldflat) + oldlen - suffix - 64,
							  VARDATA(flat) + newlen - suffix - 64, 64) == 0)
					suffix += 64;
				while (suffix < Min(oldlen, newlen) - prefix &&
					   VARDATA(oldflat)[oldlen - 1 - suffix] == VARDATA(flat)[newlen - 1 - suffix])
					suffix++;
				if (prefix == oldlen && oldlen == newlen)
				{
					char	   *same = palloc(TOAST_POINTER_SIZE);

					memcpy(same, basevalue, TOAST_POINTER_SIZE);
					stored = PointerGetDatum(same);
					share = true;
				}
				else
				{
					DocbDelta  *delta = docb_make_delta(oldflat, flat, basevalue,
														0, 0, prefix, suffix);

					if (delta)
					{
						bool		unchanged = false;

						if (prior)
						{
							struct varatt_external oldext;

							VARATT_EXTERNAL_GET_POINTER(oldext, oldvalue);
							if (VARATT_EXTERNAL_GET_EXTSIZE(oldext) == VARSIZE(delta) - VARHDRSZ)
							{
								if (VARSIZE(delta) <= DOCB_METADATA_MAX)
									unchanged = memcmp(VARDATA(prior), VARDATA(delta), VARSIZE(delta) - VARHDRSZ) == 0;
								else
								{
									struct varlena *encoded = docb_encoded_slice(oldvalue, 0, VARSIZE(delta) - VARHDRSZ);

									unchanged = memcmp(VARDATA(encoded), VARDATA(delta), VARSIZE(delta) - VARHDRSZ) == 0;
									pfree(encoded);
								}
							}
						}
						if (unchanged)
						{
							char	   *same = palloc(TOAST_POINTER_SIZE);

							memcpy(same, oldvalue, TOAST_POINTER_SIZE);
							stored = PointerGetDatum(same);
						}
						else
							stored = toast_save_datum(ttc->ttc_rel, PointerGetDatum(delta), NULL, options);
						pfree(delta);
						share = true;
					}
				}
				pfree(oldflat);
			}
			if (prior)
			{
				/*
				 * The surviving root owns the same full base; retire only old
				 * metadata.
				 */
				if (share && memcmp(DatumGetPointer(stored), oldvalue, TOAST_POINTER_SIZE) != 0)
					toast_delete_datum_only(ttc->ttc_rel, PointerGetDatum(oldvalue), false);
				pfree(prior);
			}
		}
		if (!share)
			stored = docb_save_full(ttc->ttc_rel, flat, att, options);
		if (flat != newvalue)
			pfree(flat);
		if (info->tai_colflags & TOASTCOL_NEEDS_FREE)
			pfree(newvalue);
		ttc->ttc_values[i] = stored;
		info->tai_size = TOAST_POINTER_SIZE;
		info->tai_colflags |= TOASTCOL_IGNORE | TOASTCOL_NEEDS_FREE;
		if (share)
			info->tai_colflags &= ~TOASTCOL_NEEDS_DELETE_OLD;
		ttc->ttc_flags |= TOAST_NEEDS_CHANGE | TOAST_NEEDS_FREE;
	}
}

void
docb_delete_dependencies(Relation rel, Datum value, bool speculative)
{
	struct varlena *root = (struct varlena *) DatumGetPointer(value);
	DocbDelta  *delta;
	struct varatt_external base;
	struct varatt_external current;

	check_stack_depth();
	if (!docb_is_delta(root))
		return;
	delta = docb_delta_header(root);
	VARATT_EXTERNAL_GET_POINTER(base, delta->base);
	VARATT_EXTERNAL_GET_POINTER(current, root);
	if (base.va_toastrelid != current.va_toastrelid ||
		base.va_valueid == current.va_valueid)
		ereport(ERROR, (errcode(ERRCODE_DATA_CORRUPTED), errmsg("invalid DOCB dependency identity")));
	if (docb_is_delta((struct varlena *) delta->base))
	{
		ereport(ERROR, (errcode(ERRCODE_DATA_CORRUPTED), errmsg("DOCB base must be a full value")));
	}
	toast_delete_datum(rel, PointerGetDatum(delta->base), speculative);
	pfree(delta);
}

/* Metadata reads below do not fetch unrelated document payloads. */
static uint32
docb_u32(DocbReader *reader, uint32 offset)
{
	uint32		result;

	docb_read(reader, offset, sizeof(result), (char *) &result, 0);
	return result;
}

static void
docb_entry(DocbReader *reader, uint32 container, uint32 index,
		   JEntry *entry, uint32 *offset, uint32 *length)
{
	uint32		start = index > JB_OFFSET_STRIDE ? index - JB_OFFSET_STRIDE : 0;
	JEntry		entries[JB_OFFSET_STRIDE + 1];
	int			j;

	docb_read(reader, container + sizeof(uint32) + start * sizeof(JEntry),
			  (index - start + 1) * sizeof(JEntry), (char *) entries, 0);
	*entry = entries[index - start];
	*offset = 0;
	for (j = (int) (index - start) - 1; j >= 0; j--)
	{
		*offset += JBE_OFFLENFLD(entries[j]);
		if (JBE_HAS_OFF(entries[j]))
			break;
	}
	*length = JBE_HAS_OFF(*entry) ? JBE_OFFLENFLD(*entry) - *offset : JBE_OFFLENFLD(*entry);
}

static Jsonb *
docb_project_value(DocbReader *reader, Datum *path, int *kinds, int count)
{
	struct varlena *value = reader->value;
	uint32		container = 0;
	uint32		position = 0;
	uint32		length = toast_raw_datum_size(PointerGetDatum(value)) - VARHDRSZ;
	JEntry		entry = JENTRY_ISCONTAINER;
	int			p;
	JsonbValue	result;
	char	   *data;

	if (count == 0)
		return (Jsonb *) PG_DETOAST_DATUM_COPY(PointerGetDatum(value));
	for (p = 0; p < count; p++)
	{
		uint32		header;
		uint32		n;
		uint32		index;
		uint32		offset;
		uint32		payload;
		text	   *key = DatumGetTextPP(path[p]);

		if (!JBE_ISCONTAINER(entry))
			return NULL;
		header = docb_u32(reader, container);
		n = header & JB_CMASK;
		if (header & JB_FSCALAR)
			return NULL;
		if (kinds && ((kinds[p] == 1 && !(header & JB_FOBJECT)) ||
					  (kinds[p] == 2 && !(header & JB_FARRAY))))
			return NULL;
		payload = container + sizeof(uint32) + n * sizeof(JEntry) * ((header & JB_FOBJECT) ? 2 : 1);
		if (header & JB_FOBJECT)
		{
			uint32		low = 0;
			uint32		high = n;
			bool		found = false;

			while (low < high)
			{
				uint32		middle = low + (high - low) / 2;
				uint32		keylen;
				int			difference;
				JEntry		keyentry;
				char	   *storedkey;

				docb_entry(reader, container, middle, &keyentry, &offset, &keylen);
				difference = (keylen > VARSIZE_ANY_EXHDR(key)) - (keylen < VARSIZE_ANY_EXHDR(key));
				if (!difference)
				{
					storedkey = palloc(Max(keylen, 1));
					docb_read(reader, payload + offset, keylen, storedkey, 0);
					difference = memcmp(storedkey, VARDATA_ANY(key), keylen);
					pfree(storedkey);
				}
				if (!difference)
				{
					index = n + middle;
					found = true;
					break;
				}
				if (difference < 0)
					low = middle + 1;
				else
					high = middle;
			}
			if (!found)
				return NULL;
		}
		else if (header & JB_FARRAY)
		{
			int			subscript;
			char	   *string = text_to_cstring(key);
			char	   *end;
			long		parsed;

			errno = 0;
			parsed = strtol(string, &end, 10);
			if (errno || end == string || *end || parsed < PG_INT32_MIN || parsed > PG_INT32_MAX)
			{
				pfree(string);
				return NULL;
			}
			pfree(string);
			subscript = (int) parsed;
			if (subscript < 0)
			{
				if (subscript < -(int) n)
					return NULL;
				subscript += n;
			}
			if ((uint32) subscript >= n)
				return NULL;
			index = subscript;
		}
		else
			elog(ERROR, "invalid DOCB container");
		docb_entry(reader, container, index, &entry, &offset, &length);
		if (JBE_ISCONTAINER(entry) || JBE_ISNUMERIC(entry))
		{
			length -= INTALIGN(offset) - offset;
			offset = INTALIGN(offset);
		}
		position = payload + offset;
		container = position;
	}
	data = palloc(Max(length, 1));
	docb_read(reader, position, length, data, 0);
	if (JBE_ISSTRING(entry))
	{
		result.type = jbvString;
		result.val.string.val = data;
		result.val.string.len = length;
	}
	else if (JBE_ISNUMERIC(entry))
	{
		result.type = jbvNumeric;
		result.val.numeric = (Numeric) data;
	}
	else if (JBE_ISCONTAINER(entry))
	{
		result.type = jbvBinary;
		result.val.binary.data = (JsonbContainer *) data;
		result.val.binary.len = length;
	}
	else if (JBE_ISNULL(entry))
		result.type = jbvNull;
	else
	{
		result.type = jbvBool;
		result.val.boolean = JBE_ISBOOL_TRUE(entry);
	}
	return JsonbValueToJsonb(&result);
}

static Jsonb *
docb_project(struct varlena *value, Datum *path, int *kinds, int count)
{
	DocbReader	reader = {0};
	Jsonb	   *result;

	reader.value = value;
	result = docb_project_value(&reader, path, kinds, count);
	docb_reader_release(&reader);
	return result;
}

static Datum
docb_result(FunctionCallInfo fcinfo, Jsonb *result, bool as_text)
{
	JsonbValue	scalar;

	if (!result)
		PG_RETURN_NULL();
	if (!as_text)
		PG_RETURN_JSONB_P(result);
	if (JsonbExtractScalar(&result->root, &scalar))
	{
		if (scalar.type == jbvNull)
			PG_RETURN_NULL();
		if (scalar.type == jbvString)
			PG_RETURN_TEXT_P(cstring_to_text_with_len(scalar.val.string.val, scalar.val.string.len));
	}
	PG_RETURN_TEXT_P(cstring_to_text(JsonbToCString(NULL, &result->root, VARSIZE(result))));
}

static Datum
docb_projection(FunctionCallInfo fcinfo, bool as_text, bool path_array, bool integer_key)
{
	Datum	   *path;
	Datum		single;
	int			count;
	bool	   *nulls;
	Jsonb	   *result;
	int			kind = integer_key ? 2 : 1;
	int			i;

	if (path_array)
	{
		ArrayType  *array = PG_GETARG_ARRAYTYPE_P(1);

		deconstruct_array(array, TEXTOID, -1, false, TYPALIGN_INT, &path, &nulls, &count);
		for (i = 0; i < count; i++)
			if (nulls[i])
				PG_RETURN_NULL();
	}
	else
	{
		if (integer_key)
			single = CStringGetTextDatum(psprintf("%d", PG_GETARG_INT32(1)));
		else
			single = PG_GETARG_DATUM(1);
		path = &single;
		count = 1;
	}
	/* -> has typed object/array steps, unlike the general #> path operator. */
	result = docb_project((struct varlena *) PG_GETARG_POINTER(0), path,
						  path_array ? NULL : &kind, count);
	return docb_result(fcinfo, result, as_text);
}

/* Planner-fused ->/->> chains retain each step's object/array requirement. */
Datum
docb_project_chain(FunctionCallInfo fcinfo, bool as_text)
{
	Datum	   *path;
	Datum	   *flags;
	bool	   *nulls;
	bool	   *flagnulls;
	int			count;
	int			flagcount;
	int		   *kinds;
	int			i;
	Jsonb	   *result;

	deconstruct_array(PG_GETARG_ARRAYTYPE_P(1), TEXTOID, -1, false, TYPALIGN_INT,
					  &path, &nulls, &count);
	deconstruct_array(PG_GETARG_ARRAYTYPE_P(2), INT4OID, sizeof(int32), true, TYPALIGN_INT,
					  &flags, &flagnulls, &flagcount);
	if (count != flagcount)
		elog(ERROR, "DOCB path and type flag lengths differ");
	kinds = palloc(count * sizeof(int));
	for (i = 0; i < count; i++)
	{
		if (nulls[i] || flagnulls[i])
			PG_RETURN_NULL();
		kinds[i] = DatumGetInt32(flags[i]);
		if (kinds[i] != 1 && kinds[i] != 2)
			elog(ERROR, "invalid DOCB projection type flag");
	}
	result = docb_project((struct varlena *) PG_GETARG_POINTER(0), path, kinds, count);
	return docb_result(fcinfo, result, as_text);
}

Datum
docb_get_element(Datum value, Datum *path, int count, bool *isnull)
{
	Jsonb	   *result = docb_project((struct varlena *) DatumGetPointer(value), path, NULL, count);

	*isnull = result == NULL;
	return result ? PointerGetDatum(result) : (Datum) 0;
}

Datum
docb_object_field(PG_FUNCTION_ARGS)
{
	return docb_projection(fcinfo, false, false, false);
}
Datum
docb_object_field_text(PG_FUNCTION_ARGS)
{
	return docb_projection(fcinfo, true, false, false);
}
Datum
docb_array_element(PG_FUNCTION_ARGS)
{
	return docb_projection(fcinfo, false, false, true);
}
Datum
docb_array_element_text(PG_FUNCTION_ARGS)
{
	return docb_projection(fcinfo, true, false, true);
}
Datum
docb_extract_path(PG_FUNCTION_ARGS)
{
	return docb_projection(fcinfo, false, true, false);
}
Datum
docb_extract_path_text(PG_FUNCTION_ARGS)
{
	return docb_projection(fcinfo, true, true, false);
}
