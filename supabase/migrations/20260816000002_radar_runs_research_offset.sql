-- ═══════════════════════════════════════════════════════════════════════════
-- Radar: split the "research" stage per search angle (2026-08-16)
--
-- The "research" stage originally ran ONE Claude call covering all 2-3
-- search angles with up to 6 web searches. In production that single call
-- routinely exceeded the Edge Runtime's isolate wall-clock ceiling (~75s,
-- see comment in supabase/functions/generate-radar/index.ts) and got
-- silently killed mid-flight — no try/catch runs when that happens, so the
-- run stayed stuck at status='generating', progress=25 forever (the exact
-- failure mode the staged protocol was built to avoid, now hitting the
-- research stage too).
--
-- Fix: research is now driven one search angle per call (same idempotent
-- offset pattern already used by the decision_makers stage). This column
-- tracks how many angles have been completed so a resumed/retried run
-- knows where to continue.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.radar_runs
  ADD COLUMN IF NOT EXISTS research_offset INTEGER NOT NULL DEFAULT 0;
