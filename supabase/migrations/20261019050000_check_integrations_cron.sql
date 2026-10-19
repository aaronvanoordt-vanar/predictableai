-- Solo lectura: primera corrida del cron integrations-sync (no lee `command`, que lleva la key).
SELECT 'cron' AS kind, d.status AS status, d.start_time::text AS at, left(d.return_message, 200) AS detail
  FROM cron.job_run_details d
 WHERE d.jobid = (SELECT jobid FROM cron.job WHERE jobname = 'integrations-sync')
UNION ALL
SELECT 'http', r.status_code::text, r.created::text, left(coalesce(r.error_msg, r.content::text), 200)
  FROM net._http_response r
 WHERE r.created > now() - interval '45 minutes' AND r.content::text LIKE '%"pulled"%'
UNION ALL
SELECT 'log', s.status, s.created_at::text, s.provider || ' ' || s.action || ' ' || s.counts::text
  FROM public.integration_sync_log s
 WHERE s.created_at > now() - interval '45 minutes'
UNION ALL
SELECT 'connections', provider, count(*)::text, NULL
  FROM public.integration_connections GROUP BY provider
ORDER BY 1, 3 DESC;
