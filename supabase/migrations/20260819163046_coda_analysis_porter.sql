-- coda_analysis: add the "porter" block (Porter's Five Forces).
--
-- This migration documents a change that was already applied directly to
-- production (outside this repo) before this PR — the porter_* columns and
-- their check constraint already exist live. This file exists so the repo's
-- migration history matches the database going forward; it's written
-- idempotently so re-running it is a no-op.
--
-- Shape: { "rivalidad": [{ "factor", "impact": "high|medium|low",
--           "sales_impact", "action" }], "nuevos_entrantes": [...],
--           "sustitutos": [...], "poder_clientes": [...],
--           "poder_proveedores": [...] }

ALTER TABLE public.coda_analysis
  ADD COLUMN IF NOT EXISTS porter              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS porter_status       TEXT        NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS porter_error        TEXT,
  ADD COLUMN IF NOT EXISTS porter_generated_at TIMESTAMPTZ;

DO $$
BEGIN
  ALTER TABLE public.coda_analysis
    ADD CONSTRAINT coda_analysis_porter_status_check
    CHECK (porter_status IN ('idle','generating','ready','error'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
