/* Native storage is supplied by this PostgreSQL build, not a JSONB wrapper. */
\echo Use "CREATE EXTENSION docb" to load this file. \quit

CREATE TYPE docb;
CREATE FUNCTION docb_in(cstring) RETURNS docb
  AS 'jsonb_in' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_out(docb) RETURNS cstring
  AS 'jsonb_out' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_recv(internal) RETURNS docb
  AS 'jsonb_recv' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_send(docb) RETURNS bytea
  AS 'jsonb_send' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE TYPE docb (
  INPUT = docb_in, OUTPUT = docb_out, RECEIVE = docb_recv, SEND = docb_send,
  INTERNALLENGTH = variable, ALIGNMENT = int4, STORAGE = extended,
  SUBSCRIPT = jsonb_subscript_handler
);

CREATE FUNCTION docb(jsonb) RETURNS docb
  AS 'MODULE_PATHNAME', 'docb_cast' LANGUAGE C IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_to_jsonb(docb) RETURNS jsonb
  AS 'MODULE_PATHNAME', 'docb_cast' LANGUAGE C IMMUTABLE STRICT PARALLEL SAFE;
CREATE CAST (jsonb AS docb) WITH FUNCTION docb(jsonb) AS ASSIGNMENT;
CREATE CAST (docb AS jsonb) WITH FUNCTION docb_to_jsonb(docb) AS IMPLICIT;

CREATE FUNCTION docb_object_field(docb, text) RETURNS docb
  AS 'MODULE_PATHNAME', 'docb_field_sql' LANGUAGE C IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_object_field_text(docb, text) RETURNS text
  AS 'MODULE_PATHNAME', 'docb_field_text_sql' LANGUAGE C IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_array_element(docb, int4) RETURNS docb
  AS 'MODULE_PATHNAME', 'docb_element_sql' LANGUAGE C IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_array_element_text(docb, int4) RETURNS text
  AS 'MODULE_PATHNAME', 'docb_element_text_sql' LANGUAGE C IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_extract_path(docb, VARIADIC text[]) RETURNS docb
  AS 'MODULE_PATHNAME', 'docb_path_sql' LANGUAGE C IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_extract_path_text(docb, VARIADIC text[]) RETURNS text
  AS 'MODULE_PATHNAME', 'docb_path_text_sql' LANGUAGE C IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_project_chain(docb, text[], int4[]) RETURNS docb
  AS 'MODULE_PATHNAME', 'docb_chain_sql' LANGUAGE C IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_project_chain_text(docb, text[], int4[]) RETURNS text
  AS 'MODULE_PATHNAME', 'docb_chain_text_sql' LANGUAGE C IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_operator_support(internal) RETURNS internal
  AS 'MODULE_PATHNAME', 'docb_operator_support' LANGUAGE C IMMUTABLE STRICT PARALLEL SAFE;
ALTER FUNCTION docb_object_field(docb, text) SUPPORT docb_operator_support;
ALTER FUNCTION docb_object_field_text(docb, text) SUPPORT docb_operator_support;
ALTER FUNCTION docb_array_element(docb, int4) SUPPORT docb_operator_support;
ALTER FUNCTION docb_array_element_text(docb, int4) SUPPORT docb_operator_support;
CREATE OPERATOR -> (LEFTARG = docb, RIGHTARG = text, FUNCTION = docb_object_field);
CREATE OPERATOR ->> (LEFTARG = docb, RIGHTARG = text, FUNCTION = docb_object_field_text);
CREATE OPERATOR -> (LEFTARG = docb, RIGHTARG = int4, FUNCTION = docb_array_element);
CREATE OPERATOR ->> (LEFTARG = docb, RIGHTARG = int4, FUNCTION = docb_array_element_text);
CREATE OPERATOR #> (LEFTARG = docb, RIGHTARG = text[], FUNCTION = docb_extract_path);
CREATE OPERATOR #>> (LEFTARG = docb, RIGHTARG = text[], FUNCTION = docb_extract_path_text);

