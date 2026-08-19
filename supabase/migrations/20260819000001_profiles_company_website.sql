-- Onboarding now accepts the company website as an alternative to LinkedIn
-- (some users don't have/want to paste a LinkedIn company page). Mirrors
-- profiles.linkedin_company_url so the "onboarded" gate in auth-guard.js /
-- auth.js / miforms.js can recognize either identifier without a join
-- against intel_hub_intake.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS company_website TEXT;
