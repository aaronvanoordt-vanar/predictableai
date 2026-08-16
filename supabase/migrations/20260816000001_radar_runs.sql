-- ═══════════════════════════════════════════════════════════════════════════
-- Radar (2026-08-16) — AI target-company discovery
--
-- One row per investigation run. The generate-radar edge function (service
-- role) owns ALL writes: it derives a signal hypothesis from the seller's
-- context (or the user's custom prompt), deep-researches the web for ≥5
-- companies showing that buying signal, attaches evidence URLs, and pulls
-- 2-3 decision makers per company from Apollo (names/titles/LinkedIn only —
-- no contact reveals, no credit spend on enrichment).
--
-- Client access is SELECT-only (owner-scoped): the UI reads the run to show
-- live progress narration (progress/progress_step/progress_log via Realtime)
-- and the final results (companies jsonb).
--
-- companies jsonb shape (written by generate-radar):
--   [{ name, website, country, industry, employee_count, why_fit,
--      signal_strength: 'alta'|'media',
--      evidence: [{ url, summary }],
--      decision_makers: [{ apollo_person_id, name, title, linkedin_url,
--                          company_domain, city, country }] }]
--
-- All statements are idempotent and non-destructive (safe to re-apply).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.radar_runs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  status            TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'generating', 'ready', 'error')),

  -- Live narration for the onboarding aha screen (0-100 + running log).
  progress          INTEGER     NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_step     TEXT,
  progress_log      JSONB       NOT NULL DEFAULT '[]'::jsonb, -- [{at, text}]

  -- 'auto' = hypothesis derived by the AI from seller context (onboarding);
  -- 'custom' = the user wrote their own signal prompt (re-run).
  source            TEXT        NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'custom')),
  custom_prompt     TEXT,

  -- The signal the AI decided to hunt, in Spanish, shown to the user
  -- ("Voy a buscar X porque Y").
  signal_hypothesis TEXT,
  signal_strategy   JSONB       NOT NULL DEFAULT '{}'::jsonb, -- research plan (angles/queries/sources)

  companies         JSONB       NOT NULL DEFAULT '[]'::jsonb,

  error_message     TEXT,
  credits_charged   INTEGER     NOT NULL DEFAULT 0,
  generated_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── updated_at trigger (reuses public.set_updated_at) ───────────────────────

DROP TRIGGER IF EXISTS radar_runs_updated_at ON public.radar_runs;
CREATE TRIGGER radar_runs_updated_at
  BEFORE UPDATE ON public.radar_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS: default-deny; owner may only read ──────────────────────────────────
-- Writes go exclusively through the generate-radar edge function (service
-- role bypasses RLS). No INSERT/UPDATE/DELETE policies on purpose.

ALTER TABLE public.radar_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.radar_runs FROM anon, PUBLIC;

DROP POLICY IF EXISTS "Users can view own radar runs" ON public.radar_runs;
CREATE POLICY "Users can view own radar runs"
  ON public.radar_runs FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS radar_runs_user_created_idx
  ON public.radar_runs (user_id, created_at DESC);

-- ── Realtime: the UI subscribes to UPDATEs for live progress narration ──────

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.radar_runs;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
