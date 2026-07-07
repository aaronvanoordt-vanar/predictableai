-- ═══════════════════════════════════════════════════════════════════════════
-- Saved Apollo searches (Search People — 2026-07-07)
--
-- Lets a user save a Búsqueda's filter criteria under a name and re-run it
-- later, instead of rebuilding the same filters from scratch every time.
-- Client-writable, owner-scoped RLS — same pattern as prospect_lists.
--
-- All statements are idempotent and non-destructive (safe to re-apply).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.prospect_saved_searches (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  filters     JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prospect_saved_searches_user_id_name_key UNIQUE (user_id, name)
);

DROP TRIGGER IF EXISTS prospect_saved_searches_updated_at ON public.prospect_saved_searches;
CREATE TRIGGER prospect_saved_searches_updated_at
  BEFORE UPDATE ON public.prospect_saved_searches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.prospect_saved_searches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own saved searches" ON public.prospect_saved_searches;
CREATE POLICY "Users can view own saved searches"
  ON public.prospect_saved_searches FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own saved searches" ON public.prospect_saved_searches;
CREATE POLICY "Users can insert own saved searches"
  ON public.prospect_saved_searches FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own saved searches" ON public.prospect_saved_searches;
CREATE POLICY "Users can update own saved searches"
  ON public.prospect_saved_searches FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own saved searches" ON public.prospect_saved_searches;
CREATE POLICY "Users can delete own saved searches"
  ON public.prospect_saved_searches FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS prospect_saved_searches_user_id_idx
  ON public.prospect_saved_searches (user_id);
