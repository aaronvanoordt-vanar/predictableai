-- ═══════════════════════════════════════════════════════════════════════════
-- Timeout de pg_net para campaign-run e intel-hub-* (2026-10-19).
--
-- Esos jobs se programaron a mano sin `timeout_milliseconds`, así que pg_net
-- deja de esperar a los 5 s (su default) y deja «Timeout of 5000 ms reached»
-- en net._http_response aunque la función siga trabajando: campaign-run lo
-- hacía en cualquier minuto en que tardaba más de 5 s. Los demás crons de
-- edge functions ya usan 120–150 s.
--
-- Rearma el comando de cada job con la misma URL, el mismo header y el mismo
-- body que ya tiene, y agrega `timeout_milliseconds := 150000`. La key no sale
-- de la base (se lee del job existente, como 20261018231000) ni se imprime.
-- cron.alter_job conserva el jobid y el horario. Un job que ya tiene timeout,
-- que no existe o cuya llamada no tiene la forma esperada se deja como está
-- con un NOTICE. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  j       RECORD;
  url     TEXT;
  bearer  TEXT;
  body    TEXT;
  cmd     TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE 'cron-timeouts: falta pg_cron o pg_net; no se cambió nada.';
    RETURN;
  END IF;

  FOR j IN
    SELECT jobid, jobname, command FROM cron.job
     WHERE jobname IN ('campaign-run', 'intel-hub-daily', 'intel-hub-weekly',
                       'intel-hub-monthly', 'intel-hub-quarterly', 'intel-hub-yearly')
  LOOP
    IF j.command ~ 'timeout_milliseconds' THEN
      RAISE NOTICE 'cron-timeouts: % ya tiene timeout; sin cambios.', j.jobname;
      CONTINUE;
    END IF;

    url    := substring(j.command FROM 'url\s*:=\s*''(https://[a-z0-9]+\.supabase\.co/functions/v1/[a-z0-9_-]+)''');
    bearer := substring(j.command FROM '''Authorization''\s*,\s*''(Bearer [^'']+)''');
    body   := substring(j.command FROM 'body\s*:=\s*''([^'']*)''');

    IF url IS NULL OR bearer IS NULL THEN
      RAISE NOTICE 'cron-timeouts: no se pudo leer la URL o el header de %; sin cambios.', j.jobname;
      CONTINUE;
    END IF;

    cmd := format(
      $cmd$SELECT net.http_post(
      url     := %L,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
      body    := %L::jsonb,
      timeout_milliseconds := 150000);$cmd$,
      url, bearer, coalesce(nullif(body, ''), '{}'));

    PERFORM cron.alter_job(job_id := j.jobid, command := cmd);
    RAISE NOTICE 'cron-timeouts: % con timeout de 150 s.', j.jobname;
  END LOOP;
END $$;
