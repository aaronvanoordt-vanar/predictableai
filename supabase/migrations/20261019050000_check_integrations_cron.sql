-- Solo lectura: resumen por cadencia de schedule-intel-hub del 2026-10-20 07:00 (sin user_id).
SELECT r.created::text AS at, r.status_code AS status, k.key AS cadence,
       k.value->>'skipped' AS skipped, left(k.value->>'reason', 80) AS reason,
       k.value->>'users_triggered' AS users_triggered,
       (SELECT count(*) FROM jsonb_array_elements(coalesce(k.value->'outcomes', '[]'::jsonb)) o WHERE o->>'ok' = 'true') AS ok,
       (SELECT string_agg(DISTINCT coalesce(o->>'status', 'err'), ',') FROM jsonb_array_elements(coalesce(k.value->'outcomes', '[]'::jsonb)) o) AS statuses
  FROM net._http_response r
  CROSS JOIN LATERAL jsonb_each(coalesce(r.content::jsonb->'results', '{}'::jsonb)) k
 WHERE r.created BETWEEN '2026-10-20 06:59:30+00' AND '2026-10-20 07:08:00+00'
   AND r.content::text LIKE '%"ran_at"%'
UNION ALL
SELECT d.start_time::text, NULL, 'cron:' || d.status, NULL, left(d.return_message, 60), NULL, NULL, NULL
  FROM cron.job_run_details d
 WHERE d.jobid = (SELECT jobid FROM cron.job WHERE jobname = 'intel-hub-daily')
   AND d.start_time > '2026-10-20 06:59:00+00'
ORDER BY 1, 3;
