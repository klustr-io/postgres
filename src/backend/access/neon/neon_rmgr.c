/*
 * Adapted for standalone PostgreSQL 18 from Neon's neon_rmgr at
 * fa504217c61bbcaf5c512d75830564541f917f8f (Apache-2.0).
 * Copyright 2022-2024 Neon Inc.
 * Modified by Klustr: core fallback registration, PostgreSQL 18 allocation
 * APIs, corrected tuple-length calculations, and shared heap page masking.
 * PG18.6 visibility-map redo portions Copyright (c) 1996-2026,
 * PostgreSQL Global Development Group; see POSTGRESQL-LICENSE.
 * See LICENSE and NOTICE in this directory.
 */

#include "postgres.h"

#include "access/bufmask.h"
#include "access/heapam_xlog.h"
#include "access/htup_details.h"
#include "access/neon_xlog.h"
#include "access/rmgr.h"
#include "access/visibilitymap.h"
#include "access/xlog_internal.h"
#include "access/xlogutils.h"
#include "miscadmin.h"
#include "storage/buf.h"
#include "storage/bufmgr.h"
#include "storage/bufpage.h"
#include "storage/freespace.h"
#include "neon_rmgr.h"


static void
neon_vm_clear(XLogReaderState *record,
				   RelFileLocator target_locator,
				   BlockNumber heap_blkno,
				   uint8 wal_vm_block_id, uint8 flags)
{
	XLogRecPtr	lsn = record->EndRecPtr;
	Relation	reln = CreateFakeRelcacheEntry(target_locator);
	Buffer		vmbuffer = InvalidBuffer;

	/*
	 * If the vmbuffer was registered, use the recovery-specific routines to
	 * read it. These will either apply an FPI or indicate that we should
	 * clear the requested bits ourselves.
	 *
	 * Originally, clearing the VM did not register the VM buffers, so since
	 * registering the VM buffer was a bug fix, we keep a fallback path to
	 * support replay of WAL generated from before the fix.
	 */
	if (XLogRecHasBlockRef(record, wal_vm_block_id))
	{
		if (XLogReadBufferForRedo(record, wal_vm_block_id,
								  &vmbuffer) == BLK_NEEDS_REDO)
		{
			if (visibilitymap_clear_locked(reln,
										   heap_blkno, vmbuffer,
										   flags))
				PageSetLSN(BufferGetPage(vmbuffer), lsn);
		}
		if (BufferIsValid(vmbuffer))
			UnlockReleaseBuffer(vmbuffer);
	}
	else
	{
		/*
		 * This is the backwards compatibility path to clear VM bits for
		 * records predating VM buffer registration. It is also invoked if the
		 * heap page's PD_ALL_VISIBLE was cleared but the VM bits were already
		 * clear. The WAL record flags do not distinguish between these two
		 * situations. Though this is wasted effort, the behavior is
		 * historical and the situation should be rare.
		 */
		visibilitymap_pin(reln, heap_blkno, &vmbuffer);
		visibilitymap_clear(reln, heap_blkno, vmbuffer, flags);
		ReleaseBuffer(vmbuffer);
	}

	FreeFakeRelcacheEntry(reln);
}

