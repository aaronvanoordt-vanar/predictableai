-- ═══════════════════════════════════════════════════════════════════════════
-- Campañas omnicanal (WhatsApp vía WATI + email vía Apollo + LinkedIn vía
-- Dripify) — 2026-09-02
--
-- Reemplaza POR COMPLETO la integración directa con la Cloud API de Meta
-- (tablas whatsapp_*, bucket whatsapp-media, cron whatsapp-followups). La
-- decisión de producto es explícita: WATI es el único proveedor de WhatsApp.
-- ⚠ Este archivo BORRA las conversaciones de WhatsApp guardadas hasta hoy.
--   Confirmado por el dueño del producto el 2026-09-01.
--
-- Modelo de escritura (mismo criterio que gmail_accounts / prospect_lists):
--   • channel_accounts       — escrita SOLO por la edge function
--     channel-connect (service role) tras validar la credencial contra el
--     proveedor. El cliente puede SELECT (sin las columnas secretas) y DELETE.
--   • campaigns / campaign_steps — CLIENT-WRITABLE, RLS por dueño.
--   • campaign_enrollments   — el cliente INSERTa (enrolar), UPDATEa (pausar /
--     detener) y DELETEa; el motor campaign-run (service role) avanza el paso.
--   • campaign_events        — solo service role escribe; el cliente lee.
--     En la publicación realtime para que Campañas se actualice en vivo.
--   • inbox_messages         — solo service role escribe (webhooks + envíos);
--     el cliente lee. Es la base de la bandeja unificada (PR 3).
--
-- Todas las sentencias son idempotentes (seguras de re-aplicar).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Retiro de la integración con Meta ────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'whatsapp-followups') THEN
      PERFORM cron.unschedule('whatsapp-followups');
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible o job inexistente: %', SQLERRM;
END $$;

DROP POLICY IF EXISTS "wa media owner upload" ON storage.objects;
DROP POLICY IF EXISTS "wa media owner delete" ON storage.objects;

DO $$
BEGIN
  DELETE FROM storage.objects WHERE bucket_id = 'whatsapp-media';
  DELETE FROM storage.buckets WHERE id = 'whatsapp-media';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'No se pudo borrar el bucket whatsapp-media: %', SQLERRM;
END $$;

DROP TABLE IF EXISTS public.whatsapp_followups     CASCADE;
DROP TABLE IF EXISTS public.whatsapp_messages      CASCADE;
DROP TABLE IF EXISTS public.whatsapp_conversations CASCADE;
DROP TABLE IF EXISTS public.whatsapp_templates     CASCADE;
DROP TABLE IF EXISTS public.whatsapp_accounts      CASCADE;

-- ── 2. Pipeline del CRM: estados por canal ──────────────────────────────────
-- Los seis estados originales se mantienen; los nuevos los escribe el motor
-- de campañas y los webhooks (y el usuario a mano desde Contactos).

ALTER TABLE public.prospect_list_members
  DROP CONSTRAINT IF EXISTS prospect_list_members_contact_status_check;

ALTER TABLE public.prospect_list_members
  ADD CONSTRAINT prospect_list_members_contact_status_check
  CHECK (contact_status IN (
    'no_contactado', 'en_campana', 'saludo_enviado',
    'conexion_enviada', 'conexion_aceptada', 'respondio',
    'reunion_agendada', 'reunion_tomada',
    'no_interesado', 'no_show', 'dado_de_baja'
  ));

-- ── 3. Cuentas de canal (WATI, Dripify) ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.channel_accounts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider        TEXT        NOT NULL CHECK (provider IN ('wati', 'dripify')),
  -- Datos NO secretos que la UI necesita mostrar: tenant, número, canal,
  -- nombres/estado de las plantillas de saludo, remitente, id del webhook.
  config          JSONB       NOT NULL DEFAULT '{}',
  -- Secretos: token de WATI / API key de Dripify. Ocultos al cliente por
  -- grants de columna (ver abajo). Solo los leen las edge functions.
  secret          TEXT        NOT NULL,
  -- Secreto aleatorio que viaja en la URL del webhook (?key=…): WATI no
  -- firma sus callbacks, así que es la única forma de autenticarlos.
  webhook_secret  TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'connected'
                  CHECK (status IN ('connected', 'error')),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT channel_accounts_user_provider_key UNIQUE (user_id, provider)
);

