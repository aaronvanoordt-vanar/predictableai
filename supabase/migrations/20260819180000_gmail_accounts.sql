-- ═══════════════════════════════════════════════════════════════════════════
-- Gmail connections (Bandeja de Prospección) — 2026-08-19
--
-- Why this exists: Apollo's API reports THAT a prospect replied (replied,
-- reply_class) but never the reply itself — there is no inbound message type,
-- no thread endpoint, and the contact_ids / provider_thread_id filters on
-- /emailer_messages/search are silently ignored. What Apollo does give is
-- provider_thread_id, which for a Gmail-connected mailbox is the Gmail thread
-- id. Reading the actual conversation therefore has to go through Gmail.
--
-- Write model:
--   • gmail_accounts — written ONLY by the gmail-proxy edge function (service
--     role) after exchanging the OAuth code with Google. The client may SELECT
--     (minus the refresh token) and DELETE (disconnect).
--
-- The refresh token is never readable from the client: table-level SELECT is
-- revoked and re-granted column-by-column, exactly like whatsapp_accounts.
-- The client must therefore name columns explicitly (no select=*).
--
-- All statements are idempotent and non-destructive (safe to re-apply).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.gmail_accounts (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The mailbox that was authorised. Matched against Apollo's
  -- email_accounts[].email so the Bandeja knows which sequences it can open.
  email          TEXT        NOT NULL,
  -- Secret: consumed only by the gmail-proxy edge function (service role).
  -- Column-level grants below hide it from the client; RLS hides the whole
  -- row from other users either way.
  refresh_token  TEXT        NOT NULL,
  scopes         TEXT[]      NOT NULL DEFAULT '{}',
  status         TEXT        NOT NULL DEFAULT 'connected'
                 CHECK (status IN ('connected', 'error')),
  last_error     TEXT,
  connected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.gmail_accounts ENABLE ROW LEVEL SECURITY;

-- ── RLS: owner-scoped read + disconnect. No client INSERT/UPDATE at all ─────
-- (writing is the edge function's job, after Google has actually validated
-- the grant — a client-writable row would let anyone claim any mailbox).

DROP POLICY IF EXISTS "Users can read own gmail account" ON public.gmail_accounts;
CREATE POLICY "Users can read own gmail account"
  ON public.gmail_accounts FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can disconnect own gmail account" ON public.gmail_accounts;
CREATE POLICY "Users can disconnect own gmail account"
  ON public.gmail_accounts FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ── Column-level grants: hide the refresh token from the client ─────────────
-- Postgres column privileges only apply when there is NO table-level SELECT,
-- so revoke the default table-wide grant and re-grant safe columns only.

REVOKE ALL ON public.gmail_accounts FROM anon;
REVOKE SELECT, INSERT, UPDATE ON public.gmail_accounts FROM authenticated;
GRANT  SELECT (id, user_id, email, scopes, status, last_error,
               connected_at, updated_at)
       ON public.gmail_accounts TO authenticated;
-- (DELETE stays granted table-level from defaults; RLS scopes it to the owner.)

CREATE INDEX IF NOT EXISTS gmail_accounts_user_id_idx
  ON public.gmail_accounts (user_id);
