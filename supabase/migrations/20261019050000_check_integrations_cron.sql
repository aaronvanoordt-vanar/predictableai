-- Solo lectura: respuesta de schedule-intel-hub a las 07:00 (solo conteos, sin user_id) + 401/timeouts.
SELECT 'intel-hub' AS kind, r.created::text AS at, r.status_code::text AS status,
       CASE WHEN r.content::text LIKE '%"ran_at"%' THEN
         'users_triggered=' || coalesce(r.content::jsonb #>> '{results,daily,users_triggered}', '?') ||
         ' ok=' || (SELECT count(*) FROM jsonb_array_elements(coalesce(r.content::jsonb #> '{results,daily,outcomes}', '[]'::jsonb)) o WHERE o->>'ok' = 'true')::text ||
         ' no_ok=' || (SELECT count(*) FROM jsonb_array_elements(coalesce(r.content::jsonb #> '{results,daily,outcomes}', '[]'::jsonb)) o WHERE coalesce(o->>'ok','false') <> 'true')::text ||
         ' statuses=' || coalesce((SELECT string_agg(DISTINCT coalesce(o->>'status', 'err'), ',') FROM jsonb_array_elements(coalesce(r.content::jsonb #> '{results,daily,outcomes}', '[]'::jsonb)) o), '')
       ELSE left(coalesce(r.error_msg, r.content::text), 120) END AS detail
  FROM net._http_response r
 WHERE r.created BETWEEN '2026-10-19 06:59:30+00' AND '2026-10-19 07:06:00+00'
   AND (r.content::text LIKE '%"ran_at"%' OR r.status_code >= 400 OR r.status_code IS NULL)
UNION ALL
SELECT 'cron', d.start_time::text, d.status, left(d.return_message, 60)
  FROM cron.job_run_details d
 WHERE d.jobid = (SELECT jobid FROM cron.job WHERE jobname = 'intel-hub-daily')
   AND d.start_time > '2026-10-19 06:59:00+00'
UNION ALL
SELECT 'timeouts_since_0525', NULL, count(*)::text, NULL
  FROM net._http_response r
 WHERE r.created > '2026-10-19 05:25:00+00' AND r.status_code IS NULL
UNION ALL
SELECT 'http_401_since_0525', NULL, count(*)::text, NULL
  FROM net._http_response r
 WHERE r.created > '2026-10-19 05:25:00+00' AND r.status_code = 401
ORDER BY 1, 2;
