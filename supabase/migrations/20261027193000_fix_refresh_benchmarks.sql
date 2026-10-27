-- refresh_benchmarks(): no fallar cuando todavía no hay histórico de Eleva (2026-10-27).
--
-- El INSERT del histórico agrupa con GROUPING SETS (..., ()). El conjunto vacío
-- () devuelve UNA fila de totales aunque benchmark_history_rows esté vacía, con
-- max()/sum() en NULL, y benchmark_cells.accounts es NOT NULL: la función
-- abortaba entera y tampoco guardaba los benchmarks de la plataforma (el cron
-- refresh-benchmarks falló todos los días desde que se programó).
--
-- Cambio: HAVING count(*) > 0 en el INSERT del histórico. El de la plataforma
-- no cambia (count() devuelve 0, nunca NULL). Idempotente.

CREATE OR REPLACE FUNCTION public.refresh_benchmarks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  DELETE FROM public.benchmark_cells;

  WITH accepted AS (
    SELECT DISTINCT e.enrollment_id
      FROM public.campaign_events e
     WHERE e.type IN ('sent', 'connection_sent')
       AND e.created_at >= now() - interval '365 days'
       AND e.enrollment_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.campaign_events f
          WHERE f.type = 'failed'
            AND e.provider_message_id IS NOT NULL
            AND f.provider_message_id = e.provider_message_id
       )
  ), leads AS (
    SELECT m.id AS member_id,
           m.user_id,
           lower(btrim(COALESCE(m.country, ''))) AS country,
           lower(btrim(COALESCE(m.snapshot->'organization'->>'industry', ''))) AS industry,
           m.contact_status,
           bool_or(en.replied_at IS NOT NULL OR en.status = 'replied') AS replied
      FROM accepted a
      JOIN public.campaign_enrollments en ON en.id = a.enrollment_id
      JOIN public.prospect_list_members m ON m.id = en.member_id
     GROUP BY m.id
  ), scored AS (
    SELECT l.*,
           (lm.member_id IS NOT NULL) AS meeting,
           (lm.member_id IS NOT NULL AND (
              lm.client_verdict IN ('held', 'qualified', 'not_qualified')
              OR (lm.client_verdict IS NULL AND lm.held_at IS NOT NULL AND l.contact_status <> 'no_show'))) AS attended,
           (lm.member_id IS NOT NULL AND (
              lm.client_verdict = 'no_show'
              OR (lm.client_verdict IS NULL AND l.contact_status = 'no_show'))) AS no_show,
           (lm.client_verdict = 'qualified') AS qualified,
           (lm.client_verdict IN ('qualified', 'not_qualified')) AS judged
      FROM leads l
      LEFT JOIN public.lead_meetings lm ON lm.member_id = l.member_id
  )
  INSERT INTO public.benchmark_cells (source, country, industry, accounts, contacts, replied, meetings, attended, no_show, qualified, judged, computed_at)
  SELECT 'platform',
         CASE WHEN GROUPING(country) = 1 THEN '' ELSE country END,
         CASE WHEN GROUPING(industry) = 1 THEN '' ELSE industry END,
         count(DISTINCT user_id), count(*),
         count(*) FILTER (WHERE replied), count(*) FILTER (WHERE meeting),
         count(*) FILTER (WHERE attended), count(*) FILTER (WHERE no_show),
         count(*) FILTER (WHERE qualified), count(*) FILTER (WHERE judged),
         now()
    FROM scored
   GROUP BY GROUPING SETS ((country, industry), (country), (industry), ())
  HAVING (GROUPING(country) = 1 OR country <> '') AND (GROUPING(industry) = 1 OR industry <> '');

  -- Histórico importado: «accounts» = el máximo de clientes declarado en la
  -- celda (cota inferior de clientes distintos; sumar meses los contaría dos veces).
  INSERT INTO public.benchmark_cells (source, country, industry, accounts, contacts, replied, meetings, attended, no_show, qualified, judged, computed_at)
  SELECT 'eleva',
         CASE WHEN GROUPING(country) = 1 THEN '' ELSE country END,
         CASE WHEN GROUPING(industry) = 1 THEN '' ELSE industry END,
         max(clients), sum(contacts), sum(replied), sum(meetings_booked),
         sum(meetings_held), sum(no_shows),
         COALESCE(sum(meetings_qualified), 0),
         COALESCE(sum(meetings_held) FILTER (WHERE meetings_qualified IS NOT NULL), 0),
         now()
    FROM public.benchmark_history_rows
   GROUP BY GROUPING SETS ((country, industry), (country), (industry), ())
  HAVING count(*) > 0;

  SELECT count(*) INTO n FROM public.benchmark_cells;
  RETURN n;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refresh_benchmarks() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_benchmarks() TO service_role;
