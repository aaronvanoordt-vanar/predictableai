-- ═══════════════════════════════════════════════════════════════════════════
-- Client follow-ups (2026-08-24)
--
-- The Clients dashboard was missing a place to track pending follow-up
-- actions on an account (e.g. "revisar propuesta comercial", "llamar para
-- renovación"). Adds a lightweight checklist, same treatment as crm_metrics /
-- metric_strategies: team-authored operational data, edited from Clients,
-- not exposed to the client portal.
--
-- Shape: JSONB array of { id, text, due_date, done, created_at }.
--
-- Idempotent / non-destructive: safe to re-apply.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS follow_ups JSONB NOT NULL DEFAULT '[]';

COMMENT ON COLUMN public.clients.follow_ups IS
  'Pending follow-up checklist for the account: [{ id, text, due_date, done, created_at }]. Edited by the team in Clients; not exposed to the client portal.';
