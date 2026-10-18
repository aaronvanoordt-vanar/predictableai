-- ═══════════════════════════════════════════════════════════════════════════
-- Prueba gratis con dominio corporativo (2026-10-17, opción B de
-- docs/TRIAL_REVIEW.md, aprobada por el dueño)
--
--   · Al registrarse todos reciben los 100 créditos de siempre
--     (handle_new_user_credits, sin cambios).
--   · Con un email corporativo CONFIRMADO, la prueba sube a 300 créditos que
--     vencen a los 30 días. Una sola prueba corporativa por dominio. La pide
--     el navegador con claim_trial_credits() (idempotente) al abrir la app.
--   · Con Gmail/Hotmail/etc. (o un dominio que ya usó su prueba) se queda la
--     prueba de siempre: 100 créditos sin vencimiento.
--   · El primer detector del Radar de una cuenta en prueba corre sus primeros
--     30 días sin gastar créditos (radar-monitor, `radar_detector_trial`).
--
-- Contabilidad: los créditos de la prueba corporativa viven en
-- user_credits.plan_balance (la parte del saldo que vence, que spend_credits
-- gasta primero). billing_expire_trials() (cron cada hora) vence lo que quede
-- a los 30 días si la cuenta sigue en la prueba. Si antes se pasa a Starter,
-- billing_grant_plan_credits reemplaza lo que quedaba por la bolsa del plan,
-- igual que en cada renovación. Los bonos (miforms, «Hazlo tuyo») y las
-- devoluciones no vencen.
--
-- Espejo de supabase/functions/_shared/billing-plans.ts (FREE_TRIAL_CREDITS,
-- CORPORATE_TRIAL): lo verifica _shared/trial-limits.test.ts.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Pruebas corporativas concedidas ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trial_grants (
  -- Un dominio, una prueba corporativa. La fila sobrevive al borrado de la
  -- cuenta (user_id pasa a NULL): borrar y recrear la cuenta no la renueva.
  email_domain TEXT PRIMARY KEY,
  user_id      UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  credits      INT  NOT NULL CHECK (credits > 0),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  expired_at   TIMESTAMPTZ
);
ALTER TABLE public.trial_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own trial grant" ON public.trial_grants;
CREATE POLICY "users read own trial grant"
  ON public.trial_grants FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE ON public.trial_grants FROM anon, authenticated;
GRANT SELECT ON public.trial_grants TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trial_grants TO service_role;

CREATE INDEX IF NOT EXISTS trial_grants_due_idx
  ON public.trial_grants (expires_at) WHERE expired_at IS NULL;

