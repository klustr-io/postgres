/* SQL entry points for the core DOCB storage and projection implementation. */
#include "postgres.h"
#include "fmgr.h"
#include "access/table.h"
#include "access/xact.h"
#include "access/xlog.h"
#include "catalog/catalog.h"
#include "catalog/pg_am_d.h"
#include "catalog/pg_class.h"
#include "catalog/pg_type_d.h"
#include "commands/cluster.h"
#include "miscadmin.h"
#include "nodes/makefuncs.h"
#include "nodes/nodeFuncs.h"
#include "nodes/supportnodes.h"
#include "parser/parse_func.h"
#include "utils/array.h"
#include "utils/acl.h"
#include "utils/datum.h"
#include "utils/docb.h"
#include "utils/lsyscache.h"
#include "utils/rel.h"

PG_MODULE_MAGIC;

PG_FUNCTION_INFO_V1(docb_storage_is_delta);
Datum
docb_storage_is_delta(PG_FUNCTION_ARGS)
{
	PG_RETURN_BOOL(docb_is_delta_value(PG_GETARG_DATUM(0)));
}

PG_FUNCTION_INFO_V1(docb_storage_is_jsonb_type);
Datum
docb_storage_is_jsonb_type(PG_FUNCTION_ARGS)
{
	PG_RETURN_BOOL(getBaseType(PG_GETARG_OID(0)) == JSONBOID);
}

/*
 * Use the same physical rewrite as VACUUM FULL, without changing column types
 * or invalidating dependent views.  cluster_rel owns and closes the relation,
 * rebuilds indexes and keeps its lock until transaction end.  The SQL caller
 * changes the storage policy in this same transaction before entering here.
 */
PG_FUNCTION_INFO_V1(docb_storage_rewrite_relation);
Datum
docb_storage_rewrite_relation(PG_FUNCTION_ARGS)
{
	Oid			relid = PG_GETARG_OID(0);
	Relation	rel = table_open(relid, AccessExclusiveLock);
	ClusterParams params = {0};

	if (IsSystemRelation(rel) || RELATION_IS_OTHER_TEMP(rel) ||
		(rel->rd_rel->relkind != RELKIND_RELATION &&
		 rel->rd_rel->relkind != RELKIND_MATVIEW) ||
		rel->rd_rel->relam != HEAP_TABLE_AM_OID)
		ereport(ERROR,
				(errcode(ERRCODE_FEATURE_NOT_SUPPORTED),
				 errmsg("DOCB migration requires a user heap table or materialized view")));
	if (!object_ownercheck(RelationRelationId, relid, GetUserId()))
		aclcheck_error(ACLCHECK_NOT_OWNER, OBJECT_TABLE, RelationGetRelationName(rel));
	if (XactReadOnly || RecoveryInProgress())
		ereport(ERROR,
				(errcode(ERRCODE_READ_ONLY_SQL_TRANSACTION),
				 errmsg("DOCB migration requires a writable primary")));

	cluster_rel(rel, InvalidOid, &params);
	PG_RETURN_VOID();
}

PG_FUNCTION_INFO_V1(docb_cast);
Datum
docb_cast(PG_FUNCTION_ARGS)
{
	PG_RETURN_POINTER(PG_DETOAST_DATUM(PG_GETARG_DATUM(0)));
}

#define DOCB_SQL_ENTRY(name, implementation) \
	PG_FUNCTION_INFO_V1(name); \
	Datum name(PG_FUNCTION_ARGS) { return implementation(fcinfo); }

DOCB_SQL_ENTRY(docb_field_sql, docb_object_field)
DOCB_SQL_ENTRY(docb_field_text_sql, docb_object_field_text)
DOCB_SQL_ENTRY(docb_element_sql, docb_array_element)
DOCB_SQL_ENTRY(docb_element_text_sql, docb_array_element_text)
DOCB_SQL_ENTRY(docb_path_sql, docb_extract_path)
DOCB_SQL_ENTRY(docb_path_text_sql, docb_extract_path_text)

PG_FUNCTION_INFO_V1(docb_chain_sql);
Datum
docb_chain_sql(PG_FUNCTION_ARGS)
{
	return docb_project_chain(fcinfo, false);
}

PG_FUNCTION_INFO_V1(docb_chain_text_sql);
Datum
docb_chain_text_sql(PG_FUNCTION_ARGS)
{
	return docb_project_chain(fcinfo, true);
}

static Oid
docb_function(const char *name, int nargs, Oid *types)
{
	return LookupFuncName(list_make2(makeString("pg_catalog"), makeString(pstrdup(name))),
						  nargs, types, true);
}

static Expr *
docb_key(Node *key)
{
	CoerceViaIO *cast;

	if (exprType(key) == TEXTOID)
		return (Expr *) copyObject(key);
	cast = makeNode(CoerceViaIO);
	cast->arg = (Expr *) copyObject(key);
	cast->resulttype = TEXTOID;
	cast->resultcollid = get_typcollation(TEXTOID);
	cast->coerceformat = COERCE_IMPLICIT_CAST;
	cast->location = -1;
	return (Expr *) cast;
}