static void
neon_vm_clear_update(XLogReaderState *record, RelFileLocator rlocator,
					 BlockNumber oldblk, BlockNumber newblk, uint8 flags)
{
	XLogRecPtr lsn = record->EndRecPtr;
	bool new_cleared;
	bool old_cleared;

	new_cleared = (flags & XLH_UPDATE_NEW_ALL_VISIBLE_CLEARED) != 0;
	old_cleared = (flags & XLH_UPDATE_OLD_ALL_VISIBLE_CLEARED) != 0;
	if ((new_cleared || old_cleared) && !am_wal_redo_postgres)
	{
		Relation	reln = CreateFakeRelcacheEntry(rlocator);
		bool		has_vm_old = XLogRecHasBlockRef(record, HEAP_UPDATE_BLKREF_VM_OLD);
		bool		has_vm_new = XLogRecHasBlockRef(record, HEAP_UPDATE_BLKREF_VM_NEW);

		if (has_vm_new)
		{
			Buffer		vmbuffer_new = InvalidBuffer;

			Assert(flags & XLH_UPDATE_NEW_ALL_VISIBLE_CLEARED);

			if (XLogReadBufferForRedo(record, HEAP_UPDATE_BLKREF_VM_NEW,
									  &vmbuffer_new) == BLK_NEEDS_REDO)
			{
				/*
				 * If both the old and new heap pages were all-visible and
				 * their VM bits are on the same VM page, that single VM page
				 * is registered as HEAP_UPDATE_BLKREF_VM_NEW. Clear both heap
				 * blocks' VM bits from the single provided VM buffer. It's
				 * possible that one of the page's VM bits were already clear,
				 * but visibilitymap_clear() is harmless as long as we provide
				 * it the correct bits.
				 *
				 * We must verify that oldblk's VM bits really are on this VM
				 * page, rather than relying on the absence of a separate
				 * VM_OLD block reference: VM_OLD is also omitted when oldblk
				 * is on a different VM page but its bit was already clear.
				 */
				if (flags & XLH_UPDATE_OLD_ALL_VISIBLE_CLEARED &&
					visibilitymap_pin_ok(oldblk, vmbuffer_new))
				{
					if (visibilitymap_clear_locked(reln, oldblk, vmbuffer_new,
												   VISIBILITYMAP_VALID_BITS))
						PageSetLSN(BufferGetPage(vmbuffer_new), lsn);
				}
				/* If VM_NEW is registered, we are sure newblk is on VM_NEW */
				if (visibilitymap_clear_locked(reln, newblk, vmbuffer_new,
											   VISIBILITYMAP_VALID_BITS))
					PageSetLSN(BufferGetPage(vmbuffer_new), lsn);
			}
			if (BufferIsValid(vmbuffer_new))
				UnlockReleaseBuffer(vmbuffer_new);
		}
		if (has_vm_old)
		{
			Buffer		vmbuffer_old = InvalidBuffer;

			Assert(flags & XLH_UPDATE_OLD_ALL_VISIBLE_CLEARED);

			if (XLogReadBufferForRedo(record, HEAP_UPDATE_BLKREF_VM_OLD, &vmbuffer_old) ==
				BLK_NEEDS_REDO)
			{
				if (visibilitymap_clear_locked(reln, oldblk, vmbuffer_old,
											   VISIBILITYMAP_VALID_BITS))
					PageSetLSN(BufferGetPage(vmbuffer_old), lsn);
			}
			if (BufferIsValid(vmbuffer_old))
				UnlockReleaseBuffer(vmbuffer_old);
		}
		if (!has_vm_old && !has_vm_new)
		{
			/*
			 * Backwards compatibility path. Previously, the VM buffers were
			 * not registered in the WAL record. We need this path to replay
			 * WAL generated by a not-yet-patched primary during upgrade.
			 */
			if (old_cleared)
			{
				Buffer		vmbuffer = InvalidBuffer;

				visibilitymap_pin(reln, oldblk, &vmbuffer);
				visibilitymap_clear(reln, oldblk, vmbuffer,
									VISIBILITYMAP_VALID_BITS);
				ReleaseBuffer(vmbuffer);
			}
			if (new_cleared)
			{
				Buffer		vmbuffer = InvalidBuffer;

				visibilitymap_pin(reln, newblk, &vmbuffer);
				visibilitymap_clear(reln, newblk, vmbuffer,
									VISIBILITYMAP_VALID_BITS);
				ReleaseBuffer(vmbuffer);
			}
		}

		FreeFakeRelcacheEntry(reln);
	}
}

static void neon_rm_redo(XLogReaderState *record);

static void redo_neon_heap_insert(XLogReaderState *record);
static void redo_neon_heap_delete(XLogReaderState *record);
static void redo_neon_heap_update(XLogReaderState *record, bool hot_update);
static void redo_neon_heap_lock(XLogReaderState *record);
static void redo_neon_heap_multi_insert(XLogReaderState *record);

static const RmgrData NeonRmgr = {
	.rm_name = "neon",
	.rm_redo = neon_rm_redo,
	.rm_desc = neon_builtin_desc,
	.rm_identify = neon_builtin_identify,
	.rm_startup = NULL,
	.rm_cleanup = NULL,
	.rm_mask = heap_mask,
	.rm_decode = neon_builtin_decode,
};

/*
 * Heap writes always emit RM_NEON_ID records in this fork. Supply the matching
 * handlers even when no Neon runtime extension is installed. Explicit preload
 * libraries run first and can register their own implementation of this ID.
 */
void
InitializeNeonRmgr(void)
{
	if (!RmgrIdExists(RM_NEON_ID))
		RmgrTable[RM_NEON_ID] = NeonRmgr;
}

