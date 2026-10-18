-- ═══════════════════════════════════════════════════════════════════════════
-- Telefonía (2026-10-17): dialer nativo (Twilio) + conectores CloudTalk,
-- Aircall y Ringover + la llamada como paso de campaña.
-- Diseño, proveedores y pasos del dueño en docs/TELEFONIA.md.
--
-- Modelo común de llamadas — mismo criterio de escritura que channel_accounts
-- / campaign_events:
--   • telephony_accounts — escrita SOLO por la edge function `telephony`
--     (service role) tras validar la credencial contra el proveedor. El
--     cliente lee sin las columnas secretas y puede borrar (desconectar).
--   • calls              — una fila por llamada, venga del dialer nativo, de
--     un conector o de un webhook. Solo service role escribe: el resultado lo
--     fija la edge function (porque mueve el enrolamiento y el CRM).
--   • call_tasks         — la tarea de llamar que crea un paso `call` de una
--     campaña (campaign-run). Solo service role escribe.
--
-- `provider` es texto libre validado en código (_shared/telephony/registry.ts):
-- sumar un proveedor nuevo no necesita migración.
--
-- Idempotente (seguro de re-aplicar).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Cuentas de telefonía ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.telephony_accounts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- twilio (dialer nativo) | cloudtalk | aircall | ringover | …
  provider        TEXT        NOT NULL CHECK (char_length(provider) BETWEEN 2 AND 32),
  -- Lo que la UI muestra: agente/usuario del proveedor, números, identificador
  -- de llamada verificado, URL del webhook, última sincronización.
  config          JSONB       NOT NULL DEFAULT '{}',
  -- API key / token del proveedor ('' en el dialer nativo: la cuenta de
  -- Twilio es de la plataforma). Oculto al cliente por grants de columna.
  secret          TEXT        NOT NULL DEFAULT '',
  -- Viaja en la URL del webhook (?key=…): Aircall manda un token en el body y
  -- Ringover firma con su propio secreto, pero la clave de la URL es lo que
  -- dice de QUÉ cuenta es el evento.
  webhook_secret  TEXT        NOT NULL DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  -- El proveedor con el que sale el clic para llamar (uno por usuario).
  is_default      BOOLEAN     NOT NULL DEFAULT false,
  status          TEXT        NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error')),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT telephony_accounts_user_provider_key UNIQUE (user_id, provider)
);

DROP TRIGGER IF EXISTS telephony_accounts_updated_at ON public.telephony_accounts;
CREATE TRIGGER telephony_accounts_updated_at
  BEFORE UPDATE ON public.telephony_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.telephony_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own telephony accounts" ON public.telephony_accounts;
CREATE POLICY "Users can view own telephony accounts"
  ON public.telephony_accounts FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own telephony accounts" ON public.telephony_accounts;
CREATE POLICY "Users can delete own telephony accounts"
  ON public.telephony_accounts FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.telephony_accounts FROM anon, PUBLIC;
REVOKE SELECT, INSERT, UPDATE ON public.telephony_accounts FROM authenticated;
GRANT  SELECT (id, user_id, provider, config, is_default, status, last_error, created_at, updated_at)
       ON public.telephony_accounts TO authenticated;
GRANT  DELETE ON public.telephony_accounts TO authenticated;

CREATE INDEX IF NOT EXISTS telephony_accounts_webhook_secret_idx
  ON public.telephony_accounts (webhook_secret);

