-- Hub unlock flow: add country to onboarding + unlock state tracking
-- Supports the new 4-step onboarding (LinkedIn+Phone → Country → ICP → Generating)
-- and the post-entry "Unlock Intelligence" experience that replaces the inline survey.

-- 1. Country captured during onboarding step 2
ALTER TABLE public.intel_hub_intake
  ADD COLUMN IF NOT EXISTS country TEXT;

-- 2. Hub unlock state (false = locked overlay shown, true = hub fully revealed)
ALTER TABLE public.intel_hub_intake
  ADD COLUMN IF NOT EXISTS hub_unlocked       BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS hub_unlock_signals JSONB,
  ADD COLUMN IF NOT EXISTS hub_unlocked_at    TIMESTAMPTZ;

-- 3. Grandfather existing users who completed onboarding with the old survey
UPDATE public.intel_hub_intake
SET hub_unlocked    = TRUE,
    hub_unlocked_at = COALESCE(updated_at, NOW())
WHERE onboarding_complete = TRUE
  AND what_to_know IS NOT NULL
  AND LENGTH(TRIM(what_to_know)) >= 20;
