-- Let users choose which Claude model generates their Intelligence Hub
-- sections. Nullable — null means "use the platform default" (the
-- cheapest/oldest active model, chosen server-side in generate-intel-hub
-- to keep credit usage low unless a user opts into a pricier model).
-- No RLS/trigger changes needed: profiles_update_own already lets a user
-- update their own row, and the anti-escalation trigger only guards the
-- `role` column (see 20260701000001_security_hardening.sql).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS preferred_claude_model TEXT;
