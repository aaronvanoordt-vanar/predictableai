-- Agente de voz IA (P3 de docs/ROADMAP_GTM_OS.md, 2026-10-17).
--
-- El agente devuelve llamadas a quien las pidió, confirma o reprograma
-- reuniones y califica a quien ya mostró interés. NO hace llamadas en frío
-- (la compuerta vive en _shared/voice-agent.ts#warmGate). Diseño, proveedor
-- (Retell sobre un número de Twilio o Telnyx) y leyes por país en
-- docs/AGENTE_DE_VOZ.md.
--
--   • voice_agent_settings — una fila por usuario, la escribe el propio
--                            usuario (RLS por dueño): encendido, nombre del
--                            asistente, número para pasar con una persona,
--                            grabación y duración máxima.
--   • voice_calls          — una fila por llamada. Solo escribe el servidor
--                            (voice-agent / voice-webhook con la service role);
--                            el usuario lee las suyas. Lleva la reserva de
--                            créditos para liquidarla al terminar.
--   • voice_platform       — ids del agente base en el proveedor (lo crea la
--                            edge function la primera vez). Solo service role.
--   • inbox_messages       — admite channel 'voice' y provider 'retell': cada
--                            llamada terminada deja su resumen en la Bandeja.

-- ── 1. Configuración por usuario ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.voice_agent_settings (
  user_id         UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled         BOOLEAN     NOT NULL DEFAULT FALSE,
  assistant_name  TEXT        NOT NULL DEFAULT 'Sofía',
  -- E.164 al que el agente transfiere cuando el lead pide una persona.
  handoff_number  TEXT,
  -- Grabar el audio (con aviso al inicio). Apagado = solo transcripción.
  record_calls    BOOLEAN     NOT NULL DEFAULT FALSE,
  max_minutes     SMALLINT    NOT NULL DEFAULT 8,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT voice_agent_settings_name_len CHECK (char_length(assistant_name) BETWEEN 1 AND 40),
  CONSTRAINT voice_agent_settings_handoff_e164 CHECK (handoff_number IS NULL OR handoff_number ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT voice_agent_settings_max_minutes CHECK (max_minutes BETWEEN 2 AND 15)
);

ALTER TABLE public.voice_agent_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_agent_settings FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.voice_agent_settings TO authenticated;

DROP POLICY IF EXISTS "voice settings: own select" ON public.voice_agent_settings;
CREATE POLICY "voice settings: own select" ON public.voice_agent_settings
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "voice settings: own insert" ON public.voice_agent_settings;
CREATE POLICY "voice settings: own insert" ON public.voice_agent_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "voice settings: own update" ON public.voice_agent_settings;
CREATE POLICY "voice settings: own update" ON public.voice_agent_settings
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ── 2. Llamadas ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.voice_calls (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_id          UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  purpose            TEXT        NOT NULL CHECK (purpose IN ('callback', 'confirm', 'reschedule', 'qualify')),
  -- queued → la pedimos al proveedor; in_progress → contestó; ended / failed.
  status             TEXT        NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'in_progress', 'ended', 'failed')),
  outcome            TEXT        CHECK (outcome IN (
                       'confirmed', 'rescheduled', 'qualified', 'not_qualified', 'wants_human',
                       'call_back_later', 'not_interested', 'do_not_call', 'wrong_person',
                       'no_answer', 'voicemail', 'no_conversation', 'failed', 'unknown')),
  country            TEXT        NOT NULL CHECK (country IN ('MX', 'CO', 'CL', 'PE', 'AR', 'BR')),
  to_number          TEXT        NOT NULL,
  from_number        TEXT,
  provider           TEXT        NOT NULL DEFAULT 'retell',
  provider_call_id   TEXT,
  -- Prueba de interés con la que se habilitó la llamada (nunca en frío):
  -- {inbound: bool, attested: bool, note, contact_status, source_kind}.
  warm_evidence      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Reunión que se confirma o reprograma: {start, title, calendar_event_id}.
  meeting            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  recording_enabled  BOOLEAN     NOT NULL DEFAULT FALSE,
  -- El audio queda en el proveedor (URL firmada a pedido); false si se borró.
  recording_available BOOLEAN    NOT NULL DEFAULT FALSE,
  opening            TEXT,
  transcript         TEXT,
  summary            TEXT,
  next_step          TEXT,
  qualification      TEXT,
  new_meeting_at     TIMESTAMPTZ,
  callback_at        TIMESTAMPTZ,
  -- Qué pasó con el agendamiento: {calendar: 'updated'|'confirmed'|'not_linked'|'error', detail}.
  scheduling         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  duration_seconds   INTEGER     NOT NULL DEFAULT 0,
  credits_reserved   INTEGER     NOT NULL DEFAULT 0,
  credits_charged    INTEGER,
  provider_cost_cents NUMERIC,
  disconnection      TEXT,
  error_detail       TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at         TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  -- Se llena cuando se liquidaron los créditos y se escribió la Bandeja:
  -- el webhook y la reconciliación no lo hacen dos veces.
  finalized_at       TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS voice_calls_provider_call_key
  ON public.voice_calls (provider, provider_call_id) WHERE provider_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS voice_calls_member_idx ON public.voice_calls (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_calls_user_idx ON public.voice_calls (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_calls_open_idx ON public.voice_calls (created_at) WHERE finalized_at IS NULL;
-- Una sola llamada abierta por lead: dos clics a la vez no marcan dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS voice_calls_one_open_per_member
  ON public.voice_calls (member_id) WHERE finalized_at IS NULL AND member_id IS NOT NULL;
-- «No me llamen más»: se busca por número en cada llamada nueva.
CREATE INDEX IF NOT EXISTS voice_calls_dnc_idx ON public.voice_calls (user_id, to_number) WHERE outcome = 'do_not_call';

ALTER TABLE public.voice_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_calls FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.voice_calls FROM authenticated;
GRANT SELECT ON public.voice_calls TO authenticated;

DROP POLICY IF EXISTS "voice calls: own select" ON public.voice_calls;
CREATE POLICY "voice calls: own select" ON public.voice_calls
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- ── 3. Agente base en el proveedor (solo service role) ───────────────────────
CREATE TABLE IF NOT EXISTS public.voice_platform (
  id                 SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider           TEXT        NOT NULL DEFAULT 'retell',
  llm_id             TEXT,
  agent_id           TEXT,
  definition_version INTEGER     NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.voice_platform ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_platform FROM anon, authenticated, PUBLIC;

-- ── 4. Bandeja: canal 'voice' y proveedor 'retell' ───────────────────────────
-- SUMA los valores a lo que el CHECK ya permita, sin quitar nada: otras
-- migraciones (WhatsApp con Meta, LinkedIn nativo…) agregan los suyos y una
-- lista cerrada aquí los borraría. Mismo criterio que extend_provider_check
-- (20261018161500_whatsapp_meta), escrito en línea para servir también a la
-- columna `channel`.
DO $$
DECLARE
  r      record;
  v_def  text;
  v_vals text[];
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('inbox_messages_channel_check',  'channel',  ARRAY['whatsapp', 'email', 'linkedin', 'voice']),
    ('inbox_messages_provider_check', 'provider', ARRAY['wati', 'apollo', 'gmail', 'dripify', 'retell'])
  ) AS t(conname, col, vals)
  LOOP
    SELECT pg_get_constraintdef(c.oid) INTO v_def
      FROM pg_constraint c
     WHERE c.conrelid = 'public.inbox_messages'::regclass AND c.conname = r.conname;
    v_vals := ARRAY(
      SELECT DISTINCT v FROM (
        SELECT (regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g'))[1] AS v
        UNION SELECT unnest(r.vals)
      ) s ORDER BY 1
    );
    EXECUTE format('ALTER TABLE public.inbox_messages DROP CONSTRAINT IF EXISTS %I', r.conname);
    EXECUTE format('ALTER TABLE public.inbox_messages ADD CONSTRAINT %I CHECK (%I IN (%s))', r.conname, r.col,
      (SELECT string_agg(quote_literal(x), ', ') FROM unnest(v_vals) AS x));
  END LOOP;
END $$;

-- ── 5. Realtime: la ficha del lead ve terminar la llamada sin recargar ──────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'voice_calls') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.voice_calls;
  END IF;
END $$;

COMMENT ON TABLE public.voice_calls IS
  'Llamadas del agente de voz IA (edge functions voice-agent y voice-webhook). Nunca en frío: warm_evidence guarda la prueba de interés.';

-- pg_cron (ejecutar en el SQL editor DESPUÉS de desplegar voice-agent; lleva
-- la service role, por eso no va en la migración). Liquida las llamadas cuyo
-- webhook no llegó (créditos reservados, Bandeja sin resumen):
--
-- SELECT cron.schedule('voice-reconcile', '*/10 * * * *', $cron$
--   SELECT net.http_post(
--     url     := 'https://<project-ref>.supabase.co/functions/v1/voice-agent',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'),
--     body    := '{"action":"reconcile"}'::jsonb,
--     timeout_milliseconds := 60000);
-- $cron$);