-- ── 2. ¿Es un dominio corporativo? ────────────────────────────────────────
-- Correo gratuito (incluidas sus variantes por país: hotmail.es, yahoo.com.mx,
-- outlook.com.br…), desechable, o de la propia plataforma (cuentas de espacio
-- de cliente y del equipo, que ya son ilimitadas) = NO corporativo.
CREATE OR REPLACE FUNCTION public.is_corporate_email_domain(p_domain TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_domain IS NOT NULL
     AND p_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
     AND split_part(p_domain, '.', 1) <> ALL (ARRAY[
       'gmail', 'googlemail', 'hotmail', 'outlook', 'live', 'msn', 'windowslive',
       'yahoo', 'ymail', 'rocketmail', 'aol', 'gmx', 'yandex', 'icloud', 'me', 'mac',
       'protonmail', 'proton', 'tutanota', 'tuta', 'zohomail', 'mail', 'email',
       'inbox', 'hushmail', 'fastmail', 'hey', 'qq', '163', '126', 'sina', 'naver',
       'mailinator', 'guerrillamail', 'sharklasers', 'yopmail', 'tempmail',
       'temp-mail', '10minutemail', 'trashmail', 'getnada', 'maildrop', 'dispostable',
       'fakeinbox', 'throwawaymail', 'mintemail', 'emailondeck', 'moakt', 'mohmal',
       'tempail', 'burnermail', 'mailnesia', 'mytemp', 'spamgourmet', 'grr'
     ])
     AND p_domain <> ALL (ARRAY[
       'pm.me', 'zoho.com', 'uol.com.br', 'bol.com.br', 'terra.com.br', 'terra.com',
       'ig.com.br', 'r7.com', 'prodigy.net.mx', 'latinmail.com', 'starmedia.com',
       'telefonica.net', 'movistar.es', 'cantv.net', 'speedy.com.ar', 'fibertel.com.ar',
       'arnet.com.ar', 'ciudad.com.ar', 'vtr.net', 'entelchile.net', 'etb.net.co',
       'une.net.co', 'emcali.net.co', 'pucp.edu.pe',
       'vanarsi.com', 'workspaces.vanarsi.com'
     ]);
$$;
REVOKE EXECUTE ON FUNCTION public.is_corporate_email_domain(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_corporate_email_domain(TEXT) TO service_role;

-- ── 3. Pedir la prueba corporativa (la llama el navegador) ────────────────
-- Devuelve {status, credits?, expires_at?}:
--   granted          se concedió ahora
--   active           ya la tenía (sigue vigente)
--   expired          ya la tuvo y venció
--   personal_domain  email gratuito o desechable: queda la prueba de 100
--   domain_used      otra cuenta del mismo dominio ya la usó
--   not_confirmed    email sin confirmar (se vuelve a pedir después)
--   not_free         la cuenta tiene un plan (o es ilimitada)
CREATE OR REPLACE FUNCTION public.claim_trial_credits()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id           UUID := auth.uid();
  v_free_credits      CONSTANT INT := 100;   -- FREE_TRIAL_CREDITS
  v_corporate_credits CONSTANT INT := 300;   -- CORPORATE_TRIAL.credits
  v_days              CONSTANT INT := 30;    -- CORPORATE_TRIAL.days
  v_email     TEXT;
  v_confirmed TIMESTAMPTZ;
  v_domain    TEXT;
  v_grant     public.trial_grants%ROWTYPE;
  v_balance   INT;
  v_plan_bal  INT;
  v_unlimited BOOLEAN;
  v_bonuses   INT;
  v_trial_left INT;
  v_extra     INT := v_corporate_credits - v_free_credits;
  v_expires   TIMESTAMPTZ;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_grant FROM public.trial_grants WHERE user_id = v_user_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', CASE WHEN v_grant.expired_at IS NULL AND v_grant.expires_at > NOW() THEN 'active' ELSE 'expired' END,
      'credits', v_grant.credits, 'expires_at', v_grant.expires_at);
  END IF;

  INSERT INTO public.user_credits (user_id, balance, plan_balance)
  VALUES (v_user_id, v_free_credits, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT balance, plan_balance, unlimited INTO v_balance, v_plan_bal, v_unlimited
    FROM public.user_credits WHERE user_id = v_user_id FOR UPDATE;

  IF v_unlimited OR public.current_plan(v_user_id) <> 'free' THEN
    RETURN jsonb_build_object('status', 'not_free');
  END IF;

  SELECT lower(u.email), u.email_confirmed_at INTO v_email, v_confirmed
    FROM auth.users u WHERE u.id = v_user_id;
  IF v_confirmed IS NULL THEN
    RETURN jsonb_build_object('status', 'not_confirmed');
  END IF;

  v_domain := split_part(COALESCE(v_email, ''), '@', 2);
  IF NOT public.is_corporate_email_domain(v_domain) THEN
    RETURN jsonb_build_object('status', 'personal_domain');
  END IF;

  v_expires := NOW() + make_interval(days => v_days);
  INSERT INTO public.trial_grants (user_id, email_domain, credits, expires_at)
  VALUES (v_user_id, v_domain, v_corporate_credits, v_expires)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'domain_used');
  END IF;

  -- Lo que queda de los 100 de la prueba pasa a la bolsa que vence, junto
  -- con los 200 nuevos. Se asume que lo gastado salió primero de la prueba
  -- (es lo que hace spend_credits desde ahora): los bonos no vencen.
  SELECT COALESCE(SUM(delta), 0) INTO v_bonuses
    FROM public.credit_transactions
   WHERE user_id = v_user_id AND delta > 0
     AND reason IN ('miforms_bonus', 'branding_bonus');
  v_trial_left := GREATEST(0, LEAST(v_balance - v_plan_bal - v_bonuses, v_free_credits));

  UPDATE public.user_credits
     SET balance      = balance + v_extra,
         plan_balance = LEAST(balance + v_extra, plan_balance + v_trial_left + v_extra)
   WHERE user_id = v_user_id
  RETURNING balance INTO v_balance;

  INSERT INTO public.credit_transactions (user_id, delta, reason, section_key)
  VALUES (v_user_id, v_extra, 'trial_corporate_grant', LEFT(v_domain, 100));

  RETURN jsonb_build_object('status', 'granted', 'credits', v_corporate_credits,
                            'expires_at', v_expires, 'balance', v_balance);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.claim_trial_credits() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_trial_credits() TO authenticated;

-- ── 4. Vencimiento de la prueba corporativa (cron) ────────────────────────
CREATE OR REPLACE FUNCTION public.billing_expire_trials()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_expired INT;
  n INT := 0;
BEGIN
  FOR r IN
    SELECT g.email_domain, g.user_id FROM public.trial_grants g
     WHERE g.expired_at IS NULL AND g.expires_at <= NOW()
     FOR UPDATE SKIP LOCKED
  LOOP
    -- Con un plan activo la bolsa ya es la del plan: no se toca.
    IF r.user_id IS NOT NULL AND public.current_plan(r.user_id) = 'free' THEN
      SELECT plan_balance INTO v_expired
        FROM public.user_credits WHERE user_id = r.user_id FOR UPDATE;
      IF COALESCE(v_expired, 0) > 0 THEN
        UPDATE public.user_credits
           SET balance = balance - plan_balance, plan_balance = 0
         WHERE user_id = r.user_id;
        INSERT INTO public.credit_transactions (user_id, delta, reason)
        VALUES (r.user_id, -v_expired, 'trial_expire');
      END IF;
    END IF;
    UPDATE public.trial_grants SET expired_at = NOW() WHERE email_domain = r.email_domain;
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.billing_expire_trials() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_expire_trials() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'billing-expire-trials';
    PERFORM cron.schedule('billing-expire-trials', '17 * * * *', 'SELECT public.billing_expire_trials()');
  END IF;
END;
$$;

-- ── 5. Primer detector del Radar sin costo en la prueba ───────────────────
-- radar-monitor inserta esta fila (delta 0) antes de cobrar el primer período
-- de un detector en plan free; el índice único garantiza que sea uno solo
-- por cuenta aunque dos detectores se cobren a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS ct_user_radar_detector_trial_uidx
  ON public.credit_transactions (user_id) WHERE reason = 'radar_detector_trial';
