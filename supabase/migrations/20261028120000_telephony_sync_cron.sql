-- Cron de Telefonía: telephony-sync cada 10 minutos (2026-10-28).
--
-- Sincroniza las llamadas de CloudTalk y devuelve las reservas de créditos de
-- llamadas que quedaron huérfanas (telephony {"action":"sync_all"}). Antes se
-- programaba a mano con el SQL comentado al final de 20261018180009_telephony.sql,
-- pegando la service role en el editor.
--
-- Igual que 20261018233000_automation_cron.sql: la service role no va en el
-- repo. Se reutiliza la URL del proyecto y el header Authorization de un cron
-- que ya llama a una edge function en producción. Si no hay ninguno, la
-- migración falla con el motivo y no programa nada.
--
-- Idempotente: reprograma el job 'telephony-sync' si ya existía.

DO $$
DECLARE
  v_cmd  TEXT;
  v_base TEXT;
  v_auth TEXT;
BEGIN
  IF to_regnamespace('cron') IS NULL OR to_regnamespace('net') IS NULL THEN
    RAISE EXCEPTION 'telephony-sync: pg_cron o pg_net no están instalados en este proyecto.';
  END IF;

  SELECT j.command INTO v_cmd
    FROM cron.job j
   WHERE j.command ~ 'https://[a-z0-9]+\.supabase\.co/functions/v1/(campaign-run|enrich-list|radar-monitor|api-webhooks|learning-loop|push-send|automation-run)'
     AND j.command ~ 'Bearer [A-Za-z0-9._-]{20,}'
   ORDER BY (j.command ~ '/functions/v1/campaign-run') DESC, j.jobid
   LIMIT 1;
  IF v_cmd IS NULL THEN
    RAISE EXCEPTION 'telephony-sync: no hay un cron de referencia con la service role (campaign-run, enrich-list…). Prográmalo a mano con el SQL comentado al final de 20261018180009_telephony.sql.';
  END IF;

  v_base := substring(v_cmd from '(https://[a-z0-9]+\.supabase\.co)/functions/v1/');
  v_auth := substring(v_cmd from '(Bearer [A-Za-z0-9._-]{20,})');

  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'telephony-sync';
  PERFORM cron.schedule(
    'telephony-sync',
    '*/10 * * * *',
    format(
      $f$SELECT net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L), body := '{"action":"sync_all"}'::jsonb, timeout_milliseconds := 150000);$f$,
      v_base || '/functions/v1/telephony',
      v_auth));
  RAISE NOTICE 'telephony-sync programado cada 10 minutos.';
END;
$$;