static List *
docb_array_elements(Node *node, Oid type, bool *valid)
{
	List	   *result = NIL;
	Const	   *constant;
	ArrayType  *array;
	Datum	   *values;
	bool	   *nulls;
	int			count;
	int16		length;
	bool		byval;
	char		alignment;
	int			i;

	*valid = true;
	if (IsA(node, ArrayExpr))
		return copyObject(((ArrayExpr *) node)->elements);
	if (!IsA(node, Const) || ((Const *) node)->constisnull)
	{
		*valid = false;
		return NIL;
	}
	constant = (Const *) node;
	array = DatumGetArrayTypeP(constant->constvalue);
	get_typlenbyvalalign(type, &length, &byval, &alignment);
	deconstruct_array(array, type, length, byval, alignment, &values, &nulls, &count);
	for (i = 0; i < count; i++)
		result = lappend(result, makeConst(type, -1, get_typcollation(type), length,
										   nulls[i] ? (Datum) 0 : datumCopy(values[i], byval, length), nulls[i], byval));
	return result;
}

static ArrayExpr *
docb_array(Oid arraytype, Oid elementtype, List *elements)
{
	ArrayExpr  *result = makeNode(ArrayExpr);

	result->array_typeid = arraytype;
	result->array_collid = get_typcollation(elementtype);
	result->element_typeid = elementtype;
	result->elements = elements;
	result->multidims = false;
	result->location = -1;
	return result;
}

/*
 * Fuse ordinary ->/->> chains, not their data.  This avoids materializing a
 * large intermediate object and keeps every expression result self-contained.
 * Explicit per-step flags preserve the distinction between -> 0 and -> '0'.
 */
PG_FUNCTION_INFO_V1(docb_operator_support);
Datum
docb_operator_support(PG_FUNCTION_ARGS)
{
	Node	   *request = (Node *) PG_GETARG_POINTER(0);
	SupportRequestSimplify *simplify;
	Node	   *inner;
	Oid			innerid;
	Oid			types[3];
	Oid			function;
	Oid			chain;
	List	   *innerargs;
	List	   *keys;
	List	   *kinds;
	Node	   *base;
	bool		valid;
	bool		array_step;
	bool		text_result;
	int			kind;

	if (!IsA(request, SupportRequestSimplify))
		PG_RETURN_POINTER(NULL);
	simplify = (SupportRequestSimplify *) request;
	if (list_length(simplify->fcall->args) != 2)
		PG_RETURN_POINTER(NULL);
	inner = linitial(simplify->fcall->args);
	if (IsA(inner, FuncExpr))
	{
		innerid = ((FuncExpr *) inner)->funcid;
		innerargs = ((FuncExpr *) inner)->args;
	}
	else if (IsA(inner, OpExpr))
	{
		set_opfuncid((OpExpr *) inner);
		innerid = ((OpExpr *) inner)->opfuncid;
		innerargs = ((OpExpr *) inner)->args;
	}
	else
		PG_RETURN_POINTER(NULL);
	types[0] = exprType(inner);
	types[1] = TEXTARRAYOID;
	types[2] = INT4ARRAYOID;
	chain = docb_function("docb_project_chain", 3, types);
	if (OidIsValid(chain) && innerid == chain)
	{
		keys = docb_array_elements(lsecond(innerargs), TEXTOID, &valid);
		if (!valid)
			PG_RETURN_POINTER(NULL);
		kinds = docb_array_elements(lthird(innerargs), INT4OID, &valid);
		if (!valid)
			PG_RETURN_POINTER(NULL);
	}
	else
	{
		types[1] = TEXTOID;
		function = docb_function("docb_object_field", 2, types);
		if (OidIsValid(function) && innerid == function)
			kind = 1;
		else
		{
			types[1] = INT4OID;
			function = docb_function("docb_array_element", 2, types);
			if (!OidIsValid(function) || innerid != function)
				PG_RETURN_POINTER(NULL);
			kind = 2;
		}
		keys = list_make1(docb_key(lsecond(innerargs)));
		kinds = list_make1(makeConst(INT4OID, -1, InvalidOid, sizeof(int32),
									 Int32GetDatum(kind), false, true));
	}
	base = copyObject(linitial(innerargs));
	array_step = exprType(lsecond(simplify->fcall->args)) == INT4OID;
	text_result = simplify->fcall->funcresulttype == TEXTOID;
	keys = lappend(keys, docb_key(lsecond(simplify->fcall->args)));
	kinds = lappend(kinds, makeConst(INT4OID, -1, InvalidOid, sizeof(int32),
									 Int32GetDatum(array_step ? 2 : 1), false, true));
	types[1] = TEXTARRAYOID;
	types[2] = INT4ARRAYOID;
	function = docb_function(text_result ? "docb_project_chain_text" : "docb_project_chain", 3, types);
	if (!OidIsValid(function))
		PG_RETURN_POINTER(NULL);
	PG_RETURN_POINTER(makeFuncExpr(function, simplify->fcall->funcresulttype,
								   list_make3(base, docb_array(TEXTARRAYOID, TEXTOID, keys), docb_array(INT4ARRAYOID, INT4OID, kinds)),
								   InvalidOid, InvalidOid, COERCE_EXPLICIT_CALL));
}
