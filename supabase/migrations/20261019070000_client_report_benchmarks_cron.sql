-- Crons del reporte semanal y de los benchmarks (2026-10-19, pedido del dueño).
-- Se aplica DESPUÉS de 20261019000001_meeting_quality_benchmarks.sql y del
-- despliegue de la edge function client-report desde main.
--
--   · client-report-weekly: lunes 12:10 UTC (≈ 7:10 en Bogotá/Lima, 6:10 en
--     CDMX) → client-report {"action":"run_weekly"} con la service role.
--   · refresh-benchmarks: diario 06:40 UTC → public.refresh_benchmarks() en
--     SQL, sin edge function.
--
-- Igual que 20261019060000_booking_reminders_cron.sql: se reutiliza la URL del
-- proyecto y el header Authorization de un cron que ya llama a una edge
-- function en producción, y se comprueba que el token sea de la service role
-- (run_weekly responde 403 con cualquier otro). La llave nunca sale de la base:
-- ni el archivo ni el log del workflow la muestran. Sin cron de referencia
-- válido, la migración falla con el motivo y no programa nada.
--
-- Idempotente: reprograma los dos jobs si ya existían.

DO $$
DECLARE
  v_cmd     TEXT;
  v_base    TEXT;
  v_auth    TEXT;
  v_payload TEXT;
  v_role    TEXT;
BEGIN
  IF to_regnamespace('cron') IS NULL OR to_regnamespace('net') IS NULL THEN
    RAISE EXCEPTION 'client-report-weekly: pg_cron o pg_net no están instalados en este proyecto.';
  END IF;
  IF to_regprocedure('public.refresh_benchmarks()') IS NULL THEN
    RAISE EXCEPTION 'refresh-benchmarks: falta aplicar 20261019000001_meeting_quality_benchmarks.sql.';
  END IF;

  SELECT j.command INTO v_cmd
    FROM cron.job j
   WHERE j.command ~ 'https://[a-z0-9]+\.supabase\.co/functions/v1/(campaign-run|enrich-list|radar-monitor|api-webhooks|learning-loop|push-send|automation-run|linkedin-content|booking)'
     AND j.command ~ 'Bearer [A-Za-z0-9._-]{20,}'
   ORDER BY (j.command ~ '/functions/v1/campaign-run') DESC, j.jobid
   LIMIT 1;
  IF v_cmd IS NULL THEN
    RAISE EXCEPTION 'client-report-weekly: no hay un cron de referencia con la service role (campaign-run, enrich-list…).';
  END IF;

  v_base := substring(v_cmd from '(https://[a-z0-9]+\.supabase\.co)/functions/v1/');
  v_auth := substring(v_cmd from '(Bearer [A-Za-z0-9._-]{20,})');

  -- Rol del JWT (segundo segmento, base64url sin relleno).
  BEGIN
    v_payload := translate(split_part(substring(v_auth from 8), '.', 2), '-_', '+/');
    v_payload := v_payload || repeat('=', (4 - length(v_payload) % 4) % 4);
    v_role := convert_from(decode(v_payload, 'base64'), 'UTF8')::jsonb ->> 'role';
  EXCEPTION WHEN others THEN
    v_role := NULL;
  END;
  IF v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'client-report-weekly: el token del cron de referencia no es de la service role (rol: %).', coalesce(v_role, 'ilegible');
  END IF;

  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname IN ('client-report-weekly', 'refresh-benchmarks');
  PERFORM cron.schedule(
    'client-report-weekly',
    '10 12 * * 1',
    format(
      $f$SELECT net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L), body := '{"action":"run_weekly"}'::jsonb, timeout_milliseconds := 150000);$f$,
      v_base || '/functions/v1/client-report',
      v_auth));
  PERFORM cron.schedule('refresh-benchmarks', '40 6 * * *', 'SELECT public.refresh_benchmarks();');
  RAISE NOTICE 'client-report-weekly (lunes 12:10 UTC) y refresh-benchmarks (diario 06:40 UTC) programados.';
END;
$$;

SELECT jobname, schedule, active FROM cron.job WHERE jobname IN ('client-report-weekly', 'refresh-benchmarks');