static void
neon_rm_redo(XLogReaderState *record)
{
	uint8		info = XLogRecGetInfo(record) & ~XLR_INFO_MASK;

	switch (info & XLOG_NEON_OPMASK)
	{
		case XLOG_NEON_HEAP_INSERT:
			redo_neon_heap_insert(record);
			break;
		case XLOG_NEON_HEAP_DELETE:
			redo_neon_heap_delete(record);
			break;
		case XLOG_NEON_HEAP_UPDATE:
			redo_neon_heap_update(record, false);
			break;
		case XLOG_NEON_HEAP_HOT_UPDATE:
			redo_neon_heap_update(record, true);
			break;
		case XLOG_NEON_HEAP_LOCK:
			redo_neon_heap_lock(record);
			break;
		case XLOG_NEON_HEAP_MULTI_INSERT:
			redo_neon_heap_multi_insert(record);
			break;
		default:
			elog(PANIC, "neon_rm_redo: unknown op code %u", info);
	}
}

/*
 * COPIED FROM heapam.c
 * Given an "infobits" field from an XLog record, set the correct bits in the
 * given infomask and infomask2 for the tuple touched by the record.
 *
 * (This is the reverse of compute_infobits).
 */
static void
fix_infomask_from_infobits(uint8 infobits, uint16 *infomask, uint16 *infomask2)
{
	*infomask &= ~(HEAP_XMAX_IS_MULTI | HEAP_XMAX_LOCK_ONLY |
				   HEAP_XMAX_KEYSHR_LOCK | HEAP_XMAX_EXCL_LOCK | HEAP_COMBOCID);
	*infomask2 &= ~HEAP_KEYS_UPDATED;

	if (infobits & XLHL_XMAX_IS_MULTI)
		*infomask |= HEAP_XMAX_IS_MULTI;
	if (infobits & XLHL_XMAX_LOCK_ONLY)
		*infomask |= HEAP_XMAX_LOCK_ONLY;
	if (infobits & XLHL_XMAX_EXCL_LOCK)
		*infomask |= HEAP_XMAX_EXCL_LOCK;
	if (infobits & XLHL_COMBOCID)
		*infomask |= HEAP_COMBOCID;
	/* note HEAP_XMAX_SHR_LOCK isn't considered here */
	if (infobits & XLHL_XMAX_KEYSHR_LOCK)
		*infomask |= HEAP_XMAX_KEYSHR_LOCK;

	if (infobits & XLHL_KEYS_UPDATED)
		*infomask2 |= HEAP_KEYS_UPDATED;
}

static void
redo_neon_heap_insert(XLogReaderState *record)
{
	XLogRecPtr	lsn = record->EndRecPtr;
	xl_neon_heap_insert *xlrec = (xl_neon_heap_insert *) XLogRecGetData(record);
	Buffer		buffer;
	Page		page;
	union
	{
		HeapTupleHeaderData hdr;
		char		data[MaxHeapTupleSize];
	}			tbuf;
	HeapTupleHeader htup;
	xl_neon_heap_header xlhdr;
	uint32		newlen;
	Size		freespace = 0;
	RelFileLocator target_locator;
	BlockNumber blkno;
	ItemPointerData target_tid;
	XLogRedoAction action;

	XLogRecGetBlockTag(record, 0, &target_locator, NULL, &blkno);
	ItemPointerSetBlockNumber(&target_tid, blkno);
	ItemPointerSetOffsetNumber(&target_tid, xlrec->offnum);

	/*
	 * The visibility map may need to be fixed even if the heap page is
	 * already up-to-date.
	 */
	if (xlrec->flags & XLH_INSERT_ALL_VISIBLE_CLEARED && !am_wal_redo_postgres)
		neon_vm_clear(record, target_locator, blkno, HEAP_INSERT_BLKREF_VM,
					  VISIBILITYMAP_VALID_BITS);

	/*
	 * If we inserted the first and only tuple on the page, re-initialize the
	 * page from scratch.
	 */
	if (XLogRecGetInfo(record) & XLOG_HEAP_INIT_PAGE)
	{
		buffer = XLogInitBufferForRedo(record, 0);
		page = BufferGetPage(buffer);
		PageInit(page, BufferGetPageSize(buffer), 0);
		action = BLK_NEEDS_REDO;
	}
	else
		action = XLogReadBufferForRedo(record, 0, &buffer);
	if (action == BLK_NEEDS_REDO)
	{
		Size		datalen;
		char	   *data;

		page = BufferGetPage(buffer);

		if (PageGetMaxOffsetNumber(page) + 1 < xlrec->offnum)
			elog(PANIC, "neon_rm_redo: invalid max offset number");

		data = XLogRecGetBlockData(record, 0, &datalen);

		newlen = datalen - SizeOfNeonHeapHeader;
		Assert(datalen > SizeOfNeonHeapHeader && newlen <= MaxHeapTupleSize);
		memcpy((char *) &xlhdr, data, SizeOfNeonHeapHeader);
		data += SizeOfNeonHeapHeader;

		htup = &tbuf.hdr;
		MemSet((char *) htup, 0, SizeofHeapTupleHeader);
		/* PG73FORMAT: get bitmap [+ padding] [+ oid] + data */
		memcpy((char *) htup + SizeofHeapTupleHeader,
			   data,
			   newlen);
		newlen += SizeofHeapTupleHeader;
		htup->t_infomask2 = xlhdr.t_infomask2;
		htup->t_infomask = xlhdr.t_infomask;
		htup->t_hoff = xlhdr.t_hoff;
		HeapTupleHeaderSetXmin(htup, XLogRecGetXid(record));
		htup->t_choice.t_heap.t_field3.t_cid = xlhdr.t_cid;
		htup->t_ctid = target_tid;

		if (PageAddItem(page, (Item) htup, newlen, xlrec->offnum,
						true, true) == InvalidOffsetNumber)
			elog(PANIC, "neon_rm_redo: failed to add tuple");

		freespace = PageGetHeapFreeSpace(page); /* needed to update FSM below */

		PageSetLSN(page, lsn);

		if (xlrec->flags & XLH_INSERT_ALL_VISIBLE_CLEARED)
			PageClearAllVisible(page);

		/* XLH_INSERT_ALL_FROZEN_SET implies that all tuples are visible */
		if (xlrec->flags & XLH_INSERT_ALL_FROZEN_SET)
			PageSetAllVisible(page);

		MarkBufferDirty(buffer);
	}
	if (BufferIsValid(buffer))
		UnlockReleaseBuffer(buffer);

	/*
	 * If the page is running low on free space, update the FSM as well.
	 * Arbitrarily, our definition of "low" is less than 20%. We can't do much
	 * better than that without knowing the fill-factor for the table.
	 *
	 * XXX: Don't do this if the page was restored from full page image. We
	 * don't bother to update the FSM in that case, it doesn't need to be
	 * totally accurate anyway.
	 */
	if (action == BLK_NEEDS_REDO && freespace < BLCKSZ / 5)
		XLogRecordPageWithFreeSpace(target_locator, blkno, freespace);
}