CREATE FUNCTION docb_eq(docb, docb) RETURNS boolean
  AS 'jsonb_eq' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_contains(docb, docb) RETURNS boolean
  AS 'jsonb_contains' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_exists(docb, text) RETURNS boolean
  AS 'jsonb_exists' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_concat(docb, docb) RETURNS docb
  AS 'jsonb_concat' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE OPERATOR = (LEFTARG = docb, RIGHTARG = docb, FUNCTION = docb_eq, COMMUTATOR = =,
  HASHES, MERGES, RESTRICT = eqsel, JOIN = eqjoinsel);
CREATE OPERATOR @> (LEFTARG = docb, RIGHTARG = docb, FUNCTION = docb_contains);
CREATE OPERATOR ? (LEFTARG = docb, RIGHTARG = text, FUNCTION = docb_exists);
CREATE OPERATOR || (LEFTARG = docb, RIGHTARG = docb, FUNCTION = docb_concat);

CREATE FUNCTION gin_extract_docb_path(docb, internal, internal) RETURNS internal
  AS 'gin_extract_jsonb_path' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION gin_extract_docb_query_path(docb, internal, int2, internal, internal, internal, internal) RETURNS internal
  AS 'gin_extract_jsonb_query_path' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION gin_consistent_docb_path(internal, int2, docb, int4, internal, internal, internal, internal) RETURNS boolean
  AS 'gin_consistent_jsonb_path' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION gin_triconsistent_docb_path(internal, int2, docb, int4, internal, internal, internal) RETURNS "char"
  AS 'gin_triconsistent_jsonb_path' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE OPERATOR CLASS docb_path_ops FOR TYPE docb USING gin AS
  OPERATOR 7 @> (docb, docb),
  FUNCTION 1 btint4cmp(int4, int4),
  FUNCTION 2 gin_extract_docb_path(docb, internal, internal),
  FUNCTION 3 gin_extract_docb_query_path(docb, internal, int2, internal, internal, internal, internal),
  FUNCTION 4 gin_consistent_docb_path(internal, int2, docb, int4, internal, internal, internal, internal),
  FUNCTION 6 gin_triconsistent_docb_path(internal, int2, docb, int4, internal, internal, internal),
  STORAGE int4;

CREATE FUNCTION docb_ne(docb, docb) RETURNS boolean
  AS 'jsonb_ne' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_lt(docb, docb) RETURNS boolean
  AS 'jsonb_lt' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_le(docb, docb) RETURNS boolean
  AS 'jsonb_le' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_gt(docb, docb) RETURNS boolean
  AS 'jsonb_gt' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_ge(docb, docb) RETURNS boolean
  AS 'jsonb_ge' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_cmp(docb, docb) RETURNS int4
  AS 'jsonb_cmp' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_hash(docb) RETURNS int4
  AS 'jsonb_hash' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_hash_extended(docb, int8) RETURNS int8
  AS 'jsonb_hash_extended' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE OPERATOR <> (LEFTARG = docb, RIGHTARG = docb, FUNCTION = docb_ne, COMMUTATOR = <>);
CREATE OPERATOR < (LEFTARG = docb, RIGHTARG = docb, FUNCTION = docb_lt, COMMUTATOR = >);
CREATE OPERATOR <= (LEFTARG = docb, RIGHTARG = docb, FUNCTION = docb_le, COMMUTATOR = >=);
CREATE OPERATOR > (LEFTARG = docb, RIGHTARG = docb, FUNCTION = docb_gt, COMMUTATOR = <);
CREATE OPERATOR >= (LEFTARG = docb, RIGHTARG = docb, FUNCTION = docb_ge, COMMUTATOR = <=);
CREATE OPERATOR CLASS docb_ops DEFAULT FOR TYPE docb USING btree AS
  OPERATOR 1 <, OPERATOR 2 <=, OPERATOR 3 =, OPERATOR 4 >=, OPERATOR 5 >,
  FUNCTION 1 docb_cmp(docb, docb);
