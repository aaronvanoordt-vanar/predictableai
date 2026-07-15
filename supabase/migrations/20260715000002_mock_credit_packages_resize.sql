-- ═══════════════════════════════════════════════════════════════════════════
-- mock_purchase_credits — resize packages to the real credit economy (2026-07-15)
--
-- The initial mock packages (50/150/500) were placeholders. Now that the
-- credit economy is defined (1 credit ≈ US$0.10 of value, ~3× raw cost), the
-- self-service recharge packs are sized 250 / 600 / 1500 with a volume
-- discount, matching js/credits.js PACKAGES. Same self-service, auth.uid()-
-- scoped, authenticated-only contract as 20260715000001 — only the granted
-- amounts change.
--
-- ⚠ Still a MOCK top-up (no real payment). Remove or gate behind Stripe before
-- public launch — see CLAUDE.md.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.mock_purchase_credits(p_package TEXT)
RETURNS TABLE(balance INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_amount  INT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
  END IF;

  v_amount := CASE p_package
    WHEN 'starter' THEN 250
    WHEN 'pro'     THEN 600
    WHEN 'scale'   THEN 1500
    ELSE NULL
  END;

  IF v_amount IS NULL THEN
    RAISE EXCEPTION 'Paquete de créditos inválido: %', p_package USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.user_credits (user_id, balance)
  VALUES (v_user_id, v_amount)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = public.user_credits.balance + v_amount;

  INSERT INTO public.credit_transactions (user_id, delta, reason, section_key)
  VALUES (v_user_id, v_amount, 'mock_purchase', p_package);

  RETURN QUERY SELECT uc.balance FROM public.user_credits uc WHERE uc.user_id = v_user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mock_purchase_credits(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mock_purchase_credits(TEXT) TO authenticated;
