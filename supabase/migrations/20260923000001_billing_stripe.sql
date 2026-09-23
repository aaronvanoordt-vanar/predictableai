-- ═══════════════════════════════════════════════════════════════════════════
-- Billing con Stripe + economía de créditos self-serve (2026-09-23)
--
-- Diseño y números en docs/PRICING.md. Resumen:
--   · Plan gratis: 100 créditos una sola vez al registrarse (sin tarjeta).
--   · Starter (Stripe, 97 USD/mes o 924 USD/año): 1,500 créditos cada mes.
--     La bolsa del plan NO se acumula: al renovarse, lo que sobró vence y
--     entra la bolsa nueva. En el plan anual se entrega mes a mes (cron).
--   · Growth es un servicio asistido: el equipo le crea a mano una fila con
--     provider = 'manual' y la misma mecánica de bolsa mensual.
--   · Recargas (solo con plan activo): se suman al saldo y no vencen.
--
-- Contabilidad del saldo:
--   user_credits.balance       = TODO lo que el usuario puede gastar (lo que
--                                ya lee la UI y chequean las edge functions).
--   user_credits.plan_balance  = la parte de `balance` que es bolsa del plan
--                                y vence en la próxima renovación.
--   Invariante: 0 <= plan_balance <= balance. spend_credits gasta primero la
--   bolsa del plan (lo que vence antes).
--
-- Seguridad: solo la service role (edge functions `billing` y
-- `stripe-webhook`) da créditos o cambia planes. Todas las funciones nuevas
-- se revocan de PUBLIC/anon/authenticated. `mock_purchase_credits` (que le
-- regalaba créditos a cualquier usuario con sesión) se elimina.
--
-- ⚠ Al aplicarla se REINICIAN los saldos de todas las cuentas existentes a
-- los 100 créditos de la prueba (decisión del dueño, 2026-09-23: los saldos
-- de la beta eran casi todos compras simuladas).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Saldo: bolsa del plan ──────────────────────────────────────────────
ALTER TABLE public.user_credits
  ADD COLUMN IF NOT EXISTS plan_balance INT NOT NULL DEFAULT 0 CHECK (plan_balance >= 0);

