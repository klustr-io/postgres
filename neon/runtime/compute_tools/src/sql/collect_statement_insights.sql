SELECT pg_catalog.row_to_json(pss)
FROM public.pg_stat_statements pss
WHERE pss.userid NOT IN (
    SELECT oid FROM pg_catalog.pg_roles
    WHERE rolname IN ('cloud_admin', 'neon_lifecycle')
)
ORDER BY (pss.mean_exec_time + pss.mean_plan_time) DESC
LIMIT 100
