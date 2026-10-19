-- Solo lectura: 401 por minuto desde las 04:30 y corridas del cron booking-reminders (sin comandos ni cuerpos con datos).
SELECT 'http' AS kind, date_trunc('minute', r.created)::text AS at, r.status_code::text AS status, count(*)::text AS n
  FROM net._http_response r
 WHERE r.created > '2026-10-19 04:30:00+00' AND r.status_code = 401
 GROUP BY 2, 3
UNION ALL
SELECT 'http_ok_since_0454', NULL, r.status_code::text, count(*)::text
  FROM net._http_response r
 WHERE r.created > '2026-10-19 04:54:00+00'
 GROUP BY 3
UNION ALL
SELECT 'booking-reminders', d.start_time::text, d.status, left(d.return_message, 60)
  FROM cron.job_run_details d
 WHERE d.jobid = (SELECT jobid FROM cron.job WHERE jobname = 'booking-reminders')
   AND d.start_time > '2026-10-19 04:45:00+00'
UNION ALL
SELECT 'no_status', r.created::text, NULL, left(r.error_msg, 80)
  FROM net._http_response r
 WHERE r.created > '2026-10-19 04:54:00+00' AND r.status_code IS NULL
ORDER BY 1, 2;
