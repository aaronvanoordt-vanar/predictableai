-- Solo lectura: crons activos (solo nombre, horario, función y timeout; nunca el comando ni la key) + timeouts recientes por minuto.
SELECT 'job' AS kind, j.jobname AS a, j.schedule AS b,
       coalesce(substring(j.command FROM '/functions/v1/([a-z0-9_-]+)'), '(sin http)') || ' timeout=' ||
       coalesce(substring(j.command FROM 'timeout_milliseconds\s*:=\s*([0-9]+)'), 'default') AS c
  FROM cron.job j WHERE j.active
UNION ALL
SELECT 'timeouts', date_trunc('minute', r.created)::text, count(*)::text, NULL
  FROM net._http_response r
 WHERE r.created > now() - interval '3 hours' AND r.status_code IS NULL AND r.error_msg ILIKE 'Timeout%'
 GROUP BY 2
ORDER BY 1, 2;
