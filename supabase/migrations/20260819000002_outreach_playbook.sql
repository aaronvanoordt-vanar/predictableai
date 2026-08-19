-- ═══════════════════════════════════════════════════════════════════════════
-- outreach_playbooks (2026-08-19) — "Tendencias de outbound"
--
-- One row per user holding the result of a periodic web investigation into
-- what is ACTUALLY working in cold outreach right now: specialized forums
-- (r/sales, r/coldemail, r/Emailmarketing), vendor research and academies
-- (Apollo.io, Lavender, Gong Labs, Belkins, Smartlead…), and practitioner
-- posts. Produced by the generate-outreach-playbook edge function and read
-- by generate-outreach, which folds it into the message-crafting prompt.
--
-- It is a RECOMMENDATION layer, never a constraint: `enabled` toggles whether
-- generate-outreach applies it, and the hard rules of the outreach engine
-- (mandatory opener, word limits, no invented data) always win over a trend.
--
-- Cadence: 'manual' | 'weekly' | 'monthly'. The scheduler sweep picks up rows
-- whose cadence is not 'manual' and whose next_refresh_at has passed (or is
-- NULL, i.e. the cadence was turned on after the last run).
--
-- All statements are idempotent and non-destructive (safe to re-apply).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.outreach_playbooks (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Preferences (owner-writable)
  enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
  cadence       TEXT        NOT NULL DEFAULT 'monthly'
                            CHECK (cadence IN ('manual', 'weekly', 'monthly')),

  -- Lifecycle
  status        TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'generating', 'ready', 'error')),
  error_message TEXT,

  -- Research payload (all Spanish-facing text, every claim source-backed)
  headline      TEXT,                                  -- 1 línea: el cambio más relevante del ciclo
  summary       TEXT,                                  -- 3-5 frases
  principles    JSONB NOT NULL DEFAULT '[]'::JSONB,    -- [{title, insight, why, evidence, source_url, confidence}]
  openers       JSONB NOT NULL DEFAULT '[]'::JSONB,    -- [{pattern, example, when, source_url}]
  subject_lines JSONB NOT NULL DEFAULT '[]'::JSONB,    -- [{pattern, example, source_url}]
  structure     JSONB NOT NULL DEFAULT '{}'::JSONB,    -- {length, paragraphs, cta_style, personalization, follow_up}
  channels      JSONB NOT NULL DEFAULT '[]'::JSONB,    -- [{channel, verdict, note, source_url}]
  avoid         JSONB NOT NULL DEFAULT '[]'::JSONB,    -- [{what, why, source_url}]
  experiments   JSONB NOT NULL DEFAULT '[]'::JSONB,    -- [{hypothesis, how_to_test}]
  sources       JSONB NOT NULL DEFAULT '[]'::JSONB,    -- [{title, url, kind, date}]

  -- Run metadata
  last_trigger    TEXT CHECK (last_trigger IN ('manual', 'schedule')),
  generated_at    TIMESTAMPTZ,
  next_refresh_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS outreach_playbooks_due_idx
  ON public.outreach_playbooks (next_refresh_at)
  WHERE cadence <> 'manual';

ALTER TABLE public.outreach_playbooks ENABLE ROW LEVEL SECURITY;

-- Default-deny: nothing for anon/PUBLIC, owner-scoped for authenticated.
REVOKE ALL ON public.outreach_playbooks FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.outreach_playbooks TO authenticated;

DROP POLICY IF EXISTS "own playbook select" ON public.outreach_playbooks;
CREATE POLICY "own playbook select"
  ON public.outreach_playbooks FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "own playbook insert" ON public.outreach_playbooks;
CREATE POLICY "own playbook insert"
  ON public.outreach_playbooks FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own playbook update" ON public.outreach_playbooks;
CREATE POLICY "own playbook update"
  ON public.outreach_playbooks FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Reuse the shared updated_at trigger function (created in the client_icp migration)
DROP TRIGGER IF EXISTS outreach_playbooks_touch ON public.outreach_playbooks;
CREATE TRIGGER outreach_playbooks_touch
  BEFORE UPDATE ON public.outreach_playbooks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── pg_cron schedule (manual step, like the Intelligence Hub schedules) ────
-- The sweep endpoint authenticates with the SCHEDULER_SECRET header, not the
-- service-role JWT, so the cron body only needs to say "sweep".
--
-- SELECT cron.schedule('outreach-playbook-sweep', '0 6 * * 1',   /* lunes 06:00 */
--   $$ SELECT net.http_post(
--     url     := 'https://<SUPABASE_URL>/functions/v1/generate-outreach-playbook',
--     headers := jsonb_build_object('Content-Type','application/json',
--                                   'X-Playbook-Secret','<SCHEDULER_SECRET>'),
--     body    := '{"sweep":true}'::jsonb) $$);
--
-- Una sola corrida semanal cubre ambas cadencias: la función solo toma las
-- filas cuyo next_refresh_at ya venció (7 días para 'weekly', 30 para
-- 'monthly'), así que las mensuales simplemente se saltan las semanas que no
-- les tocan.
