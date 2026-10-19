-- ═══════════════════════════════════════════════════════════════════════════
-- Cron de mailbox-sync (buzones propios del canal Email) — 2026-10-18
--
-- mailbox-sync lee cada 5 minutos la bandeja de entrada de los buzones
-- propios: respuestas (detienen la cadencia), rebotes, bajas, el DNS de los
-- dominios y las métricas de warm-up. Ver 20261018180004_own_mailboxes.sql y
-- docs/EMAIL_PROPIO.md.
--
-- La función exige la service role, y esa key NO puede ir en el repo
-- (es público). Los crons HTTP de producción (campaign-run, enrich-list…)
-- se programaron a mano con la key dentro de su comando, así que esta
-- migración copia la URL del proyecto y el encabezado Authorization del cron
-- de campaign-run que ya existe en la base (o, si no está, de cualquier otro
-- cron de edge functions con un Bearer literal). La key nunca pasa por el
-- repo ni por la salida de la migración: lo único que se devuelve es el
-- nombre, el horario y el estado del job.
--
-- Si no hay ningún cron del que copiar, falla con un mensaje claro y no
-- programa nada (entonces se usa el SQL comentado de 20261018180004).
-- Idempotente: cron.schedule con el mismo nombre reemplaza el job.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_src  text;
  v_base text;
  v_auth text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE EXCEPTION 'Faltan las extensiones pg_cron o pg_net: no se puede programar mailbox-sync.';
  END IF;

  SELECT command INTO v_src FROM cron.job
   WHERE command ~ '/functions/v1/campaign-run' AND command ~ 'Bearer [A-Za-z0-9._-]+'
   ORDER BY jobid LIMIT 1;
  IF v_src IS NULL THEN
    SELECT command INTO v_src FROM cron.job
     WHERE command ~ '/functions/v1/' AND command ~ 'Bearer [A-Za-z0-9._-]+'
     ORDER BY jobid LIMIT 1;
  END IF;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'No hay ningún cron de edge functions con autorización del que copiar: programa mailbox-sync a mano (SQL comentado en 20261018180004_own_mailboxes.sql).';
  END IF;

  v_base := substring(v_src from '(https://[a-z0-9]+\.supabase\.co)/functions/v1/');
  v_auth := substring(v_src from '(Bearer [A-Za-z0-9._-]+)');
  IF v_base IS NULL OR v_auth IS NULL THEN
    RAISE EXCEPTION 'No se pudo leer la URL del proyecto o la autorización del cron existente.';
  END IF;

  PERFORM cron.schedule(
    'mailbox-sync',
    '*/5 * * * *',
    format(
      $cmd$SELECT net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 150000);$cmd$,
      v_base || '/functions/v1/mailbox-sync',
      v_auth
    )
  );
END $$;

-- Lo único que se muestra: que el job existe y su horario (nunca el comando).
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'mailbox-sync';
