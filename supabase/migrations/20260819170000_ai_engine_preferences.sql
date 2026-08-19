-- Per-feature AI engine preference.
--
-- Every AI feature in the app (Intelligence Hub, CODA AI, generación de
-- mensajes, AI Sales Coach, onboarding/enriquecimiento, Radar) can be routed
-- to Claude, OpenAI or Perplexity. The choice lives here, keyed by feature:
--
--   {"intel_hub":"perplexity","coda":"perplexity","outreach":"claude",
--    "coach":"openai","onboarding":"claude","radar":"claude"}
--
-- An absent key means "use the recommended engine", which is decided in code
-- (supabase/functions/_shared/llm.ts + js/ai-engine.js) so the recommendation
-- can change without a migration. Values are never passed through to a
-- provider: each edge function re-validates against its own allowlist.
--
-- No RLS/trigger changes needed: profiles_update_own already lets a user
-- update their own row, and the anti-escalation trigger only guards the
-- `role` column (see 20260701000001_security_hardening.sql).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ai_engines JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Belt-and-braces guard on top of the server-side allowlist: keep anything
-- that is not a flat object of known engine names out of the column, even if a
-- client writes the row directly. A CHECK cannot contain a subquery, so the
-- test lives in an IMMUTABLE helper.
CREATE OR REPLACE FUNCTION public.ai_engines_is_valid(v JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_typeof(v) = 'object'
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_each_text(v) AS e(key, value)
       WHERE e.value NOT IN ('claude', 'openai', 'perplexity')
     );
$$;

-- Default-deny: only the roles that actually write profiles need it. The
-- constraint is evaluated as the writing role, so `authenticated` (a user
-- saving their own preference) and `service_role` (signup / edge functions)
-- must keep EXECUTE.
REVOKE ALL ON FUNCTION public.ai_engines_is_valid(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_engines_is_valid(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ai_engines_is_valid(JSONB) TO authenticated, service_role;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_ai_engines_valid;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_ai_engines_valid
  CHECK (public.ai_engines_is_valid(ai_engines));
