-- Solo lectura: respuestas HTTP alrededor de los ticks de integrations-sync (sin cuerpos con datos).
SELECT 'http' AS kind, r.status_code::text AS status, r.created::text AS at,
       CASE WHEN r.status_code >= 400 OR r.content::text LIKE '%pulled%' OR r.content::text ILIKE '%unauthor%'
            THEN left(coalesce(r.error_msg, r.content::text), 160) ELSE NULL END AS detail
  FROM net._http_response r
 WHERE (r.created BETWEEN '2026-10-19 04:29:59+00' AND '2026-10-19 04:32:40+00')
    OR (r.created BETWEEN '2026-10-19 04:15:00+00' AND '2026-10-19 04:17:40+00')
UNION ALL
SELECT 'connections', 'total', count(*)::text, NULL FROM public.integration_connections
UNION ALL
SELECT 'retention', 'oldest', min(created)::text, count(*)::text FROM net._http_response
ORDER BY 1, 3;