static void
redo_neon_heap_delete(XLogReaderState *record)
{
	XLogRecPtr	lsn = record->EndRecPtr;
	xl_neon_heap_delete *xlrec = (xl_neon_heap_delete *) XLogRecGetData(record);
	Buffer		buffer;
	Page		page;
	ItemId		lp = NULL;
	HeapTupleHeader htup;
	BlockNumber blkno;
	RelFileLocator target_locator;
	ItemPointerData target_tid;

	XLogRecGetBlockTag(record, 0, &target_locator, NULL, &blkno);
	ItemPointerSetBlockNumber(&target_tid, blkno);
	ItemPointerSetOffsetNumber(&target_tid, xlrec->offnum);

	/*
	 * The visibility map may need to be fixed even if the heap page is
	 * already up-to-date.
	 */
	if (xlrec->flags & XLH_DELETE_ALL_VISIBLE_CLEARED && !am_wal_redo_postgres)
		neon_vm_clear(record, target_locator, blkno, HEAP_DELETE_BLKREF_VM,
					  VISIBILITYMAP_VALID_BITS);

	if (XLogReadBufferForRedo(record, 0, &buffer) == BLK_NEEDS_REDO)
	{
		page = BufferGetPage(buffer);

		if (PageGetMaxOffsetNumber(page) >= xlrec->offnum)
			lp = PageGetItemId(page, xlrec->offnum);

		if (PageGetMaxOffsetNumber(page) < xlrec->offnum || !ItemIdIsNormal(lp))
			elog(PANIC, "neon_rm_redo: invalid lp");

		htup = (HeapTupleHeader) PageGetItem(page, lp);

		htup->t_infomask &= ~(HEAP_XMAX_BITS | HEAP_MOVED);
		htup->t_infomask2 &= ~HEAP_KEYS_UPDATED;
		HeapTupleHeaderClearHotUpdated(htup);
		fix_infomask_from_infobits(xlrec->infobits_set,
								   &htup->t_infomask, &htup->t_infomask2);
		if (!(xlrec->flags & XLH_DELETE_IS_SUPER))
			HeapTupleHeaderSetXmax(htup, xlrec->xmax);
		else
			HeapTupleHeaderSetXmin(htup, InvalidTransactionId);
		htup->t_choice.t_heap.t_field3.t_cid = xlrec->t_cid;

		/* Mark the page as a candidate for pruning */
		PageSetPrunable(page, XLogRecGetXid(record));

		if (xlrec->flags & XLH_DELETE_ALL_VISIBLE_CLEARED)
			PageClearAllVisible(page);

		/* Make sure t_ctid is set correctly */
		if (xlrec->flags & XLH_DELETE_IS_PARTITION_MOVE)
			HeapTupleHeaderSetMovedPartitions(htup);
		else
			htup->t_ctid = target_tid;
		PageSetLSN(page, lsn);
		MarkBufferDirty(buffer);
	}
	if (BufferIsValid(buffer))
		UnlockReleaseBuffer(buffer);
}