CREATE OPERATOR CLASS docb_ops DEFAULT FOR TYPE docb USING hash AS
  OPERATOR 1 =,
  FUNCTION 1 docb_hash(docb), FUNCTION 2 docb_hash_extended(docb, int8);

CREATE FUNCTION docb_exists_any(docb, text[]) RETURNS boolean
  AS 'jsonb_exists_any' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_exists_all(docb, text[]) RETURNS boolean
  AS 'jsonb_exists_all' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_contained(docb, docb) RETURNS boolean
  AS 'jsonb_contained' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_path_exists_op(docb, jsonpath) RETURNS boolean
  AS 'jsonb_path_exists_opr' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_path_match_op(docb, jsonpath) RETURNS boolean
  AS 'jsonb_path_match_opr' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE OPERATOR ?| (LEFTARG = docb, RIGHTARG = text[], FUNCTION = docb_exists_any);
CREATE OPERATOR ?& (LEFTARG = docb, RIGHTARG = text[], FUNCTION = docb_exists_all);
CREATE OPERATOR <@ (LEFTARG = docb, RIGHTARG = docb, FUNCTION = docb_contained);
CREATE OPERATOR @? (LEFTARG = docb, RIGHTARG = jsonpath, FUNCTION = docb_path_exists_op);
CREATE OPERATOR @@ (LEFTARG = docb, RIGHTARG = jsonpath, FUNCTION = docb_path_match_op);
ALTER OPERATOR FAMILY docb_path_ops USING gin ADD
  OPERATOR 15 @? (docb, jsonpath), OPERATOR 16 @@ (docb, jsonpath);

CREATE FUNCTION gin_extract_docb(docb, internal, internal) RETURNS internal
  AS 'gin_extract_jsonb' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION gin_extract_docb_query(docb, internal, int2, internal, internal, internal, internal) RETURNS internal
  AS 'gin_extract_jsonb_query' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION gin_consistent_docb(internal, int2, docb, int4, internal, internal, internal, internal) RETURNS boolean
  AS 'gin_consistent_jsonb' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION gin_triconsistent_docb(internal, int2, docb, int4, internal, internal, internal) RETURNS "char"
  AS 'gin_triconsistent_jsonb' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE OPERATOR CLASS docb_ops DEFAULT FOR TYPE docb USING gin AS
  OPERATOR 7 @> (docb, docb), OPERATOR 9 ? (docb, text),
  OPERATOR 10 ?| (docb, text[]), OPERATOR 11 ?& (docb, text[]),
  OPERATOR 15 @? (docb, jsonpath), OPERATOR 16 @@ (docb, jsonpath),
  FUNCTION 1 gin_compare_jsonb(text, text),
  FUNCTION 2 gin_extract_docb(docb, internal, internal),
  FUNCTION 3 gin_extract_docb_query(docb, internal, int2, internal, internal, internal, internal),
  FUNCTION 4 gin_consistent_docb(internal, int2, docb, int4, internal, internal, internal, internal),
  FUNCTION 6 gin_triconsistent_docb(internal, int2, docb, int4, internal, internal, internal),
  STORAGE text;

CREATE FUNCTION docb_delete(docb, text) RETURNS docb
  AS 'jsonb_delete' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_delete(docb, int4) RETURNS docb
  AS 'jsonb_delete_idx' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_delete(docb, text[]) RETURNS docb
  AS 'jsonb_delete_array' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE FUNCTION docb_delete_path(docb, text[]) RETURNS docb
  AS 'jsonb_delete_path' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;
CREATE OPERATOR - (LEFTARG = docb, RIGHTARG = text, FUNCTION = docb_delete);
CREATE OPERATOR - (LEFTARG = docb, RIGHTARG = int4, FUNCTION = docb_delete);
CREATE OPERATOR - (LEFTARG = docb, RIGHTARG = text[], FUNCTION = docb_delete);
CREATE OPERATOR #- (LEFTARG = docb, RIGHTARG = text[], FUNCTION = docb_delete_path);
