-- ═══════════════════════════════════════════════════════════════════════════
-- Prospect lists (prospecting-architecture redesign — 2026-07-04)
--
-- Persists per-user prospect lists and their members, replacing the
-- localStorage-only lists the frontend kept before (which were lost on
-- device/browser change and invisible to edge functions).
--
-- DELIBERATE DESIGN DEPARTURE from intelligence_hub_reports: those tables
-- are service-role-write-only (edge functions own all writes). These two
-- tables are CLIENT-WRITABLE on purpose — the browser creates lists and
-- adds/edits/removes members directly through PostgREST, gated by
-- owner-scoped RLS (auth.uid() = user_id on every command, INSERT included).
-- The only server-side writer is the apollo-webhook edge function, which
-- uses the service role (bypasses RLS) to fill in asynchronously revealed
-- phone numbers on rows with phone_status = 'pending'.
--
-- prospect_list_members.user_id is denormalized from the parent list so RLS
-- checks never need a join.
--
-- All statements are idempotent and non-destructive (safe to re-apply).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.prospect_lists (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prospect_lists_user_id_name_key UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS public.prospect_list_members (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id           UUID        NOT NULL REFERENCES public.prospect_lists(id) ON DELETE CASCADE,
  -- Denormalized owner (matches the parent list's user_id) so RLS is join-free.
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  apollo_person_id  TEXT,
  apollo_contact_id TEXT,
  first_name        TEXT,
  last_name         TEXT,
  name              TEXT,
  title             TEXT,
  company           TEXT,
  company_domain    TEXT,
  linkedin_url      TEXT,
  email             TEXT,
  email_status      TEXT,
  phone             TEXT,
  phone_status      TEXT        NOT NULL DEFAULT 'none'
                    CHECK (phone_status IN ('none', 'pending', 'revealed', 'unavailable')),
  city              TEXT,
  state             TEXT,
  country           TEXT,
  snapshot          JSONB       NOT NULL DEFAULT '{}',
  enriched_at       TIMESTAMPTZ,
  outreach          JSONB       NOT NULL DEFAULT '{}',
  sequence_status   JSONB       NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL apollo_person_id (manually added contacts) never collides.
  CONSTRAINT prospect_list_members_list_person_key UNIQUE (list_id, apollo_person_id)
);

-- ── updated_at triggers (reuses public.set_updated_at from client_icp) ──────

DROP TRIGGER IF EXISTS prospect_lists_updated_at ON public.prospect_lists;
CREATE TRIGGER prospect_lists_updated_at
  BEFORE UPDATE ON public.prospect_lists
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS prospect_list_members_updated_at ON public.prospect_list_members;
CREATE TRIGGER prospect_list_members_updated_at
  BEFORE UPDATE ON public.prospect_list_members
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS: owner-scoped on every command ──────────────────────────────────────

ALTER TABLE public.prospect_lists        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospect_list_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own prospect lists" ON public.prospect_lists;
CREATE POLICY "Users can view own prospect lists"
  ON public.prospect_lists FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own prospect lists" ON public.prospect_lists;
CREATE POLICY "Users can insert own prospect lists"
  ON public.prospect_lists FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own prospect lists" ON public.prospect_lists;
CREATE POLICY "Users can update own prospect lists"
  ON public.prospect_lists FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own prospect lists" ON public.prospect_lists;
CREATE POLICY "Users can delete own prospect lists"
  ON public.prospect_lists FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own list members" ON public.prospect_list_members;
CREATE POLICY "Users can view own list members"
  ON public.prospect_list_members FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own list members" ON public.prospect_list_members;
CREATE POLICY "Users can insert own list members"
  ON public.prospect_list_members FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own list members" ON public.prospect_list_members;
CREATE POLICY "Users can update own list members"
  ON public.prospect_list_members FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own list members" ON public.prospect_list_members;
CREATE POLICY "Users can delete own list members"
  ON public.prospect_list_members FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS prospect_lists_user_id_idx
  ON public.prospect_lists (user_id);

CREATE INDEX IF NOT EXISTS prospect_list_members_list_id_idx
  ON public.prospect_list_members (list_id);

CREATE INDEX IF NOT EXISTS prospect_list_members_user_id_idx
  ON public.prospect_list_members (user_id);

-- apollo-webhook looks rows up by apollo_person_id while phone_status is
-- still 'pending' — a partial index keeps that lookup cheap and tiny.
CREATE INDEX IF NOT EXISTS prospect_list_members_pending_phone_idx
  ON public.prospect_list_members (apollo_person_id)
  WHERE phone_status = 'pending';
