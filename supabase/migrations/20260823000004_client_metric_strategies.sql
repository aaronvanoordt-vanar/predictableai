-- ═══════════════════════════════════════════════════════════════════════════
-- Client metric remediation strategies (2026-08-23)
--
-- The Clients dashboard now shows each CRM ratio against its minimum
-- acceptable threshold (open/reply/conversion rate = floor, no-show /
-- disqualified rate = ceiling). When a ratio is below threshold, the team
-- enters a remediation strategy for it — stored here so it's also visible
-- (read-only) in the client's portal (client.html?token=…), same treatment
-- as crm_metrics: team-authored operational data, not client-editable.
--
-- Idempotent / non-destructive: safe to re-apply.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS metric_strategies JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.clients.metric_strategies IS
  'Remediation strategy per CRM ratio below its minimum threshold. Keys: open, reply, conversion, no_show, disqualified. Edited by the team in Clients; read-only in the client portal.';
