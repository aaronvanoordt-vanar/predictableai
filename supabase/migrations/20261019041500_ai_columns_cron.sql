-- Cron de las Columnas IA de Listas (2026-10-19).
--
-- Aplicar DESPUÉS de 20261017000002_list_ai_columns.sql y de desplegar la
-- edge function ai-columns (antes, el cron llamaría a una función que no
-- existe).
--
-- La service role no va en el repo: igual que 20261018233000_automation_cron,
-- se reutilizan la URL del proyecto y el header Authorization de un cron que
-- ya llama a una edge function en producción (campaign-run, enrich-list…).
-- La llave nunca sale de la base: ni el archivo ni el log del workflow la
-- muestran. Si no hay ninguno, la migración falla con el motivo y no programa
-- nada.
--
-- Idempotente: reprograma el job 'ai-columns' si ya existía.

DO $$
DECLARE
  v_cmd  TEXT;
  v_base TEXT;
  v_auth TEXT;
BEGIN
  IF to_regnamespace('cron') IS NULL OR to_regnamespace('net') IS NULL THEN
    RAISE EXCEPTION 'ai-columns: pg_cron o pg_net no están instalados en este proyecto.';
  END IF;

  SELECT j.command INTO v_cmd
    FROM cron.job j
   WHERE j.command ~ 'https://[a-z0-9]+\.supabase\.co/functions/v1/(campaign-run|enrich-list|radar-monitor|api-webhooks|learning-loop|push-send|automation-run)'
     AND j.command ~ 'Bearer [A-Za-z0-9._-]{20,}'
   ORDER BY (j.command ~ '/functions/v1/enrich-list') DESC, j.jobid
   LIMIT 1;
  IF v_cmd IS NULL THEN
    RAISE EXCEPTION 'ai-columns: no hay un cron de referencia con la service role (enrich-list, campaign-run…). Prográmalo a mano con el SQL comentado al final de 20261017000002_list_ai_columns.sql.';
  END IF;

  v_base := substring(v_cmd from '(https://[a-z0-9]+\.supabase\.co)/functions/v1/');
  v_auth := substring(v_cmd from '(Bearer [A-Za-z0-9._-]{20,})');

  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'ai-columns';
  PERFORM cron.schedule(
    'ai-columns',
    '* * * * *',
    format(
      $f$SELECT net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L), body := '{"action":"process"}'::jsonb, timeout_milliseconds := 150000);$f$,
      v_base || '/functions/v1/ai-columns',
      v_auth));
  RAISE NOTICE 'ai-columns programado cada minuto.';
END;
$$;
