-- ═══════════════════════════════════════════════════════════════════════════
-- WhatsApp Inbox (Meta WhatsApp Business Cloud API) — 2026-07-15
--
-- Persists per-user WhatsApp Cloud API connections, conversations, messages
-- and scheduled follow-ups. Each user connects their OWN Meta app credentials
-- (phone_number_id + permanent access token + app secret); the shared
-- whatsapp-webhook edge function routes inbound traffic to the right account
-- by the payload's metadata.phone_number_id.
--
-- Write model:
--   • whatsapp_accounts       — written ONLY by the whatsapp-send edge
--     function (service role) after validating the token against the Graph
--     API. Client may SELECT (minus secret columns, see column grants below)
--     and DELETE (disconnect).
--   • whatsapp_conversations  — service-role writers (webhook + send fn);
--     client may SELECT, UPDATE (link a prospect, reset unread) and DELETE.
--   • whatsapp_messages       — service-role writers only; client SELECTs.
--     In the realtime publication so the inbox updates live.
--   • whatsapp_followups      — CLIENT-WRITABLE (schedule/cancel), processed
--     by the whatsapp-followups edge function via pg_cron (service role).
--
-- Secret columns (access_token, app_secret) are never readable from the
-- client: table-level SELECT is revoked and re-granted column-by-column.
-- The client must therefore always name columns explicitly (no select=*).
--
-- All statements are idempotent and non-destructive (safe to re-apply).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_accounts (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_number_id  TEXT        NOT NULL UNIQUE,
  waba_id          TEXT,
  display_phone    TEXT,
  display_name     TEXT,
  -- Secrets: provided by the user at connect time, consumed only by edge
  -- functions (service role). Column-level grants below hide them from the
  -- client; RLS hides the whole row from other users either way.
  access_token     TEXT        NOT NULL,
  app_secret       TEXT        NOT NULL,
  -- Random token the user pastes into Meta's webhook config ("Verify token").
  verify_token     TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'connected'
                   CHECK (status IN ('connected', 'error')),
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.whatsapp_conversations (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id             UUID        NOT NULL REFERENCES public.whatsapp_accounts(id) ON DELETE CASCADE,
  -- Contact's WhatsApp number: international digits, no '+' (Meta's wa_id).
  wa_id                  TEXT        NOT NULL,
  -- Name reported by WhatsApp (contacts[].profile.name) — may lag reality.
  profile_name           TEXT,
  -- Link to the enrichment row in Prospección; SET NULL keeps the thread if
  -- the prospect row/list is deleted.
  member_id              UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  last_message_at        TIMESTAMPTZ,
  last_message_preview   TEXT,
  last_message_direction TEXT,
  unread_count           INTEGER     NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_conversations_account_wa_key UNIQUE (account_id, wa_id)
);

CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID        NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  -- Denormalized owner so RLS + realtime filters are join-free.
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Meta message id ("wamid.…"). UNIQUE doubles as webhook re-delivery dedupe.
  wamid           TEXT        UNIQUE,
  direction       TEXT        NOT NULL CHECK (direction IN ('in', 'out')),
  type            TEXT        NOT NULL DEFAULT 'text',
  -- Text body, or media caption.
  body            TEXT,
  -- Path inside the whatsapp-media storage bucket (NULL for non-media).
  media_path      TEXT,
  media_mime      TEXT,
  media_filename  TEXT,
  -- wamid of the message this one replies to (WhatsApp "reply" context).
  reply_to_wamid  TEXT,
  -- [{emoji, from ('in'|'out'), at}] — reactions received/sent on this message.
  reactions       JSONB       NOT NULL DEFAULT '[]',
  status          TEXT        NOT NULL DEFAULT 'sent'
                  CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
  error_detail    TEXT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.whatsapp_followups (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id UUID        NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  body            TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4096),
  send_at         TIMESTAMPTZ NOT NULL,
  -- 'processing' = claimed by a cron run (atomic UPDATE … WHERE status =
  -- 'pending'), so overlapping runs can never double-send the same follow-up.
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  error_detail    TEXT,
  sent_message_id UUID        REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── updated_at triggers (reuses public.set_updated_at from client_icp) ──────

DROP TRIGGER IF EXISTS whatsapp_accounts_updated_at ON public.whatsapp_accounts;
CREATE TRIGGER whatsapp_accounts_updated_at
  BEFORE UPDATE ON public.whatsapp_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS whatsapp_conversations_updated_at ON public.whatsapp_conversations;
CREATE TRIGGER whatsapp_conversations_updated_at
  BEFORE UPDATE ON public.whatsapp_conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS whatsapp_followups_updated_at ON public.whatsapp_followups;
CREATE TRIGGER whatsapp_followups_updated_at
  BEFORE UPDATE ON public.whatsapp_followups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.whatsapp_accounts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_followups     ENABLE ROW LEVEL SECURITY;