static void
redo_neon_heap_update(XLogReaderState *record, bool hot_update)
{
	XLogRecPtr	lsn = record->EndRecPtr;
	xl_neon_heap_update *xlrec = (xl_neon_heap_update *) XLogRecGetData(record);
	RelFileLocator rlocator;
	BlockNumber oldblk;
	BlockNumber newblk;
	ItemPointerData newtid;
	Buffer		obuffer,
				nbuffer;
	Page		page;
	OffsetNumber offnum;
	ItemId		lp = NULL;
	HeapTupleData oldtup;
	HeapTupleHeader htup;
	uint16		prefixlen = 0,
				suffixlen = 0;
	char	   *newp;
	union
	{
		HeapTupleHeaderData hdr;
		char		data[MaxHeapTupleSize];
	}			tbuf;
	xl_neon_heap_header xlhdr;
	uint32		newlen;
	Size		freespace = 0;
	XLogRedoAction oldaction;
	XLogRedoAction newaction;

	/* initialize to keep the compiler quiet */
	oldtup.t_data = NULL;
	oldtup.t_len = 0;

	XLogRecGetBlockTag(record, 0, &rlocator, NULL, &newblk);
	if (XLogRecGetBlockTagExtended(record, 1, NULL, NULL, &oldblk, NULL))
	{
		/* HOT updates are never done across pages */
		Assert(!hot_update);
	}
	else
		oldblk = newblk;

	ItemPointerSet(&newtid, newblk, xlrec->new_offnum);

	/*
	 * The visibility map may need to be fixed even if the heap page is
	 * already up-to-date.
	 */
	neon_vm_clear_update(record, rlocator, oldblk, newblk, xlrec->flags);

	/*
	 * In normal operation, it is important to lock the two pages in
	 * page-number order, to avoid possible deadlocks against other update
	 * operations going the other way.  However, during WAL replay there can
	 * be no other update happening, so we don't need to worry about that. But
	 * we *do* need to worry that we don't expose an inconsistent state to Hot
	 * Standby queries --- so the original page can't be unlocked before we've
	 * added the new tuple to the new page.
	 */

	/* Deal with old tuple version */
	oldaction = XLogReadBufferForRedo(record, (oldblk == newblk) ? 0 : 1,
									  &obuffer);
	if (oldaction == BLK_NEEDS_REDO)
	{
		page = BufferGetPage(obuffer);
		offnum = xlrec->old_offnum;
		if (PageGetMaxOffsetNumber(page) >= offnum)
			lp = PageGetItemId(page, offnum);

		if (PageGetMaxOffsetNumber(page) < offnum || !ItemIdIsNormal(lp))
			elog(PANIC, "neon_rm_redo: invalid lp");

		htup = (HeapTupleHeader) PageGetItem(page, lp);

		oldtup.t_data = htup;
		oldtup.t_len = ItemIdGetLength(lp);

		htup->t_infomask &= ~(HEAP_XMAX_BITS | HEAP_MOVED);
		htup->t_infomask2 &= ~HEAP_KEYS_UPDATED;
		if (hot_update)
			HeapTupleHeaderSetHotUpdated(htup);
		else
			HeapTupleHeaderClearHotUpdated(htup);
		fix_infomask_from_infobits(xlrec->old_infobits_set, &htup->t_infomask,
								   &htup->t_infomask2);
		HeapTupleHeaderSetXmax(htup, xlrec->old_xmax);
		htup->t_choice.t_heap.t_field3.t_cid = xlrec->t_cid;
		/* Set forward chain link in t_ctid */
		htup->t_ctid = newtid;

		/* Mark the page as a candidate for pruning */
		PageSetPrunable(page, XLogRecGetXid(record));

		if (xlrec->flags & XLH_UPDATE_OLD_ALL_VISIBLE_CLEARED)
			PageClearAllVisible(page);

		PageSetLSN(page, lsn);
		MarkBufferDirty(obuffer);
	}

	/*
	 * Read the page the new tuple goes into, if different from old.
	 */
	if (oldblk == newblk)
	{
		nbuffer = obuffer;
		newaction = oldaction;
	}
	else if (XLogRecGetInfo(record) & XLOG_HEAP_INIT_PAGE)
	{
		nbuffer = XLogInitBufferForRedo(record, 0);
		page = (Page) BufferGetPage(nbuffer);
		PageInit(page, BufferGetPageSize(nbuffer), 0);
		newaction = BLK_NEEDS_REDO;
	}
	else
		newaction = XLogReadBufferForRedo(record, 0, &nbuffer);

	/*
	 * The visibility map may need to be fixed even if the heap page is
	 * already up-to-date.
	 */


	/* Deal with new tuple */
	if (newaction == BLK_NEEDS_REDO)
	{
		char	   *recdata;
		char	   *recdata_end;
		Size		datalen;
		Size		tuplen;

		recdata = XLogRecGetBlockData(record, 0, &datalen);
		recdata_end = recdata + datalen;

		page = BufferGetPage(nbuffer);

		offnum = xlrec->new_offnum;
		if (PageGetMaxOffsetNumber(page) + 1 < offnum)
			elog(PANIC, "neon_rm_redo: invalid max offset number");

		if (xlrec->flags & XLH_UPDATE_PREFIX_FROM_OLD)
		{
			Assert(newblk == oldblk);
			memcpy(&prefixlen, recdata, sizeof(uint16));
			recdata += sizeof(uint16);
		}
		if (xlrec->flags & XLH_UPDATE_SUFFIX_FROM_OLD)
		{
			Assert(newblk == oldblk);
			memcpy(&suffixlen, recdata, sizeof(uint16));
			recdata += sizeof(uint16);
		}

		memcpy((char *) &xlhdr, recdata, SizeOfNeonHeapHeader);
		recdata += SizeOfNeonHeapHeader;

		tuplen = recdata_end - recdata;
		Assert(tuplen <= MaxHeapTupleSize);

		htup = &tbuf.hdr;
		MemSet((char *) htup, 0, SizeofHeapTupleHeader);

		/*
		 * Reconstruct the new tuple using the prefix and/or suffix from the
		 * old tuple, and the data stored in the WAL record.
		 */
		newp = (char *) htup + SizeofHeapTupleHeader;
		if (prefixlen > 0)
		{
			int			len;

			/* copy bitmap [+ padding] [+ oid] from WAL record */
			len = xlhdr.t_hoff - SizeofHeapTupleHeader;
			memcpy(newp, recdata, len);
			recdata += len;
			newp += len;

			/* copy prefix from old tuple */
			memcpy(newp, (char *) oldtup.t_data + oldtup.t_data->t_hoff, prefixlen);
			newp += prefixlen;

			/* copy new tuple data from WAL record */
			len = tuplen - (xlhdr.t_hoff - SizeofHeapTupleHeader);
			memcpy(newp, recdata, len);
			recdata += len;
			newp += len;
		}
		else
		{
			/*
			 * copy bitmap [+ padding] [+ oid] + data from record, all in one
			 * go
			 */
			memcpy(newp, recdata, tuplen);
			recdata += tuplen;
			newp += tuplen;
		}
		Assert(recdata == recdata_end);

		/* copy suffix from old tuple */
		if (suffixlen > 0)
			memcpy(newp, (char *) oldtup.t_data + oldtup.t_len - suffixlen, suffixlen);

		newlen = SizeofHeapTupleHeader + tuplen + prefixlen + suffixlen;
		htup->t_infomask2 = xlhdr.t_infomask2;
		htup->t_infomask = xlhdr.t_infomask;
		htup->t_hoff = xlhdr.t_hoff;

		HeapTupleHeaderSetXmin(htup, XLogRecGetXid(record));
		htup->t_choice.t_heap.t_field3.t_cid = xlhdr.t_cid;
		HeapTupleHeaderSetXmax(htup, xlrec->new_xmax);
		/* Make sure there is no forward chain link in t_ctid */
		htup->t_ctid = newtid;

		offnum = PageAddItem(page, (Item) htup, newlen, offnum, true, true);
		if (offnum == InvalidOffsetNumber)
			elog(PANIC, "neon_rm_redo: failed to add tuple");

		if (xlrec->flags & XLH_UPDATE_NEW_ALL_VISIBLE_CLEARED)
			PageClearAllVisible(page);

		freespace = PageGetHeapFreeSpace(page); /* needed to update FSM below */

		PageSetLSN(page, lsn);
		MarkBufferDirty(nbuffer);
	}

	if (BufferIsValid(nbuffer) && nbuffer != obuffer)
		UnlockReleaseBuffer(nbuffer);
	if (BufferIsValid(obuffer))
		UnlockReleaseBuffer(obuffer);

	/*
	 * If the new page is running low on free space, update the FSM as well.
	 * Arbitrarily, our definition of "low" is less than 20%. We can't do much
	 * better than that without knowing the fill-factor for the table.
	 *
	 * However, don't update the FSM on HOT updates, because after crash
	 * recovery, either the old or the new tuple will certainly be dead and
	 * prunable. After pruning, the page will have roughly as much free space
	 * as it did before the update, assuming the new tuple is about the same
	 * size as the old one.
	 *
	 * XXX: Don't do this if the page was restored from full page image. We
	 * don't bother to update the FSM in that case, it doesn't need to be
	 * totally accurate anyway.
	 */
	if (newaction == BLK_NEEDS_REDO && !hot_update && freespace < BLCKSZ / 5)
		XLogRecordPageWithFreeSpace(rlocator, newblk, freespace);
}

