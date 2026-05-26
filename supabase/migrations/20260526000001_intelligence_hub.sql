-- ═══════════════════════════════════════════════════════════════════════════
-- Intelligence Hub: reports, credits, and credit transactions
-- ═══════════════════════════════════════════════════════════════════════════

-- ── intelligence_hub_reports ──────────────────────────────────────────────
-- One row per (user, section). Written exclusively by the edge function
-- using service_role; frontend reads via anon key + RLS.

CREATE TABLE IF NOT EXISTS public.intelligence_hub_reports (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  section_key     VARCHAR(100) NOT NULL,
  cadence         VARCHAR(20)  NOT NULL CHECK (cadence IN ('daily','weekly','monthly','quarterly','yearly')),
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','generating','ready','error')),
  content         JSONB,
  error_message   TEXT,
  generated_at    TIMESTAMPTZ,
  next_refresh_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, section_key)
);

CREATE INDEX IF NOT EXISTS ihr_user_id_idx          ON public.intelligence_hub_reports (user_id);
CREATE INDEX IF NOT EXISTS ihr_next_refresh_at_idx  ON public.intelligence_hub_reports (next_refresh_at)
  WHERE status = 'ready';

ALTER TABLE public.intelligence_hub_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own reports"   ON public.intelligence_hub_reports;
CREATE POLICY "users read own reports"
  ON public.intelligence_hub_reports FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

-- No insert/update policy for regular users — only service_role writes.

CREATE OR REPLACE FUNCTION public.ihr_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS ihr_touch ON public.intelligence_hub_reports;
CREATE TRIGGER ihr_touch
  BEFORE UPDATE ON public.intelligence_hub_reports
  FOR EACH ROW EXECUTE FUNCTION public.ihr_touch_updated_at();


-- ── user_credits ──────────────────────────────────────────────────────────
-- One row per user. New users get 10 free credits via trigger below.

CREATE TABLE IF NOT EXISTS public.user_credits (
  user_id    UUID    PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance    INT     NOT NULL DEFAULT 10 CHECK (balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.user_credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own credits" ON public.user_credits;
CREATE POLICY "users read own credits"
  ON public.user_credits FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.uc_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS uc_touch ON public.user_credits;
CREATE TRIGGER uc_touch
  BEFORE UPDATE ON public.user_credits
  FOR EACH ROW EXECUTE FUNCTION public.uc_touch_updated_at();

-- Auto-create credits row when a new user signs up.
CREATE OR REPLACE FUNCTION public.handle_new_user_credits()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.user_credits (user_id, balance)
  VALUES (NEW.id, 10)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_credits ON auth.users;
CREATE TRIGGER on_auth_user_created_credits
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_credits();


-- ── credit_transactions ───────────────────────────────────────────────────
-- Audit log. Negative delta = deduction; positive = top-up.

CREATE TABLE IF NOT EXISTS public.credit_transactions (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  delta       INT          NOT NULL,
  reason      VARCHAR(200) NOT NULL,
  section_key VARCHAR(100),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ct_user_id_idx ON public.credit_transactions (user_id);

ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own transactions" ON public.credit_transactions;
CREATE POLICY "users read own transactions"
  ON public.credit_transactions FOR SELECT
  TO authenticated USING (auth.uid() = user_id);


-- ── pg_cron schedules ─────────────────────────────────────────────────────
-- Requires the pg_cron + pg_net extensions to be enabled in Supabase.
-- Replace <SUPABASE_URL> and <SERVICE_ROLE_KEY> with real values,
-- or manage these via Supabase Dashboard → Database → Extensions → pg_cron.
--
-- Example (run manually in SQL editor after enabling extensions):
--
-- SELECT cron.schedule('intel-hub-daily',   '0 7 * * *',
--   $$ SELECT net.http_post(
--     url    := 'https://<SUPABASE_URL>/functions/v1/schedule-intel-hub',
--     headers := jsonb_build_object('Content-Type','application/json',
--                                   'Authorization','Bearer <SERVICE_ROLE_KEY>'),
--     body   := '{"cadence":"daily"}'::jsonb) $$);
--
-- SELECT cron.schedule('intel-hub-weekly',  '0 7 * * 1',   /* Monday */
--   $$ ... body := '{"cadence":"weekly"}' $$);
--
-- SELECT cron.schedule('intel-hub-monthly', '0 7 1 * *',   /* 1st of month */
--   $$ ... body := '{"cadence":"monthly"}' $$);
--
-- SELECT cron.schedule('intel-hub-quarterly','0 7 1 1,4,7,10 *',
--   $$ ... body := '{"cadence":"quarterly"}' $$);
--
-- SELECT cron.schedule('intel-hub-yearly',  '0 7 1 1 *',
--   $$ ... body := '{"cadence":"yearly"}' $$);
