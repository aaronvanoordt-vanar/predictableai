-- Solo lectura: timeout configurado por cron (nunca el comando ni la key) + timeouts desde las 05:10.
SELECT 'job' AS kind, j.jobname AS a, j.schedule AS b,
       coalesce(substring(j.command FROM 'timeout_milliseconds\s*:=\s*([0-9]+)'), 'default') AS c
  FROM cron.job j
 WHERE j.jobname IN ('campaign-run','intel-hub-daily','intel-hub-weekly','intel-hub-monthly','intel-hub-quarterly','intel-hub-yearly')
UNION ALL
SELECT 'timeouts_since_0510', NULL, count(*)::text, NULL
  FROM net._http_response r
 WHERE r.created > '2026-10-19 05:10:00+00' AND r.status_code IS NULL
ORDER BY 1, 2;
