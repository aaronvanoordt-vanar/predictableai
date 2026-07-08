-- ═══════════════════════════════════════════════════════════════════════════
-- sales-coach backend — migrates the meeting-coach storage from Google Sheets
-- (Apps Script "Ventas AI") into Postgres.
--
-- Tables (Sheets → Postgres):
--   coach_meetings          ← sheet "meetings" (incl. the v3 outcome columns)
--   coach_transcript_chunks ← sheet "transcript_chunks"
--   coach_events            ← sheet "coaching_events"
--   meeting_objections      ← NEW: real objections extracted from each final
--                             report, denormalized per SDR so the objections
--                             report can aggregate without parsing JSON.
--
-- Security (CLAUDE.md invariant #4 — default deny):
--   RLS is ENABLED on all four tables with NO client-facing policies, and ALL
--   privileges are revoked from anon/authenticated/PUBLIC. Every access path
--   goes through the `sales-coach` edge function using the service role
--   (which bypasses RLS) and enforces role scoping in code:
--   SDR = own rows, admin/director = team-wide.
--
-- Note: coach_meetings.user_id uses ON DELETE CASCADE (like sales_reports)
-- so public.delete_my_account() keeps working; a plain FK would block auth
-- user deletion while coach rows exist.
--
-- All statements are idempotent and non-destructive (safe to re-apply).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── coach_meetings ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.coach_meetings (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  recall_bot_id     TEXT,
  meeting_url       TEXT,
  prospect_id       TEXT,
  prospect_name     TEXT,
  sdr_email         TEXT        NOT NULL,
  user_id           UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at        TIMESTAMPTZ DEFAULT NOW(),
  status            TEXT        DEFAULT 'live',      -- live | closed | error
  context           JSONB       DEFAULT '{}'::jsonb, -- lead context handed by the frontend
  last_state        JSONB,                           -- latest coach state (live analysis)
  final_report      JSONB,                           -- full final report (schema in sales-coach/index.ts)
  score_total       INT         DEFAULT 0,
  outcome           TEXT,                            -- ganado | perdido | seguimiento | sin_respuesta
  outcome_note      TEXT,
  outcome_at        TIMESTAMPTZ,
  top_objection     TEXT,
  deal_value        NUMERIC,
  next_meeting_date TIMESTAMPTZ,
  tags              TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS coach_meetings_sdr_email_idx
  ON public.coach_meetings(sdr_email, started_at DESC);

DROP TRIGGER IF EXISTS coach_meetings_updated_at ON public.coach_meetings;
CREATE TRIGGER coach_meetings_updated_at
  BEFORE UPDATE ON public.coach_meetings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── coach_transcript_chunks ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.coach_transcript_chunks (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meeting_id UUID        REFERENCES public.coach_meetings(id) ON DELETE CASCADE,
  ts         TIMESTAMPTZ DEFAULT NOW(),
  speaker    TEXT,
  text       TEXT,
  analyzed   BOOLEAN     DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS coach_transcript_chunks_meeting_ts_idx
  ON public.coach_transcript_chunks(meeting_id, ts);

-- ── coach_events ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.coach_events (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID        REFERENCES public.coach_meetings(id) ON DELETE CASCADE,
  ts         TIMESTAMPTZ DEFAULT NOW(),
  alerts     JSONB       DEFAULT '[]'::jsonb,
  state      JSONB       DEFAULT '{}'::jsonb,
  next_steps JSONB       DEFAULT '[]'::jsonb,
  summary    TEXT
);

CREATE INDEX IF NOT EXISTS coach_events_meeting_ts_idx
  ON public.coach_events(meeting_id, ts);

-- ── meeting_objections ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.meeting_objections (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id         UUID        REFERENCES public.coach_meetings(id) ON DELETE CASCADE,
  user_id            UUID,
  sdr_email          TEXT        NOT NULL,
  objection          TEXT        NOT NULL,
  categoria          TEXT,       -- precio|timing|autoridad|necesidad|confianza|competencia|otro
  quote              TEXT,       -- textual quote from the transcript (never invented)
  how_handled        TEXT,
  result             TEXT,       -- superada|parcial|no_resuelta
  suggested_response TEXT,
  prospect_name      TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS meeting_objections_sdr_email_idx
  ON public.meeting_objections(sdr_email);
CREATE INDEX IF NOT EXISTS meeting_objections_categoria_idx
  ON public.meeting_objections(categoria);

-- ── Default deny: RLS on, no policies, no client grants ────────────────────
ALTER TABLE public.coach_meetings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coach_transcript_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coach_events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_objections      ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.coach_meetings          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.coach_transcript_chunks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.coach_events            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.meeting_objections      FROM PUBLIC, anon, authenticated;

-- The identity column's sequence must not be usable from the browser either.
DO $$
DECLARE seq TEXT;
BEGIN
  seq := pg_get_serial_sequence('public.coach_transcript_chunks', 'id');
  IF seq IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated', seq);
  END IF;
END $$;