-- ── 2. Clientes y suscripciones ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_customers (
  user_id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.billing_customers ENABLE ROW LEVEL SECURITY;
-- Sin políticas: solo la service role.

CREATE TABLE IF NOT EXISTS public.subscriptions (
  user_id                UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  plan                   TEXT NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter', 'growth')),
  provider               TEXT NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe', 'manual')),
  -- Estados de Stripe (active, trialing, past_due, canceled, unpaid,
  -- incomplete, incomplete_expired, paused) o 'active'/'canceled' en manual.
  status                 TEXT NOT NULL,
  billing_interval       TEXT CHECK (billing_interval IN ('month', 'year')),
  stripe_subscription_id TEXT UNIQUE,
  current_period_start   TIMESTAMPTZ,
  current_period_end     TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
  monthly_credits        INT NOT NULL DEFAULT 1500 CHECK (monthly_credits >= 0),
  last_grant_at          TIMESTAMPTZ,
  next_grant_at          TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own subscription" ON public.subscriptions;
CREATE POLICY "users read own subscription"
  ON public.subscriptions FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE ON public.subscriptions FROM anon, authenticated;
REVOKE ALL ON public.billing_customers FROM anon, authenticated;

-- Idempotencia del webhook: Stripe reintenta y puede duplicar eventos.
CREATE TABLE IF NOT EXISTS public.billing_events (
  id          TEXT PRIMARY KEY,           -- evt_… de Stripe
  type        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_events FROM anon, authenticated;

-- Cobro por lead en campaña: campaign-run busca si ese enrolamiento ya pagó.
CREATE INDEX IF NOT EXISTS ct_campaign_lead_idx
  ON public.credit_transactions (section_key) WHERE reason = 'campaign_lead';

-- ── 3. Plan vigente ───────────────────────────────────────────────────────
-- 'free' | 'starter' | 'growth'. past_due sigue activo mientras Stripe
-- reintenta el cobro (Smart Retries); canceled/unpaid/incomplete no.
CREATE OR REPLACE FUNCTION public.current_plan(p_user_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT s.plan FROM public.subscriptions s
      WHERE s.user_id = p_user_id
        AND s.status IN ('active', 'trialing', 'past_due')),
    'free');
$$;
REVOKE EXECUTE ON FUNCTION public.current_plan(UUID) FROM PUBLIC, anon, authenticated;

-- ── 4. Gasto: primero la bolsa del plan ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.spend_credits(p_user_id uuid, p_amount integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_balance integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    SELECT balance INTO new_balance FROM public.user_credits WHERE user_id = p_user_id;
    RETURN new_balance;
  END IF;

  UPDATE public.user_credits
     SET balance      = balance - p_amount,
         plan_balance = GREATEST(plan_balance - p_amount, 0)
   WHERE user_id = p_user_id
     AND balance >= p_amount
  RETURNING balance INTO new_balance;

  RETURN new_balance; -- NULL if no row matched (insufficient / missing)
END;
$$;
REVOKE EXECUTE ON FUNCTION public.spend_credits(uuid, integer) FROM PUBLIC, anon, authenticated;

-- ── 5. Bolsa del plan: vence lo que sobró y entra la nueva ────────────────
CREATE OR REPLACE FUNCTION public.billing_grant_plan_credits(p_user_id UUID, p_credits INT, p_ref TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired INT;
  v_balance INT;
BEGIN
  IF p_credits IS NULL OR p_credits < 0 THEN
    RAISE EXCEPTION 'Créditos inválidos: %', p_credits USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.user_credits (user_id, balance, plan_balance)
  VALUES (p_user_id, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT plan_balance INTO v_expired
    FROM public.user_credits WHERE user_id = p_user_id FOR UPDATE;

  UPDATE public.user_credits
     SET balance      = balance - plan_balance + p_credits,
         plan_balance = p_credits
   WHERE user_id = p_user_id
  RETURNING balance INTO v_balance;

  IF v_expired > 0 THEN
    INSERT INTO public.credit_transactions (user_id, delta, reason, section_key)
    VALUES (p_user_id, -v_expired, 'plan_expire', LEFT(p_ref, 100));
  END IF;
  INSERT INTO public.credit_transactions (user_id, delta, reason, section_key)
  VALUES (p_user_id, p_credits, 'plan_grant', LEFT(p_ref, 100));

  UPDATE public.subscriptions
     SET last_grant_at = NOW(),
         next_grant_at = NOW() + INTERVAL '1 month',
         updated_at    = NOW()
   WHERE user_id = p_user_id;

  RETURN v_balance;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.billing_grant_plan_credits(UUID, INT, TEXT) FROM PUBLIC, anon, authenticated;

-- Al cancelarse el plan, la bolsa que quedaba vence (las recargas no).
CREATE OR REPLACE FUNCTION public.billing_expire_plan_credits(p_user_id UUID, p_ref TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired INT;
  v_balance INT;
BEGIN
  SELECT plan_balance INTO v_expired
    FROM public.user_credits WHERE user_id = p_user_id FOR UPDATE;
  IF v_expired IS NULL OR v_expired = 0 THEN
    SELECT balance INTO v_balance FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_balance;
  END IF;

  UPDATE public.user_credits
     SET balance = balance - plan_balance, plan_balance = 0
   WHERE user_id = p_user_id
  RETURNING balance INTO v_balance;

  INSERT INTO public.credit_transactions (user_id, delta, reason, section_key)
  VALUES (p_user_id, -v_expired, 'plan_expire', LEFT(p_ref, 100));
  RETURN v_balance;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.billing_expire_plan_credits(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- Recarga pagada (no vence). p_ref = id de la sesión de Checkout: el índice
-- único de abajo impide acreditar dos veces la misma compra.
CREATE UNIQUE INDEX IF NOT EXISTS ct_topup_ref_uidx
  ON public.credit_transactions (section_key) WHERE reason = 'topup';

CREATE OR REPLACE FUNCTION public.billing_add_topup(p_user_id UUID, p_credits INT, p_ref TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance INT;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN
    RAISE EXCEPTION 'Créditos inválidos: %', p_credits USING ERRCODE = '22023';
  END IF;

  -- Si esta compra ya se acreditó, no hacer nada.
  INSERT INTO public.credit_transactions (user_id, delta, reason, section_key)
  VALUES (p_user_id, p_credits, 'topup', LEFT(p_ref, 100))
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT balance INTO v_balance FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_balance;
  END IF;

  INSERT INTO public.user_credits (user_id, balance, plan_balance)
  VALUES (p_user_id, p_credits, 0)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = public.user_credits.balance + p_credits
  RETURNING balance INTO v_balance;
  RETURN v_balance;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.billing_add_topup(UUID, INT, TEXT) FROM PUBLIC, anon, authenticated;

-- ── 6. Entregas mensuales pendientes (plan anual y Growth manual) ─────────
-- El plan mensual recibe su bolsa con cada factura pagada (webhook). El anual
-- factura una vez al año, así que este cron entrega la bolsa de cada mes
-- mientras dure el período pagado. Growth (manual) la recibe mientras siga
-- activo.
CREATE OR REPLACE FUNCTION public.billing_run_due_grants()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  n INT := 0;
BEGIN
  FOR r IN
    SELECT s.user_id, s.monthly_credits
      FROM public.subscriptions s
     WHERE s.next_grant_at IS NOT NULL
       AND s.next_grant_at <= NOW()
       AND (
         (s.provider = 'stripe' AND s.billing_interval = 'year'
            AND s.status IN ('active', 'trialing', 'past_due')
            AND s.current_period_end IS NOT NULL
            AND s.next_grant_at < s.current_period_end)
         OR
         (s.provider = 'manual' AND s.status = 'active')
       )
  LOOP
    PERFORM public.billing_grant_plan_credits(r.user_id, r.monthly_credits, 'monthly:' || to_char(NOW(), 'YYYY-MM-DD'));
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.billing_run_due_grants() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'billing-monthly-grants';
    PERFORM cron.schedule('billing-monthly-grants', '7 * * * *', 'SELECT public.billing_run_due_grants()');
  END IF;
END;
$$;

-- Las edge functions (service role) son las únicas que las llaman.
GRANT EXECUTE ON FUNCTION public.current_plan(UUID)                          TO service_role;
GRANT EXECUTE ON FUNCTION public.spend_credits(uuid, integer)                TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_grant_plan_credits(UUID, INT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_expire_plan_credits(UUID, TEXT)     TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_add_topup(UUID, INT, TEXT)          TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_run_due_grants()                    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscriptions, public.billing_customers, public.billing_events TO service_role;

-- ── 7. Prueba gratis: 100 créditos al registrarse ─────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user_credits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_credits (user_id, balance, plan_balance)
  VALUES (NEW.id, 100, 0)
  ON CONFLICT (user_id) DO NOTHING;
  IF FOUND THEN
    INSERT INTO public.credit_transactions (user_id, delta, reason)
    VALUES (NEW.id, 100, 'trial_grant');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.handle_new_user_credits() FROM PUBLIC, anon, authenticated;

-- ── 8. Fin de la pasarela simulada ────────────────────────────────────────
DROP FUNCTION IF EXISTS public.mock_purchase_credits(TEXT);

-- ── 9. Reinicio de saldos al lanzar (decisión del dueño) ──────────────────
INSERT INTO public.credit_transactions (user_id, delta, reason)
SELECT uc.user_id, 100 - uc.balance, 'launch_reset'
  FROM public.user_credits uc
 WHERE uc.balance <> 100;

UPDATE public.user_credits SET balance = 100, plan_balance = 0;