DROP TRIGGER IF EXISTS channel_accounts_updated_at ON public.channel_accounts;
CREATE TRIGGER channel_accounts_updated_at
  BEFORE UPDATE ON public.channel_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.channel_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own channel accounts" ON public.channel_accounts;
CREATE POLICY "Users can view own channel accounts"
  ON public.channel_accounts FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own channel accounts" ON public.channel_accounts;
CREATE POLICY "Users can delete own channel accounts"
  ON public.channel_accounts FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Los privilegios de columna solo aplican sin SELECT a nivel de tabla.
REVOKE ALL ON public.channel_accounts FROM anon, PUBLIC;
REVOKE SELECT, INSERT, UPDATE ON public.channel_accounts FROM authenticated;
GRANT  SELECT (id, user_id, provider, config, status, last_error, created_at, updated_at)
       ON public.channel_accounts TO authenticated;

CREATE INDEX IF NOT EXISTS channel_accounts_webhook_secret_idx
  ON public.channel_accounts (webhook_secret);

-- ── 4. Campañas ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.campaigns (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name             TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  -- Lista de origen (informativa: los enrolamientos apuntan al miembro).
  list_id          UUID        REFERENCES public.prospect_lists(id) ON DELETE SET NULL,
  status           TEXT        NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  -- Ventana de envío en la zona horaria indicada (IANA, p. ej. America/Lima).
  timezone         TEXT        NOT NULL DEFAULT 'America/Lima',
  send_start_hour  SMALLINT    NOT NULL DEFAULT 9  CHECK (send_start_hour BETWEEN 0 AND 23),
  send_end_hour    SMALLINT    NOT NULL DEFAULT 18 CHECK (send_end_hour BETWEEN 1 AND 24),
  -- Días permitidos, 1 = lunes … 7 = domingo (ISO).
  send_days        SMALLINT[]  NOT NULL DEFAULT '{1,2,3,4,5}',
  -- Tope diario por canal: {"whatsapp": 50, "email": 80, "linkedin": 25}
  daily_caps       JSONB       NOT NULL DEFAULT '{"whatsapp": 50, "email": 80, "linkedin": 25}',
  -- Quién firma: {"name","role","company","email_account_id","email"}.
  -- email_account_id/email = la cuenta remitente de Apollo para el canal email.
  sender           JSONB       NOT NULL DEFAULT '{}',
  -- true cuando la cadencia salió de la recomendación y no se editó.
  recommended      BOOLEAN     NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS campaigns_updated_at ON public.campaigns;
CREATE TRIGGER campaigns_updated_at
  BEFORE UPDATE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.campaign_steps (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    UUID        NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  user_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  position       SMALLINT    NOT NULL CHECK (position >= 0),
  channel        TEXT        NOT NULL
                 CHECK (channel IN ('whatsapp', 'email', 'linkedin_connect', 'linkedin_message')),
  -- Horas desde el inicio del enrolamiento. Dos pasos con el mismo offset en
  -- canales distintos corren en paralelo (así el email "refuerza" a la vez).
  offset_hours   INTEGER     NOT NULL DEFAULT 0 CHECK (offset_hours >= 0),
  -- always            → se ejecuta siempre que el lead siga activo
  -- if_no_reply       → solo si el lead no ha respondido por ningún canal
  -- if_connected      → solo si la conexión de LinkedIn fue aceptada
  condition      TEXT        NOT NULL DEFAULT 'if_no_reply'
                 CHECK (condition IN ('always', 'if_no_reply', 'if_connected')),
  -- template_a/b/c   → plantillas de saludo de WhatsApp (WATI) del usuario
  -- ai_personalized  → mensaje de 5 capas ya generado (outreach JSON del lead)
  -- custom           → texto propio con variables {{nombre}} {{empresa}}
  content_kind   TEXT        NOT NULL DEFAULT 'ai_personalized'
                 CHECK (content_kind IN ('template_a', 'template_b', 'template_c', 'ai_personalized', 'custom')),
  subject        TEXT,
  body           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_steps_campaign_position_key UNIQUE (campaign_id, position)
);

CREATE TABLE IF NOT EXISTS public.campaign_enrollments (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      UUID        NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  member_id        UUID        NOT NULL REFERENCES public.prospect_list_members(id) ON DELETE CASCADE,
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- active      → el motor sigue ejecutando pasos
  -- processing  → reclamado por un run del cron (UPDATE atómico, sin dobles envíos)
  -- replied     → respondió por algún canal: se detienen todos los pasos
  -- unsubscribed→ pidió la baja (botón "Darse de baja" o palabra clave)
  -- completed   → no quedan pasos
  -- paused      → pausado por el usuario
  -- error       → un envío falló de forma no recuperable
  status           TEXT        NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'processing', 'replied', 'unsubscribed', 'completed', 'paused', 'error')),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_position    SMALLINT    NOT NULL DEFAULT 0,
  next_run_at      TIMESTAMPTZ,
  -- Fecha de la última respuesta del lead y por qué canal (para if_no_reply
  -- y para la ventana de 24 h de WhatsApp).
  replied_at       TIMESTAMPTZ,
  replied_channel  TEXT,
  last_inbound_whatsapp_at TIMESTAMPTZ,
  linkedin_connected_at    TIMESTAMPTZ,
  stop_reason      TEXT,
  error_detail     TEXT,
  processing_since TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_enrollments_campaign_member_key UNIQUE (campaign_id, member_id)
);

