-- ═══════════════════════════════════════════════════════════════════════════
-- prospect_list_members.outreach_status (2026-07-08)
--
-- The "Generando mensajes con IA" indicator lived only in browser memory
-- (js/prospecting.js state.wa.generating), so reloading the page mid-batch
-- made it look like nothing was happening even when a generation was still
-- in flight server-side — the user had no signal and would re-trigger it,
-- wasting a duplicate Anthropic call for the same lead.
--
-- This column is written by the client (RLS owner-scoped, same as every
-- other prospect_list_members column) right before it calls the
-- generate-outreach edge function, and overwritten by that function itself
-- (service role) once it succeeds or fails — so the status is accurate
-- across a reload regardless of whether the original tab is still alive.
--
-- All statements are idempotent and non-destructive (safe to re-apply).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.prospect_list_members
  ADD COLUMN IF NOT EXISTS outreach_status TEXT NOT NULL DEFAULT 'idle';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prospect_list_members_outreach_status_check'
  ) THEN
    ALTER TABLE public.prospect_list_members
      ADD CONSTRAINT prospect_list_members_outreach_status_check
      CHECK (outreach_status IN ('idle', 'generating', 'ready', 'error'));
  END IF;
END $$;

-- Backfill: rows that already have a generated message should read as 'ready'.
UPDATE public.prospect_list_members
  SET outreach_status = 'ready'
  WHERE outreach_status = 'idle' AND outreach ? 'generated_at';
