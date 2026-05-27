-- Simplify onboarding: phone moves to profiles, country step removed.
-- The 2-step onboarding (LinkedIn+phone → ICP) writes phone directly
-- to profiles so it's accessible to the rest of the app without joining
-- through intel_hub_intake.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS phone TEXT;
