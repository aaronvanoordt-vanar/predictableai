-- Solo lectura: respuesta de integrations a los ticks de integrations-sync desde las 04:44 (sin cuerpos con datos).
SELECT 'http' AS kind, r.status_code::text AS status, r.created::text AS at,
       left(coalesce(r.error_msg, r.content::text), 160) AS detail
  FROM net._http_response r
 WHERE r.created > '2026-10-19 04:44:00+00'
   AND (r.content::text LIKE '%pulled%' OR r.content::text ILIKE '%unauthor%' OR r.content::text LIKE '%acción cron%')
UNION ALL
SELECT 'cron', d.status, d.start_time::text, left(d.return_message, 80)
  FROM cron.job_run_details d
 WHERE d.jobid = (SELECT jobid FROM cron.job WHERE jobname = 'integrations-sync')
   AND d.start_time > '2026-10-19 04:44:00+00'
ORDER BY 3;
