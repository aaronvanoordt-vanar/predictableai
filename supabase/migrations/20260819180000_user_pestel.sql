-- user_pestel: PESTEL analysis per (user, country) — the client-less mode.
--
-- PESTEL used to REQUIRE picking a client (client_pestel, one row per
-- (client_id, country)). Clients is an internal Vanar tool, so requiring one
-- blocked every other user from even trying the PESTEL. The client pick is now
-- optional: with no client, the analysis is scoped to the user's OWN company
-- context (intel_hub_intake + client_brief + profile, same context Porter
-- uses) for the chosen country, and lands here instead of client_pestel.
--
-- Same shape/semantics as client_pestel, keyed by user instead of client, so
-- results stay cached per country and switching the country dropdown doesn't
-- force a re-generation.
--
-- (coda_analysis.pestel* — the original per-user PESTEL columns — stay unused;
-- they hold a single row per user with no country, which is why this is a new
-- table rather than a revival of those columns.)

CREATE TABLE IF NOT EXISTS public.user_pestel (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  country             TEXT        NOT NULL CHECK (char_length(country) BETWEEN 1 AND 80),

  -- Shape: { "political": [{ "factor", "impact": "high|medium|low",
  --           "sales_impact", "action" }], ... }
  -- keys: political, economic, social, technological, environmental, legal
  pestel              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  pestel_status       TEXT        NOT NULL DEFAULT 'idle'
                                  CHECK (pestel_status IN ('idle','generating','ready','error')),
  pestel_error        TEXT,
  pestel_generated_at TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT user_pestel_user_country_key UNIQUE (user_id, country)
);

CREATE INDEX IF NOT EXISTS user_pestel_user_id_idx ON public.user_pestel (user_id);

DROP TRIGGER IF EXISTS user_pestel_touch ON public.user_pestel;
CREATE TRIGGER user_pestel_touch
  BEFORE UPDATE ON public.user_pestel
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Default-deny: nothing for anon/PUBLIC, owner-scoped for authenticated.
ALTER TABLE public.user_pestel ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_pestel FROM anon, public;

DROP POLICY IF EXISTS "own user_pestel select" ON public.user_pestel;
CREATE POLICY "own user_pestel select"
  ON public.user_pestel FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Generation writes go through generate-coda (service role, bypasses RLS).
-- These exist for defense-in-depth consistency with the rest of the schema.
DROP POLICY IF EXISTS "own user_pestel insert" ON public.user_pestel;
CREATE POLICY "own user_pestel insert"
  ON public.user_pestel FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own user_pestel update" ON public.user_pestel;
CREATE POLICY "own user_pestel update"
  ON public.user_pestel FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own user_pestel delete" ON public.user_pestel;
CREATE POLICY "own user_pestel delete"
  ON public.user_pestel FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Live status updates (generating → ready|error) without a manual refresh.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.user_pestel;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
