/* Native document storage.  Full values use the canonical JSONB representation. */
#ifndef DOCB_H
#define DOCB_H

#include "access/toast_helper.h"
#include "fmgr.h"

extern void docb_toast_prepare(ToastTupleContext *ttc, int options);
extern void docb_delete_dependencies(Relation rel, Datum value, bool speculative);
extern struct varlena *docb_decompress(struct varlena *value);
extern Datum docb_get_element(Datum value, Datum *path, int count, bool *isnull);
extern bool docb_is_type(Oid typeid);
extern Datum docb_object_field(PG_FUNCTION_ARGS);
extern Datum docb_object_field_text(PG_FUNCTION_ARGS);
extern Datum docb_array_element(PG_FUNCTION_ARGS);
extern Datum docb_array_element_text(PG_FUNCTION_ARGS);
extern Datum docb_extract_path(PG_FUNCTION_ARGS);
extern Datum docb_extract_path_text(PG_FUNCTION_ARGS);
extern Datum docb_project_chain(FunctionCallInfo fcinfo, bool as_text);

#endif