DROP TRIGGER IF EXISTS campaign_enrollments_updated_at ON public.campaign_enrollments;
CREATE TRIGGER campaign_enrollments_updated_at
  BEFORE UPDATE ON public.campaign_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.campaign_events (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id        UUID        REFERENCES public.campaign_enrollments(id) ON DELETE CASCADE,
  campaign_id          UUID        REFERENCES public.campaigns(id) ON DELETE CASCADE,
  member_id            UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  user_id              UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel              TEXT        NOT NULL
                       CHECK (channel IN ('whatsapp', 'email', 'linkedin', 'system')),
  type                 TEXT        NOT NULL
                       CHECK (type IN ('queued', 'sent', 'delivered', 'read', 'replied', 'failed', 'skipped',
                                       'opted_out', 'connection_sent', 'connection_accepted', 'stopped', 'completed')),
  step_position        SMALLINT,
  -- local_message_id que mandamos al proveedor: WATI lo devuelve en cada
  -- receipt (sent/delivered/read/replied/failed) y así se enlaza el evento.
  provider_message_id  TEXT,
  detail               TEXT,
  payload              JSONB       NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.inbox_messages (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_id                UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  channel                  TEXT        NOT NULL CHECK (channel IN ('whatsapp', 'email', 'linkedin')),
  provider                 TEXT        NOT NULL CHECK (provider IN ('wati', 'apollo', 'gmail', 'dripify')),
  direction                TEXT        NOT NULL CHECK (direction IN ('in', 'out')),
  -- Identificador del contacto en el canal (dígitos del teléfono, email, URL).
  contact_ref              TEXT,
  body                     TEXT,
  -- ID del mensaje en el proveedor (WAMID de WATI, id de Apollo…): UNIQUE
  -- hace de dedupe ante reintentos del webhook (WATI reintenta hasta 144 veces).
  provider_message_id      TEXT,
  provider_conversation_id TEXT,
  status                   TEXT        NOT NULL DEFAULT 'sent'
                           CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
  error_detail             TEXT,
  sent_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload                  JSONB       NOT NULL DEFAULT '{}',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS inbox_messages_provider_message_key
  ON public.inbox_messages (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- ── 5. RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE public.campaigns            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_steps       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_messages       ENABLE ROW LEVEL SECURITY;

-- campaigns / campaign_steps / campaign_enrollments: CRUD del dueño.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaigns', 'campaign_steps', 'campaign_enrollments'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Users can view own %1$s" ON public.%1$I', t);
    EXECUTE format('CREATE POLICY "Users can view own %1$s" ON public.%1$I FOR SELECT TO authenticated USING (auth.uid() = user_id)', t);
    EXECUTE format('DROP POLICY IF EXISTS "Users can insert own %1$s" ON public.%1$I', t);
    EXECUTE format('CREATE POLICY "Users can insert own %1$s" ON public.%1$I FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id)', t);
    EXECUTE format('DROP POLICY IF EXISTS "Users can update own %1$s" ON public.%1$I', t);
    EXECUTE format('CREATE POLICY "Users can update own %1$s" ON public.%1$I FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)', t);
    EXECUTE format('DROP POLICY IF EXISTS "Users can delete own %1$s" ON public.%1$I', t);
    EXECUTE format('CREATE POLICY "Users can delete own %1$s" ON public.%1$I FOR DELETE TO authenticated USING (auth.uid() = user_id)', t);
    EXECUTE format('REVOKE ALL ON public.%1$I FROM anon, PUBLIC', t);
  END LOOP;
END $$;

-- campaign_events / inbox_messages: el cliente solo lee lo suyo.
DROP POLICY IF EXISTS "Users can view own campaign events" ON public.campaign_events;
CREATE POLICY "Users can view own campaign events"
  ON public.campaign_events FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own inbox messages" ON public.inbox_messages;
CREATE POLICY "Users can view own inbox messages"
  ON public.inbox_messages FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.campaign_events FROM anon, PUBLIC;
REVOKE ALL ON public.inbox_messages  FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.campaign_events FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.inbox_messages  FROM authenticated;

-- ── 6. Índices ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS campaigns_user_idx
  ON public.campaigns (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS campaign_steps_campaign_idx
  ON public.campaign_steps (campaign_id, position);
-- El motor busca solo enrolamientos activos y vencidos.
CREATE INDEX IF NOT EXISTS campaign_enrollments_due_idx
  ON public.campaign_enrollments (next_run_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS campaign_enrollments_member_idx
  ON public.campaign_enrollments (member_id);
CREATE INDEX IF NOT EXISTS campaign_enrollments_campaign_idx
  ON public.campaign_enrollments (campaign_id, status);
CREATE INDEX IF NOT EXISTS campaign_events_enrollment_idx
  ON public.campaign_events (enrollment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS campaign_events_provider_msg_idx
  ON public.campaign_events (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS campaign_events_user_day_idx
  ON public.campaign_events (user_id, channel, created_at DESC)
  WHERE type = 'sent';
CREATE INDEX IF NOT EXISTS inbox_messages_member_idx
  ON public.inbox_messages (member_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS inbox_messages_user_idx
  ON public.inbox_messages (user_id, sent_at DESC);

-- ── 7. Realtime ─────────────────────────────────────────────────────────────
-- postgres_changes respeta RLS: cada suscriptor ve solo sus filas.

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.campaign_events;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.campaign_enrollments;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.inbox_messages;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 8. pg_cron: motor de campañas cada minuto ───────────────────────────────
-- NO se crea aquí (la service-role key nunca vive en el repo). Aplicar una
-- vez desde el SQL editor de Supabase, igual que los jobs del Intelligence Hub:
--
-- SELECT cron.schedule('campaign-run', '* * * * *',
--   $$ SELECT net.http_post(
--        url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/campaign-run',
--        headers := jsonb_build_object(
--          'Content-Type',  'application/json',
--          'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'
--        ),
--        body    := '{}'::jsonb
--      ); $$);
