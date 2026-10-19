-- Cron de la Agenda (2026-10-19): `booking` con {"action":"tick"} cada 5
-- minutos manda la confirmación y los recordatorios de 24 h y 1 h, y marca
-- «sin respuesta» a quien no confirmó (docs/AGENDA.md). La función ya está
-- desplegada desde main (1fb56b7).
--
-- `tick` NO pasa por verify_jwt (booking va con --no-verify-jwt): compara el
-- Bearer con SUPABASE_SERVICE_ROLE_KEY tal cual. Igual que
-- 20261019041000_linkedin_content_cron.sql, se reutiliza la URL del proyecto y
-- el header Authorization de un cron que ya llama a una edge function en
-- producción, y además se comprueba que ese token sea de la service role (rol
-- del JWT): con otro token tick respondería 401 en silencio. La llave nunca
-- sale de la base: ni el archivo ni el log del workflow la muestran. Si no hay
-- un cron de referencia válido, la migración falla con el motivo y no programa
-- nada (queda el SQL comentado al final de 20261018180002).
--
-- Idempotente: reprograma el job 'booking-reminders' si ya existía.

DO $$
DECLARE
  v_cmd     TEXT;
  v_base    TEXT;
  v_auth    TEXT;
  v_payload TEXT;
  v_role    TEXT;
BEGIN
  IF to_regnamespace('cron') IS NULL OR to_regnamespace('net') IS NULL THEN
    RAISE EXCEPTION 'booking-reminders: pg_cron o pg_net no están instalados en este proyecto.';
  END IF;

  SELECT j.command INTO v_cmd
    FROM cron.job j
   WHERE j.command ~ 'https://[a-z0-9]+\.supabase\.co/functions/v1/(campaign-run|enrich-list|radar-monitor|api-webhooks|learning-loop|push-send|automation-run|linkedin-content)'
     AND j.command ~ 'Bearer [A-Za-z0-9._-]{20,}'
   ORDER BY (j.command ~ '/functions/v1/campaign-run') DESC, j.jobid
   LIMIT 1;
  IF v_cmd IS NULL THEN
    RAISE EXCEPTION 'booking-reminders: no hay un cron de referencia con la service role (campaign-run, enrich-list…).';
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
    RAISE EXCEPTION 'booking-reminders: el token del cron de referencia no es de la service role (rol: %).', coalesce(v_role, 'ilegible');
  END IF;

  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'booking-reminders';
  PERFORM cron.schedule(
    'booking-reminders',
    '*/5 * * * *',
    format(
      $f$SELECT net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L), body := '{"action":"tick"}'::jsonb, timeout_milliseconds := 120000);$f$,
      v_base || '/functions/v1/booking',
      v_auth));
  RAISE NOTICE 'booking-reminders programado cada 5 minutos.';
END;
$$;

SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'booking-reminders';
