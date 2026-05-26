-- Expand intel_hub_intake: make what_to_know nullable, add onboarding
-- progress tracking, company enrichment, ICP, and value proposition fields.

-- 1. Relax NOT NULL on what_to_know (collected in step 2, not step 1)
ALTER TABLE public.intel_hub_intake
  ALTER COLUMN what_to_know DROP NOT NULL;

-- 2. Onboarding progress
ALTER TABLE public.intel_hub_intake
  ADD COLUMN IF NOT EXISTS phone                   TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_step         INTEGER  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS onboarding_complete     BOOLEAN  NOT NULL DEFAULT FALSE;

-- 3. Company enrichment (populated by enrich-company edge function)
ALTER TABLE public.intel_hub_intake
  ADD COLUMN IF NOT EXISTS company_industry          TEXT,
  ADD COLUMN IF NOT EXISTS company_employee_count    TEXT,
  ADD COLUMN IF NOT EXISTS company_country           TEXT,
  ADD COLUMN IF NOT EXISTS company_website           TEXT,
  ADD COLUMN IF NOT EXISTS company_about             TEXT,
  ADD COLUMN IF NOT EXISTS company_solutions         TEXT,
  ADD COLUMN IF NOT EXISTS company_enrichment_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS company_enrichment_at     TIMESTAMPTZ;

-- 4. ICP (Ideal Customer Profile)
ALTER TABLE public.intel_hub_intake
  ADD COLUMN IF NOT EXISTS icp_company_sizes  TEXT,
  ADD COLUMN IF NOT EXISTS icp_industries     TEXT,
  ADD COLUMN IF NOT EXISTS icp_roles          TEXT,
  ADD COLUMN IF NOT EXISTS icp_geographies    TEXT,
  ADD COLUMN IF NOT EXISTS icp_pain_points    TEXT;

-- 5. Value proposition
ALTER TABLE public.intel_hub_intake
  ADD COLUMN IF NOT EXISTS value_problem_solved TEXT,
  ADD COLUMN IF NOT EXISTS value_proposition    TEXT,
  ADD COLUMN IF NOT EXISTS value_success_cases  TEXT;
