-- Solo lectura: reportes del Hub tocados desde las 07:00 del 2026-10-24, por estado y sección (solo conteos).
SELECT status, section_key, count(*) AS n, count(DISTINCT user_id) AS usuarios, max(updated_at)::text AS ultimo
  FROM public.intelligence_hub_reports
 WHERE updated_at > '2026-10-24 06:59:00+00'
 GROUP BY status, section_key
 ORDER BY status, section_key;
