-- Solo lectura: resumen por cadencia de las respuestas de schedule-intel-hub de las 07:00 (sin user_id).
SELECT r.created::text AS at, r.status_code AS status, k.key AS cadence,
       k.value->>'skipped' AS skipped, left(k.value->>'reason', 80) AS reason,
       k.value->>'users_triggered' AS users_triggered,
       (SELECT count(*) FROM jsonb_array_elements(coalesce(k.value->'outcomes', '[]'::jsonb)) o WHERE o->>'ok' = 'true') AS ok,
       (SELECT string_agg(DISTINCT coalesce(o->>'status', 'err'), ',') FROM jsonb_array_elements(coalesce(k.value->'outcomes', '[]'::jsonb)) o) AS statuses
  FROM net._http_response r
  CROSS JOIN LATERAL jsonb_each(coalesce(r.content::jsonb->'results', '{}'::jsonb)) k
 WHERE r.created BETWEEN '2026-10-19 06:59:30+00' AND '2026-10-19 07:06:00+00'
   AND r.content::text LIKE '%"ran_at"%'
ORDER BY 1, 3;