static void
redo_neon_heap_lock(XLogReaderState *record)
{
	XLogRecPtr	lsn = record->EndRecPtr;
	xl_neon_heap_lock *xlrec = (xl_neon_heap_lock *) XLogRecGetData(record);
	Buffer		buffer;
	Page		page;
	OffsetNumber offnum;
	ItemId		lp = NULL;
	HeapTupleHeader htup;

	/*
	 * The visibility map may need to be fixed even if the heap page is
	 * already up-to-date.
	 */
	if (xlrec->flags & XLH_LOCK_ALL_FROZEN_CLEARED && !am_wal_redo_postgres)
	{
		RelFileLocator rlocator;
		BlockNumber block;

		XLogRecGetBlockTag(record, HEAP_LOCK_BLKREF_HEAP, &rlocator, NULL, &block);
		neon_vm_clear(record, rlocator, block, HEAP_LOCK_BLKREF_VM,
					  VISIBILITYMAP_ALL_FROZEN);
	}

	if (XLogReadBufferForRedo(record, 0, &buffer) == BLK_NEEDS_REDO)
	{
		page = (Page) BufferGetPage(buffer);

		offnum = xlrec->offnum;
		if (PageGetMaxOffsetNumber(page) >= offnum)
			lp = PageGetItemId(page, offnum);

		if (PageGetMaxOffsetNumber(page) < offnum || !ItemIdIsNormal(lp))
			elog(PANIC, "neon_rm_redo: invalid lp");

		htup = (HeapTupleHeader) PageGetItem(page, lp);

		htup->t_infomask &= ~(HEAP_XMAX_BITS | HEAP_MOVED);
		htup->t_infomask2 &= ~HEAP_KEYS_UPDATED;
		fix_infomask_from_infobits(xlrec->infobits_set, &htup->t_infomask,
								   &htup->t_infomask2);

		/*
		 * Clear relevant update flags, but only if the modified infomask says
		 * there's no update.
		 */
		if (HEAP_XMAX_IS_LOCKED_ONLY(htup->t_infomask))
		{
			HeapTupleHeaderClearHotUpdated(htup);
			/* Make sure there is no forward chain link in t_ctid */
			ItemPointerSet(&htup->t_ctid,
						   BufferGetBlockNumber(buffer),
						   offnum);
		}
		HeapTupleHeaderSetXmax(htup, xlrec->xmax);
		htup->t_choice.t_heap.t_field3.t_cid = xlrec->t_cid;
		PageSetLSN(page, lsn);
		MarkBufferDirty(buffer);
	}
	if (BufferIsValid(buffer))
		UnlockReleaseBuffer(buffer);
}