-- ── 2. Llamadas ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.calls (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_id          UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  campaign_id        UUID        REFERENCES public.campaigns(id) ON DELETE SET NULL,
  enrollment_id      UUID        REFERENCES public.campaign_enrollments(id) ON DELETE SET NULL,
  task_id            UUID,
  provider           TEXT        NOT NULL,
  -- CallSid de Twilio / id de la llamada en el conector. NULL mientras el
  -- conector no lo devuelva (CloudTalk no lo da al iniciar: se enlaza al
  -- sincronizar por número y hora).
  provider_call_id   TEXT,
  direction          TEXT        NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
  from_number        TEXT,
  to_number          TEXT,
  -- queued → ringing → in_progress → completed | failed | busy | no_answer | canceled
  status             TEXT        NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'ringing', 'in_progress', 'completed', 'failed', 'busy', 'no_answer', 'canceled')),
  -- Resultado que marca el SDR (o el webhook cuando el proveedor lo sabe:
  -- buzón, no contestó). Alimenta las ramas de la campaña.
  outcome            TEXT        CHECK (outcome IN ('answered', 'voicemail', 'no_answer', 'meeting_booked', 'not_interested')),
  outcome_note       TEXT        CHECK (outcome_note IS NULL OR char_length(outcome_note) <= 2000),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at        TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  duration_seconds   INTEGER     CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  -- Grabación: con Twilio se guarda el SID (el audio se sirve por la edge
  -- function, nunca la URL con credenciales); con un conector, el enlace que
  -- da el proveedor.
  recording_ref      TEXT,
  recording_url      TEXT,
  recording_duration INTEGER,
  -- El SDR dejó la grabación encendida y al lead se le avisó al contestar.
  recording_notice   BOOLEAN     NOT NULL DEFAULT false,
  transcript         TEXT,
  transcript_status  TEXT        NOT NULL DEFAULT 'none' CHECK (transcript_status IN ('none', 'pending', 'ready', 'error')),
  -- Sesión del Meeting Coach que escuchó la llamada (su reporte queda en la
  -- ficha del lead).
  coach_meeting_id   UUID,
  credits_reserved   INTEGER     NOT NULL DEFAULT 0,
  credits_charged    INTEGER     NOT NULL DEFAULT 0,
  error_detail       TEXT,
  payload            JSONB       NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS calls_provider_call_key
  ON public.calls (provider, provider_call_id) WHERE provider_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_user_started_idx ON public.calls (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS calls_member_idx ON public.calls (member_id, started_at DESC);

DROP TRIGGER IF EXISTS calls_updated_at ON public.calls;
CREATE TRIGGER calls_updated_at
  BEFORE UPDATE ON public.calls
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own calls" ON public.calls;
CREATE POLICY "Users can view own calls"
  ON public.calls FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.calls FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.calls FROM authenticated;
GRANT  SELECT ON public.calls TO authenticated;

-- ── 3. Tareas de llamada (paso `call` de una campaña) ───────────────────────

CREATE TABLE IF NOT EXISTS public.call_tasks (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_id      UUID        REFERENCES public.prospect_list_members(id) ON DELETE CASCADE,
  campaign_id    UUID        REFERENCES public.campaigns(id) ON DELETE CASCADE,
  enrollment_id  UUID        REFERENCES public.campaign_enrollments(id) ON DELETE CASCADE,
  node_id        TEXT        NOT NULL,
  -- Guion para el SDR (IA desde campaign_messages, o el texto propio del paso).
  script         TEXT,
  -- pending → done (hubo resultado) | skipped (el SDR la saltó) | expired
  -- (venció el plazo del paso sin llamada) | canceled (el lead respondió).
  status         TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'done', 'skipped', 'expired', 'canceled')),
  due_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  call_id        UUID        REFERENCES public.calls(id) ON DELETE SET NULL,
  outcome        TEXT        CHECK (outcome IN ('answered', 'voicemail', 'no_answer', 'meeting_booked', 'not_interested')),
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT call_tasks_enrollment_node_key UNIQUE (enrollment_id, node_id)
);

CREATE INDEX IF NOT EXISTS call_tasks_user_status_idx ON public.call_tasks (user_id, status, due_at);

DROP TRIGGER IF EXISTS call_tasks_updated_at ON public.call_tasks;
CREATE TRIGGER call_tasks_updated_at
  BEFORE UPDATE ON public.call_tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.call_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own call tasks" ON public.call_tasks;
CREATE POLICY "Users can view own call tasks"
  ON public.call_tasks FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.call_tasks FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.call_tasks FROM authenticated;
GRANT  SELECT ON public.call_tasks TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calls_task_id_fkey') THEN
    ALTER TABLE public.calls
      ADD CONSTRAINT calls_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.call_tasks(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── 4. Campañas: el canal `phone` en eventos y mensajes IA ──────────────────
-- Mismo listado de antes + 'phone'. Tipos nuevos: `task_created` (la tarea
-- de llamar quedó en la cola del SDR) y `called` (resultado en payload.outcome).

ALTER TABLE public.campaign_events DROP CONSTRAINT IF EXISTS campaign_events_channel_check;
ALTER TABLE public.campaign_events
  ADD CONSTRAINT campaign_events_channel_check
  CHECK (channel IN ('whatsapp', 'email', 'linkedin', 'phone', 'system'));

ALTER TABLE public.campaign_events DROP CONSTRAINT IF EXISTS campaign_events_type_check;
ALTER TABLE public.campaign_events
  ADD CONSTRAINT campaign_events_type_check
  CHECK (type IN ('queued', 'sent', 'delivered', 'read', 'replied', 'failed', 'skipped',
                  'opted_out', 'connection_sent', 'connection_accepted', 'stopped', 'completed',
                  'opened', 'generated', 'branched', 'task_created', 'called'));

ALTER TABLE public.campaign_messages DROP CONSTRAINT IF EXISTS campaign_messages_channel_check;
ALTER TABLE public.campaign_messages
  ADD CONSTRAINT campaign_messages_channel_check
  CHECK (channel IN ('whatsapp', 'email', 'linkedin', 'phone'));

-- ── 5. Realtime: el dialer y la cola de llamadas se actualizan solos ────────

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.calls;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.call_tasks;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 6. pg_cron: sincronización de conectores sin webhook (CloudTalk) ───────
-- NO se crea aquí (la service-role key nunca vive en el repo). Aplicar una
-- vez desde el SQL editor de Supabase (docs/TELEFONIA.md):
--
-- SELECT cron.schedule('telephony-sync', '*/10 * * * *', $cron$
--   SELECT net.http_post(
--     url     := 'https://<project-ref>.supabase.co/functions/v1/telephony',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'),
--     body    := '{"action":"sync_all"}'::jsonb,
--     timeout_milliseconds := 150000);
-- $cron$);
