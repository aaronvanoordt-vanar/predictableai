-- client_pestel: PESTEL analysis per (client, target country).
--
-- CODA AI's PESTEL used to analyze the logged-in user's own company market
-- (coda_analysis.pestel*, one row per user_id). It now analyzes a specific
-- client's target market instead: the user picks one of their clients and
-- one of that client's target_countries (clients.target_countries), and the
-- generate-coda edge function researches THAT country's market for THAT
-- client's ICP/industry. A client can have PESTEL results cached per country
-- so switching the dropdown doesn't force a re-generation.
--
-- coda_analysis.pestel/pestel_status/pestel_error/pestel_generated_at are
-- left in place (unused going forward) rather than dropped, to avoid a
-- destructive change to a production table over an unrelated feature.

CREATE TABLE IF NOT EXISTS public.client_pestel (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           UUID        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
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

  CONSTRAINT client_pestel_client_country_key UNIQUE (client_id, country)
);

CREATE INDEX IF NOT EXISTS client_pestel_client_id_idx ON public.client_pestel (client_id);

DROP TRIGGER IF EXISTS client_pestel_touch ON public.client_pestel;
CREATE TRIGGER client_pestel_touch
  BEFORE UPDATE ON public.client_pestel
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Reuses can_view_client/can_manage_client from the clients migration.
-- Default-deny: nothing for anon/PUBLIC.

ALTER TABLE public.client_pestel ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_pestel FROM anon, public;

DROP POLICY IF EXISTS "client_pestel_select" ON public.client_pestel;
CREATE POLICY "client_pestel_select"
  ON public.client_pestel FOR SELECT
  TO authenticated
  USING (public.can_view_client(client_id));

-- Actual generation writes go through generate-coda (service role, bypasses
-- RLS). These insert/update policies exist for defense-in-depth consistency
-- with the rest of the clients schema, scoped to whoever can manage the client.
DROP POLICY IF EXISTS "client_pestel_insert" ON public.client_pestel;
CREATE POLICY "client_pestel_insert"
  ON public.client_pestel FOR INSERT
  TO authenticated
  WITH CHECK (public.can_manage_client(client_id));

DROP POLICY IF EXISTS "client_pestel_update" ON public.client_pestel;
CREATE POLICY "client_pestel_update"
  ON public.client_pestel FOR UPDATE
  TO authenticated
  USING (public.can_manage_client(client_id))
  WITH CHECK (public.can_manage_client(client_id));

DROP POLICY IF EXISTS "client_pestel_delete" ON public.client_pestel;
CREATE POLICY "client_pestel_delete"
  ON public.client_pestel FOR DELETE
  TO authenticated
  USING (public.can_manage_client(client_id));

-- Live status updates (generating → ready|error) without a manual refresh.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.client_pestel;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