-- accounts: SELECT + DELETE only — INSERT/UPDATE happen exclusively in the
-- whatsapp-send edge function (service role) after validating the credentials
-- against the Graph API. No client policy for INSERT/UPDATE = denied.
DROP POLICY IF EXISTS "Users can view own whatsapp account" ON public.whatsapp_accounts;
CREATE POLICY "Users can view own whatsapp account"
  ON public.whatsapp_accounts FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own whatsapp account" ON public.whatsapp_accounts;
CREATE POLICY "Users can delete own whatsapp account"
  ON public.whatsapp_accounts FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- conversations: client can read, relink prospects / reset unread, and delete.
-- INSERTs come from edge functions (service role) so wa_id normalization and
-- account matching stay server-side.
DROP POLICY IF EXISTS "Users can view own wa conversations" ON public.whatsapp_conversations;
CREATE POLICY "Users can view own wa conversations"
  ON public.whatsapp_conversations FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own wa conversations" ON public.whatsapp_conversations;
CREATE POLICY "Users can update own wa conversations"
  ON public.whatsapp_conversations FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own wa conversations" ON public.whatsapp_conversations;
CREATE POLICY "Users can delete own wa conversations"
  ON public.whatsapp_conversations FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- messages: read-only from the client; all writes go through edge functions.
DROP POLICY IF EXISTS "Users can view own wa messages" ON public.whatsapp_messages;
CREATE POLICY "Users can view own wa messages"
  ON public.whatsapp_messages FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- followups: fully client-writable (owner-scoped) — scheduling and cancelling
-- are plain table writes; only the actual SEND happens server-side (cron).
DROP POLICY IF EXISTS "Users can view own wa followups" ON public.whatsapp_followups;
CREATE POLICY "Users can view own wa followups"
  ON public.whatsapp_followups FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own wa followups" ON public.whatsapp_followups;
CREATE POLICY "Users can insert own wa followups"
  ON public.whatsapp_followups FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own wa followups" ON public.whatsapp_followups;
CREATE POLICY "Users can update own wa followups"
  ON public.whatsapp_followups FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own wa followups" ON public.whatsapp_followups;
CREATE POLICY "Users can delete own wa followups"
  ON public.whatsapp_followups FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ── Column-level grants: hide credential columns from the client ────────────
-- Postgres column privileges only apply when there is NO table-level SELECT,
-- so revoke the default table-wide grant and re-grant safe columns only.
-- (anon gets nothing at all: RLS has no anon policies and grants are revoked.)

REVOKE ALL    ON public.whatsapp_accounts FROM anon;
REVOKE SELECT, INSERT, UPDATE ON public.whatsapp_accounts FROM authenticated;
GRANT  SELECT (id, user_id, phone_number_id, waba_id, display_phone,
               display_name, verify_token, status, last_error,
               created_at, updated_at)
       ON public.whatsapp_accounts TO authenticated;
-- (DELETE stays granted table-level from defaults; RLS scopes it to the owner.)

REVOKE ALL ON public.whatsapp_conversations FROM anon;
REVOKE ALL ON public.whatsapp_messages      FROM anon;
REVOKE ALL ON public.whatsapp_followups     FROM anon;

-- ── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS whatsapp_conversations_user_id_idx
  ON public.whatsapp_conversations (user_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS whatsapp_conversations_member_id_idx
  ON public.whatsapp_conversations (member_id);

CREATE INDEX IF NOT EXISTS whatsapp_messages_conversation_idx
  ON public.whatsapp_messages (conversation_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS whatsapp_messages_user_id_idx
  ON public.whatsapp_messages (user_id);

-- The follow-up cron scans only due, still-pending rows.
CREATE INDEX IF NOT EXISTS whatsapp_followups_due_idx
  ON public.whatsapp_followups (send_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS whatsapp_followups_conversation_idx
  ON public.whatsapp_followups (conversation_id);

-- ── Realtime: live inbox updates ────────────────────────────────────────────
-- postgres_changes respects RLS, so subscribers only ever see their own rows.

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_messages;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_conversations;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Storage bucket for media (inbound downloads + outbound uploads) ─────────
-- Public bucket: WhatsApp media is sent to Meta "by link", so the URL must be
-- fetchable by Meta's servers. Paths are unguessable
-- (<user_id>/<conversation_id>/<uuid>.<ext>); uploads are owner-scoped.

INSERT INTO storage.buckets (id, name, public)
VALUES ('whatsapp-media', 'whatsapp-media', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "wa media owner upload" ON storage.objects;
CREATE POLICY "wa media owner upload"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'whatsapp-media'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "wa media owner delete" ON storage.objects;
CREATE POLICY "wa media owner delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'whatsapp-media'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── pg_cron: process due follow-ups every minute ────────────────────────────
-- NOT created here (the service-role key must never live in a repo file) —
-- apply once via the Supabase SQL editor, mirroring the intel-hub jobs:
--
-- SELECT cron.schedule('whatsapp-followups', '* * * * *',
--   $$ SELECT net.http_post(
--        url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/whatsapp-followups',
--        headers := jsonb_build_object(
--          'Content-Type',  'application/json',
--          'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'
--        ),
--        body    := '{}'::jsonb
--      ); $$);
