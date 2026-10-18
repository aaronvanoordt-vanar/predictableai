-- ═══════════════════════════════════════════════════════════════════════════
-- Buzones propios para el canal Email (2026-10-17)
--
-- Hasta hoy el email de campaña salía solo por Apollo (emailer_messages, con
-- el Apollo propio del cliente). Esto agrega una segunda opción, sin tocar la
-- de Apollo: enviar desde buzones propios conectados a Predictable —
-- Gmail y Microsoft 365 / Outlook por OAuth, o cualquier proveedor por
-- SMTP (465) + IMAP (993) — con rotación entre buzones, tope diario por
-- buzón, rampa de volumen, warm-up, monitor de entregabilidad por dominio y
-- baja (List-Unsubscribe + supresión). Diseño en docs/EMAIL_PROPIO.md.
--
-- Modelo de escritura (mismo criterio que gmail_accounts / channel_accounts):
--   • email_mailboxes      — solo la edge function mailbox-connect (service
--     role) escribe; el cliente lee todo MENOS `secret` (grants de columna).
--   • email_sends          — registro de envíos por buzón (tope, rotación,
--     hilo, rebotes). Solo service role escribe; el cliente lee lo suyo.
--   • email_suppressions   — no escribir a estas direcciones. El motor y la
--     baja escriben; el cliente lee, agrega a mano (reason = 'manual') y borra.
--   • email_domain_health  — último chequeo SPF/DKIM/DMARC/rebotes por
--     dominio. Solo service role escribe.
--   • email_settings       — preferencia del canal (Apollo o buzones propios)
--     y pie de baja. El cliente la escribe (no es sensible).
--
-- Idempotente y no destructivo.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Buzones ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_mailboxes (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider          TEXT        NOT NULL CHECK (provider IN ('gmail', 'microsoft', 'smtp')),
  email             TEXT        NOT NULL CHECK (email = lower(email) AND position('@' IN email) > 1),
  display_name      TEXT,
  status            TEXT        NOT NULL DEFAULT 'connected'
                    CHECK (status IN ('connected', 'error', 'paused')),
  last_error        TEXT,
  -- Por qué está en pausa (manual o automática por rebotes).
  paused_reason     TEXT,
  daily_limit       INTEGER     NOT NULL DEFAULT 30 CHECK (daily_limit BETWEEN 1 AND 200),
  min_gap_seconds   INTEGER     NOT NULL DEFAULT 300 CHECK (min_gap_seconds BETWEEN 0 AND 3600),
  ramp_enabled      BOOLEAN     NOT NULL DEFAULT true,
  ramp_started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_timezone   TEXT,
  window_start_hour SMALLINT    CHECK (window_start_hour BETWEEN 0 AND 23),
  window_end_hour   SMALLINT    CHECK (window_end_hour BETWEEN 0 AND 24),
  -- No secreto: servidores SMTP/IMAP y usuario, scopes, firma.
  config            JSONB       NOT NULL DEFAULT '{}',
  -- Secreto: refresh token o contraseñas (JSON, cifrado con AES-GCM si
  -- MAILBOX_SECRET_KEY está cargada). Oculto al cliente por grants.
  secret            TEXT        NOT NULL,
  -- {state, provider, started_at, stats, error, updated_at}
  warmup            JSONB       NOT NULL DEFAULT '{}',
  -- Cursor de la lectura de la bandeja (internalDate / receivedDateTime / UID).
  sync_state        JSONB       NOT NULL DEFAULT '{}',
  last_sync_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_mailboxes_user_email_key UNIQUE (user_id, email)
);

CREATE INDEX IF NOT EXISTS email_mailboxes_user_idx ON public.email_mailboxes (user_id);

ALTER TABLE public.email_mailboxes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own mailboxes" ON public.email_mailboxes;
CREATE POLICY "Users can read own mailboxes"
  ON public.email_mailboxes FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.email_mailboxes FROM anon, PUBLIC;
REVOKE ALL ON public.email_mailboxes FROM authenticated;
GRANT SELECT (id, user_id, provider, email, display_name, status, last_error, paused_reason,
              daily_limit, min_gap_seconds, ramp_enabled, ramp_started_at,
              window_timezone, window_start_hour, window_end_hour,
              config, warmup, last_sync_at, created_at, updated_at)
  ON public.email_mailboxes TO authenticated;

