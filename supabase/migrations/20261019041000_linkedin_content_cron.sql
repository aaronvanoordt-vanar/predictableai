-- Cron de Contenido en LinkedIn (2026-10-19): `linkedin-content` con
-- {"action":"run_due"} cada 5 minutos publica los posts programados con
-- publish_mode = 'api' cuya hora llegó y refresca las métricas de los
-- publicados por API (docs/LINKEDIN_CONTENT.md).
--
-- Aplicar DESPUÉS de desplegar la edge function linkedin-content (desplegada
-- el 2026-10-19 desde main, e5d34e6).
--
-- El cron lleva la service role, y la service role no va en el repo: igual
-- que 20261018233000_automation_cron.sql, se reutiliza la URL del proyecto y
-- el header Authorization de un cron que ya llama a una edge function en
-- producción. La llave nunca sale de la base: ni el archivo ni el log del
-- workflow la muestran. Si no hay ninguno, la migración falla con el motivo y
-- no programa nada.
--
-- Sin los secrets de LinkedIn, run_due no encuentra nada que publicar (solo
-- hay posts manuales) y termina en milisegundos.
--
-- Idempotente: reprograma el job 'linkedin-content' si ya existía.

DO $$
DECLARE
  v_cmd  TEXT;
  v_base TEXT;
  v_auth TEXT;
BEGIN
  IF to_regnamespace('cron') IS NULL OR to_regnamespace('net') IS NULL THEN
    RAISE EXCEPTION 'linkedin-content: pg_cron o pg_net no están instalados en este proyecto.';
  END IF;

  SELECT j.command INTO v_cmd
    FROM cron.job j
   WHERE j.command ~ 'https://[a-z0-9]+\.supabase\.co/functions/v1/(campaign-run|enrich-list|radar-monitor|api-webhooks|learning-loop|push-send|automation-run)'
     AND j.command ~ 'Bearer [A-Za-z0-9._-]{20,}'
   ORDER BY (j.command ~ '/functions/v1/campaign-run') DESC, j.jobid
   LIMIT 1;
  IF v_cmd IS NULL THEN
    RAISE EXCEPTION 'linkedin-content: no hay un cron de referencia con la service role (campaign-run, enrich-list…). Prográmalo a mano con el SQL comentado al final de 20261018180010_linkedin_content.sql.';
  END IF;

  v_base := substring(v_cmd from '(https://[a-z0-9]+\.supabase\.co)/functions/v1/');
  v_auth := substring(v_cmd from '(Bearer [A-Za-z0-9._-]{20,})');

  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'linkedin-content';
  PERFORM cron.schedule(
    'linkedin-content',
    '*/5 * * * *',
    format(
      $f$SELECT net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L), body := '{"action":"run_due"}'::jsonb, timeout_milliseconds := 120000);$f$,
      v_base || '/functions/v1/linkedin-content',
      v_auth));
  RAISE NOTICE 'linkedin-content programado cada 5 minutos.';
END;
$$;
