-- ═══════════════════════════════════════════════════════════════════════════
-- outreach_agent_config (2026-07-09)
--
-- Server-only key/value store for the generate-outreach edge function's
-- Claude Console Managed Agent provisioning state. The function lazily
-- provisions a persisted agent (POST /v1/environments + POST /v1/agents)
-- on the first request and stores {environment_id, agent_id, version,
-- system_hash} here under key 'managed_agent', so every subsequent
-- invocation reuses the same agent instead of creating one per request
-- (agents are persistent, versioned resources). When the system prompt in
-- the function's code changes, the stored system_hash no longer matches,
-- the function pushes a new agent version and updates this row (self-
-- healing versioning).
--
-- SERVICE-ROLE ONLY (security invariant #4: default-deny). RLS is enabled
-- with NO policies, and all privileges are revoked from anon/authenticated,
-- so the table is unreachable through PostgREST with client keys; only the
-- edge function's service role (which bypasses RLS) reads/writes it.
--
-- All statements are idempotent and non-destructive (safe to re-apply).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.outreach_agent_config (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.outreach_agent_config ENABLE ROW LEVEL SECURITY;

-- No policies on purpose: with RLS enabled and zero policies, anon and
-- authenticated get nothing even if a grant slipped through. The revokes
-- below are belt-and-suspenders.
REVOKE ALL ON public.outreach_agent_config FROM anon, authenticated, PUBLIC;
