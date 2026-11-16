-- Aviso de reunión del AI Sales Coach con Predictable cerrado (2026-11-16).
--
-- Una fila por usuario con el aviso encendido: cuánto antes avisar, las
-- reuniones de las próximas 24 h leídas de su calendario (caché de 10 min) y
-- qué avisos ya salieron. La escribe SOLO la service role (edge function
-- `integrations`: acciones meeting_alerts_set y meeting_alerts); el usuario
-- solo la lee.
--
-- Aplicar DESPUÉS de desplegar `integrations` (antes, el cron llamaría a una
-- acción que no existe y solo recibiría un 400).
--
-- La service role no va en el repo: igual que 20261019041500, se reutilizan la
-- URL del proyecto y el Authorization de un cron que ya llama a una edge
-- function. Idempotente.

CREATE TABLE IF NOT EXISTS public.coach_meeting_alerts (
  user_id       UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  lead_minutes  INT NOT NULL DEFAULT 2 CHECK (lead_minutes IN (1, 2, 5, 10)),
  events        JSONB NOT NULL DEFAULT '[]'::jsonb,
  sent          JSONB NOT NULL DEFAULT '{}'::jsonb,
  synced_at     TIMESTAMPTZ,
  last_error    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.coach_meeting_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS coach_meeting_alerts_select_own ON public.coach_meeting_alerts;
CREATE POLICY coach_meeting_alerts_select_own ON public.coach_meeting_alerts
  FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON public.coach_meeting_alerts FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.coach_meeting_alerts FROM authenticated;
GRANT SELECT ON public.coach_meeting_alerts TO authenticated;

CREATE INDEX IF NOT EXISTS coach_meeting_alerts_enabled_idx
  ON public.coach_meeting_alerts (synced_at NULLS FIRST) WHERE enabled;

DO $$
DECLARE
  v_cmd  TEXT;
  v_base TEXT;
  v_auth TEXT;
BEGIN
  IF to_regnamespace('cron') IS NULL OR to_regnamespace('net') IS NULL THEN
    RAISE EXCEPTION 'coach-meeting-alerts: pg_cron o pg_net no están instalados en este proyecto.';
  END IF;

  SELECT j.command INTO v_cmd
    FROM cron.job j
   WHERE j.command ~ 'https://[a-z0-9]+\.supabase\.co/functions/v1/(campaign-run|enrich-list|radar-monitor|api-webhooks|learning-loop|push-send|automation-run|ai-columns|integrations)'
     AND j.command ~ 'Bearer [A-Za-z0-9._-]{20,}'
   ORDER BY (j.command ~ '/functions/v1/integrations') DESC, j.jobid
   LIMIT 1;
  IF v_cmd IS NULL THEN
    RAISE EXCEPTION 'coach-meeting-alerts: no hay un cron de referencia con la service role (enrich-list, campaign-run…).';
  END IF;

  v_base := substring(v_cmd from '(https://[a-z0-9]+\.supabase\.co)/functions/v1/');
  v_auth := substring(v_cmd from '(Bearer [A-Za-z0-9._-]{20,})');

  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'coach-meeting-alerts';
  PERFORM cron.schedule(
    'coach-meeting-alerts',
    '* * * * *',
    format(
      $f$SELECT net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L), body := '{"action":"meeting_alerts"}'::jsonb, timeout_milliseconds := 55000);$f$,
      v_base || '/functions/v1/integrations',
      v_auth));
  RAISE NOTICE 'coach-meeting-alerts programado cada minuto.';
END;
$$;
