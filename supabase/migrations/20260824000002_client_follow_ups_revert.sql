-- ═══════════════════════════════════════════════════════════════════════════
-- Revert client_follow_ups checklist column (2026-08-24)
--
-- 20260824000001_client_follow_ups.sql added clients.follow_ups (JSONB array)
-- to back a standalone checklist UI. That approach was wrong: the ask was for
-- "follow ups pendientes" to be one more manual metric inside the existing
-- CRM "Datos críticos" grid, with its rate (pendientes / reuniones tomadas)
-- alongside the other umbrales mínimos aceptables — not a separate checklist
-- section. That metric now lives as a key inside the existing
-- clients.crm_metrics JSONB (same as contacted/opened/replied/etc.), so the
-- follow_ups column is unused.
--
-- Safe to drop: the column was applied to production only minutes before this
-- migration and the checklist UI never shipped to users, so no real data was
-- ever written to it.
--
-- Idempotent / safe to re-apply.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.clients
  DROP COLUMN IF EXISTS follow_ups;
