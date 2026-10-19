-- ═══════════════════════════════════════════════════════════════════════════
-- mock_purchase_credits (2026-07-15)
--
-- TEMPORARY mock checkout: the frontend "buy credits" modal accepts any
-- fake card input (no real payment processor yet) and calls this RPC to
-- top up the caller's own balance, logging the top-up in
-- credit_transactions with reason 'mock_purchase' so it's auditable and
-- easy to find/remove once Stripe is wired up.
--
-- Self-service by design (any authenticated user can top up their OWN
-- balance) — this is intentionally different from decrement_credits /
-- spend_credits, which are service-role-only. Letting users grant
-- themselves credits is a product/billing concern while there's no real
-- payment behind it, not a cross-user security hole: auth.uid() is used
-- directly (no caller-supplied user id), and the amount is clamped to the
-- fixed package sizes below, both server-side, so the client cannot pass
-- an arbitrary amount or target another account.
--
-- ⚠ Remove or gate this behind real payment verification before public
-- launch — see CLAUDE.md.
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
    WHEN 'starter' THEN 50
    WHEN 'pro'     THEN 150
    WHEN 'scale'   THEN 500
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
