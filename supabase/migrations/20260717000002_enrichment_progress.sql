-- enrich-company now runs as discrete steps (LinkedIn search, then website
-- search) instead of one opaque call, so the client can show a real
-- percentage instead of an indeterminate spinner.

ALTER TABLE public.intel_hub_intake
  ADD COLUMN IF NOT EXISTS company_enrichment_progress SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS company_enrichment_step     TEXT;

DO $$
BEGIN
  ALTER TABLE public.intel_hub_intake
    ADD CONSTRAINT intel_hub_intake_enrichment_progress_range
    CHECK (company_enrichment_progress BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
