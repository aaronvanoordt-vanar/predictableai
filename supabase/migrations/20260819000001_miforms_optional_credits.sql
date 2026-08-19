-- ═══════════════════════════════════════════════════════════════════════════
-- claim_miforms_bonus_credits (2026-08-19)
--
-- miforms (the Intelligence Hub calibration survey) is no longer a mandatory
-- gate before entering the platform — auth-callback.html now always routes
-- straight into the app. Filling out /miforms/ is optional, surfaced via a
-- dismissible popup + sidebar affordance, and rewarded with a one-time
-- credit bonus on completion. This RPC grants that bonus.
--
-- Self-service by design (auth.uid() only, no caller-supplied user id) but
-- guarded so it can only be claimed once per user, and only once the user
-- has actually completed the survey (intel_hub_intake.hub_unlocked = true,
-- set by miforms/js/feedback.js on submit) — the amount is a fixed constant,
-- server-side, so the client cannot inflate it or claim it repeatedly.
--
-- A partial unique index on credit_transactions backs the "once per user"
-- guarantee at the DB level (belt-and-suspenders against a race between two
-- concurrent claims), not just the function's own check.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS ct_user_miforms_bonus_uidx
  ON public.credit_transactions (user_id)
  WHERE reason = 'miforms_bonus';

CREATE OR REPLACE FUNCTION public.claim_miforms_bonus_credits()
RETURNS TABLE(balance INT, granted BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id    UUID := auth.uid();
  v_amount     INT  := 25;
  v_unlocked   BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
  END IF;

  SELECT hub_unlocked INTO v_unlocked
  FROM public.intel_hub_intake
  WHERE user_id = v_user_id;

  IF v_unlocked IS NOT TRUE THEN
    RAISE EXCEPTION 'Completa primero la calibración del Hub.' USING ERRCODE = '22023';
  END IF;

  BEGIN
    INSERT INTO public.credit_transactions (user_id, delta, reason)
    VALUES (v_user_id, v_amount, 'miforms_bonus');
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT uc.balance, FALSE FROM public.user_credits uc WHERE uc.user_id = v_user_id;
    RETURN;
  END;

  INSERT INTO public.user_credits (user_id, balance)
  VALUES (v_user_id, v_amount)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = public.user_credits.balance + v_amount;

  RETURN QUERY SELECT uc.balance, TRUE FROM public.user_credits uc WHERE uc.user_id = v_user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_miforms_bonus_credits() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_miforms_bonus_credits() TO authenticated;