-- ── Registro de envíos ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_sends (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mailbox_id          UUID        REFERENCES public.email_mailboxes(id) ON DELETE SET NULL,
  campaign_id         UUID        REFERENCES public.campaigns(id) ON DELETE SET NULL,
  enrollment_id       UUID        REFERENCES public.campaign_enrollments(id) ON DELETE SET NULL,
  member_id           UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  kind                TEXT        NOT NULL DEFAULT 'campaign' CHECK (kind IN ('campaign', 'reply')),
  from_email          TEXT        NOT NULL,
  to_email            TEXT        NOT NULL,
  subject             TEXT,
  -- Message-ID RFC 5322 normalizado (<id@dominio> en minúsculas): llave del hilo y del rebote.
  message_id          TEXT        NOT NULL,
  references_ids      TEXT[]      NOT NULL DEFAULT '{}',
  provider_message_id TEXT,
  thread_id           TEXT,
  status              TEXT        NOT NULL DEFAULT 'sent'
                      CHECK (status IN ('sent', 'bounced', 'replied')),
  bounce_hard         BOOLEAN,
  bounce_reason       TEXT,
  replied_at          TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_sends_message_id_key ON public.email_sends (message_id);
CREATE INDEX IF NOT EXISTS email_sends_mailbox_sent_idx ON public.email_sends (mailbox_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS email_sends_user_to_idx ON public.email_sends (user_id, to_email, sent_at DESC);
CREATE INDEX IF NOT EXISTS email_sends_enrollment_idx ON public.email_sends (enrollment_id, sent_at DESC);

ALTER TABLE public.email_sends ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own email sends" ON public.email_sends;
CREATE POLICY "Users can read own email sends"
  ON public.email_sends FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
REVOKE ALL ON public.email_sends FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.email_sends FROM authenticated;

-- ── Supresión ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_suppressions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email             TEXT        NOT NULL CHECK (email = lower(email) AND position('@' IN email) > 1),
  reason            TEXT        NOT NULL CHECK (reason IN ('unsubscribed', 'bounced', 'complaint', 'manual')),
  detail            TEXT,
  source_mailbox_id UUID        REFERENCES public.email_mailboxes(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_suppressions_user_email_key UNIQUE (user_id, email)
);

ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own suppressions" ON public.email_suppressions;
CREATE POLICY "Users can read own suppressions"
  ON public.email_suppressions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can add manual suppressions" ON public.email_suppressions;
CREATE POLICY "Users can add manual suppressions"
  ON public.email_suppressions FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND reason = 'manual');
DROP POLICY IF EXISTS "Users can remove own suppressions" ON public.email_suppressions;
CREATE POLICY "Users can remove own suppressions"
  ON public.email_suppressions FOR DELETE TO authenticated
  USING (auth.uid() = user_id);
REVOKE ALL ON public.email_suppressions FROM anon, PUBLIC;
REVOKE UPDATE ON public.email_suppressions FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.email_suppressions TO authenticated;

-- ── Salud por dominio ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_domain_health (
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  domain      TEXT        NOT NULL,
  level       TEXT        NOT NULL DEFAULT 'ok' CHECK (level IN ('ok', 'warn', 'critical')),
  report      JSONB       NOT NULL DEFAULT '{}',
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, domain)
);
ALTER TABLE public.email_domain_health ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own domain health" ON public.email_domain_health;
CREATE POLICY "Users can read own domain health"
  ON public.email_domain_health FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
REVOKE ALL ON public.email_domain_health FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.email_domain_health FROM authenticated;

-- ── Ajustes del canal Email ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_settings (
  user_id             UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Con qué sale el email de campaña y de la Bandeja si la campaña no elige.
  provider            TEXT        NOT NULL DEFAULT 'apollo' CHECK (provider IN ('apollo', 'mailboxes')),
  unsubscribe_footer  BOOLEAN     NOT NULL DEFAULT false,
  footer_text         TEXT        CHECK (char_length(footer_text) <= 200),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.email_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own email settings" ON public.email_settings;
CREATE POLICY "Users manage own email settings"
  ON public.email_settings FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
REVOKE ALL ON public.email_settings FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.email_settings TO authenticated;

-- ── La bandeja acepta mensajes de buzones propios ──────────────────────────
ALTER TABLE public.inbox_messages DROP CONSTRAINT IF EXISTS inbox_messages_provider_check;
ALTER TABLE public.inbox_messages
  ADD CONSTRAINT inbox_messages_provider_check
  CHECK (provider IN ('wati', 'apollo', 'gmail', 'dripify', 'mailbox'));

-- ── Cron (aplicar a mano, igual que los demás) ─────────────────────────────
-- Lee las bandejas (respuestas, rebotes, bajas), revisa el DNS de los
-- dominios una vez al día y trae las métricas de warm-up:
--
-- SELECT cron.schedule('mailbox-sync', '*/5 * * * *', $cron$
--   SELECT net.http_post(
--     url     := 'https://<project-ref>.supabase.co/functions/v1/mailbox-sync',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'),
--     body    := '{}'::jsonb,
--     timeout_milliseconds := 150000);
-- $cron$);