static void
redo_neon_heap_multi_insert(XLogReaderState *record)
{
	XLogRecPtr	lsn = record->EndRecPtr;
	xl_neon_heap_multi_insert *xlrec;
	RelFileLocator rlocator;
	BlockNumber blkno;
	Buffer		buffer;
	Page		page;
	union
	{
		HeapTupleHeaderData hdr;
		char		data[MaxHeapTupleSize];
	}			tbuf;
	HeapTupleHeader htup;
	uint32		newlen;
	Size		freespace = 0;
	int			i;
	bool		isinit = (XLogRecGetInfo(record) & XLOG_HEAP_INIT_PAGE) != 0;
	XLogRedoAction action;

	/*
	 * Insertion doesn't overwrite MVCC data, so no conflict processing is
	 * required.
	 */
	xlrec = (xl_neon_heap_multi_insert *) XLogRecGetData(record);

	XLogRecGetBlockTag(record, 0, &rlocator, NULL, &blkno);

	/* check that the mutually exclusive flags are not both set */
	Assert(!((xlrec->flags & XLH_INSERT_ALL_VISIBLE_CLEARED) &&
			 (xlrec->flags & XLH_INSERT_ALL_FROZEN_SET)));

	/*
	 * The visibility map may need to be fixed even if the heap page is
	 * already up-to-date.
	 */
	if (xlrec->flags & XLH_INSERT_ALL_VISIBLE_CLEARED && !am_wal_redo_postgres)
		neon_vm_clear(record, rlocator, blkno, HEAP_MULTI_INSERT_BLKREF_VM,
					  VISIBILITYMAP_VALID_BITS);

	if (isinit)
	{
		buffer = XLogInitBufferForRedo(record, 0);
		page = BufferGetPage(buffer);
		PageInit(page, BufferGetPageSize(buffer), 0);
		action = BLK_NEEDS_REDO;
	}
	else
		action = XLogReadBufferForRedo(record, 0, &buffer);
	if (action == BLK_NEEDS_REDO)
	{
		char	   *tupdata;
		char	   *endptr;
		Size		len;

		/* Tuples are stored as block data */
		tupdata = XLogRecGetBlockData(record, 0, &len);
		endptr = tupdata + len;

		page = (Page) BufferGetPage(buffer);

		for (i = 0; i < xlrec->ntuples; i++)
		{
			OffsetNumber offnum;
			xl_neon_multi_insert_tuple *xlhdr;

			/*
			 * If we're reinitializing the page, the tuples are stored in
			 * order from FirstOffsetNumber. Otherwise there's an array of
			 * offsets in the WAL record, and the tuples come after that.
			 */
			if (isinit)
				offnum = FirstOffsetNumber + i;
			else
				offnum = xlrec->offsets[i];
			if (PageGetMaxOffsetNumber(page) + 1 < offnum)
				elog(PANIC, "neon_rm_redo: invalid max offset number");

			xlhdr = (xl_neon_multi_insert_tuple *) SHORTALIGN(tupdata);
			tupdata = ((char *) xlhdr) + SizeOfNeonMultiInsertTuple;

			newlen = xlhdr->datalen;
			Assert(newlen <= MaxHeapTupleSize);
			htup = &tbuf.hdr;
			MemSet((char *) htup, 0, SizeofHeapTupleHeader);
			/* PG73FORMAT: get bitmap [+ padding] [+ oid] + data */
			memcpy((char *) htup + SizeofHeapTupleHeader,
				   (char *) tupdata,
				   newlen);
			tupdata += newlen;

			newlen += SizeofHeapTupleHeader;
			htup->t_infomask2 = xlhdr->t_infomask2;
			htup->t_infomask = xlhdr->t_infomask;
			htup->t_hoff = xlhdr->t_hoff;
			HeapTupleHeaderSetXmin(htup, XLogRecGetXid(record));
			htup->t_choice.t_heap.t_field3.t_cid = xlrec->t_cid;
			ItemPointerSetBlockNumber(&htup->t_ctid, blkno);
			ItemPointerSetOffsetNumber(&htup->t_ctid, offnum);

			offnum = PageAddItem(page, (Item) htup, newlen, offnum, true, true);
			if (offnum == InvalidOffsetNumber)
				elog(PANIC, "neon_rm_redo: failed to add tuple");
		}
		if (tupdata != endptr)
			elog(PANIC, "neon_rm_redo: total tuple length mismatch");

		freespace = PageGetHeapFreeSpace(page); /* needed to update FSM below */

		PageSetLSN(page, lsn);

		if (xlrec->flags & XLH_INSERT_ALL_VISIBLE_CLEARED)
			PageClearAllVisible(page);

		/* XLH_INSERT_ALL_FROZEN_SET implies that all tuples are visible */
		if (xlrec->flags & XLH_INSERT_ALL_FROZEN_SET)
			PageSetAllVisible(page);

		MarkBufferDirty(buffer);
	}
	if (BufferIsValid(buffer))
		UnlockReleaseBuffer(buffer);

	/*
	 * If the page is running low on free space, update the FSM as well.
	 * Arbitrarily, our definition of "low" is less than 20%. We can't do much
	 * better than that without knowing the fill-factor for the table.
	 *
	 * XXX: Don't do this if the page was restored from full page image. We
	 * don't bother to update the FSM in that case, it doesn't need to be
	 * totally accurate anyway.
	 */
	if (action == BLK_NEEDS_REDO && freespace < BLCKSZ / 5)
		XLogRecordPageWithFreeSpace(rlocator, blkno, freespace);
}
