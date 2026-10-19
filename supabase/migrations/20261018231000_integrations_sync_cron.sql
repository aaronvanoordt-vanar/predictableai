-- ═══════════════════════════════════════════════════════════════════════════
-- Cron `integrations-sync` (2026-10-18): cada 15 min la edge function
-- `integrations` con `{"action":"cron"}` (HubSpot de vuelta + envío automático
-- de leads nuevos de las listas elegidas). Ver docs/INTEGRACIONES.md.
--
-- La función se autentica con la service role key, que NO puede ir en este
-- archivo (el repo es público). Los crons que ya llaman a edge functions
-- (enrich-list, campaign-run, radar-monitor…) se programaron a mano con la URL
-- del proyecto y el header `Authorization: Bearer <service role>` dentro del
-- texto del job. Esta migración toma esos dos datos de un job existente y
-- programa el nuevo con ellos: la key no sale de la base, no se imprime ni se
-- devuelve. Si no encuentra ninguno, no programa nada y lo avisa (programarlo
-- a mano con el SQL comentado al final de 20261018230000).
--
-- Idempotente: reemplaza el job si ya existe. Se aplica DESPUÉS de desplegar
-- `integrations` con la acción `cron` (si no, el job recibe 400 hasta el
-- despliegue, sin efecto).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  src     TEXT;
  base    TEXT;
  bearer  TEXT;
  cmd     TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE 'integrations-sync: falta pg_cron o pg_net; no se programó.';
    RETURN;
  END IF;

  -- Un job existente que ya llama a una edge function con la service role.
  SELECT j.command INTO src
    FROM cron.job j
   WHERE j.command ~ 'https://[a-z0-9]+\.supabase\.co/functions/v1/'
     AND j.command ~ '''Authorization''\s*,\s*''Bearer [^'']+'''
     AND j.jobname <> 'integrations-sync'
   ORDER BY (j.jobname IN ('campaign-run', 'enrich-list', 'radar-monitor', 'api-webhooks')) DESC, j.jobid
   LIMIT 1;

  IF src IS NULL THEN
    RAISE NOTICE 'integrations-sync: no hay un cron con la service role del que copiar el header; prográmalo a mano (SQL al final de 20261018230000_crm_integrations_latam.sql).';
    RETURN;
  END IF;

  base   := substring(src FROM '(https://[a-z0-9]+\.supabase\.co)/functions/v1/');
  bearer := substring(src FROM '''Authorization''\s*,\s*''(Bearer [^'']+)''');
  IF base IS NULL OR bearer IS NULL THEN
    RAISE NOTICE 'integrations-sync: no se pudo leer la URL o el header del cron existente; prográmalo a mano.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'integrations-sync') THEN
    PERFORM cron.unschedule('integrations-sync');
  END IF;

  cmd := format(
    $cmd$SELECT net.http_post(
      url     := %L,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
      body    := '{"action":"cron"}'::jsonb,
      timeout_milliseconds := 150000);$cmd$,
    base || '/functions/v1/integrations', bearer);

  PERFORM cron.schedule('integrations-sync', '*/15 * * * *', cmd);
  RAISE NOTICE 'integrations-sync: programado cada 15 min.';
END $$;
