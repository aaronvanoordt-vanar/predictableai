-- Cron del motor de Automatizaciones (2026-10-18).
--
-- Aplicar DESPUÉS de desplegar la edge function automation-run (antes, el
-- cron llamaría a una función que no existe).
--
-- El cron lleva la service role, y la service role no va en el repo. En
-- lugar de pegarla, se reutiliza la URL del proyecto y el header
-- Authorization de un cron que ya llama a una edge function en producción
-- (campaign-run, enrich-list, radar-monitor, api-webhooks…). Así la llave
-- nunca sale de la base: ni el archivo ni el log del workflow la muestran.
-- Si no hay ninguno, la migración falla con el motivo y no programa nada.
--
-- Idempotente: reprograma el job 'automation-run' si ya existía.

DO $$
DECLARE
  v_cmd  TEXT;
  v_base TEXT;
  v_auth TEXT;
BEGIN
  IF to_regnamespace('cron') IS NULL OR to_regnamespace('net') IS NULL THEN
    RAISE EXCEPTION 'automation-run: pg_cron o pg_net no están instalados en este proyecto.';
  END IF;

  SELECT j.command INTO v_cmd
    FROM cron.job j
   WHERE j.command ~ 'https://[a-z0-9]+\.supabase\.co/functions/v1/(campaign-run|enrich-list|radar-monitor|api-webhooks|learning-loop|push-send)'
     AND j.command ~ 'Bearer [A-Za-z0-9._-]{20,}'
   ORDER BY (j.command ~ '/functions/v1/campaign-run') DESC, j.jobid
   LIMIT 1;
  IF v_cmd IS NULL THEN
    RAISE EXCEPTION 'automation-run: no hay un cron de referencia con la service role (campaign-run, enrich-list…). Prográmalo a mano con el SQL comentado al final de 20261018180008_automations.sql.';
  END IF;

  v_base := substring(v_cmd from '(https://[a-z0-9]+\.supabase\.co)/functions/v1/');
  v_auth := substring(v_cmd from '(Bearer [A-Za-z0-9._-]{20,})');

  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'automation-run';
  PERFORM cron.schedule(
    'automation-run',
    '* * * * *',
    format(
      $f$SELECT net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L), body := '{"action":"tick"}'::jsonb, timeout_milliseconds := 150000);$f$,
      v_base || '/functions/v1/automation-run',
      v_auth));
  RAISE NOTICE 'automation-run programado cada minuto.';
END;
$$;
