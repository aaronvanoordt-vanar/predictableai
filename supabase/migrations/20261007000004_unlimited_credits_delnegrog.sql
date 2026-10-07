-- ─────────────────────────────────────────────────────────────────────────────
-- Créditos ilimitados para delnegrog@gmail.com (cuenta fuera de @vanarsi.com).
--
-- Agrega el email a public.unlimited_credit_emails (ver
-- 20261006000001_unlimited_credit_emails.sql) y sincroniza la cuenta ya
-- registrada: el trigger de auth.users solo corre al cambiar el email o la
-- confirmación, así que sin este paso la cuenta seguiría con saldo real.
-- Idempotente: si ya es ilimitada no recibe el colchón otra vez.
-- Para revocarlo: DELETE FROM public.unlimited_credit_emails WHERE email = '...'
-- y luego sync_unlimited_credits(user_id).
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.unlimited_credit_emails (email, note)
VALUES ('delnegrog@gmail.com', 'Cuenta con créditos ilimitados (pedido del dueño, 2026-10-07)')
ON CONFLICT (email) DO NOTHING;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT u.id FROM auth.users u
      JOIN public.unlimited_credit_emails e ON e.email = lower(u.email)
     WHERE e.email = 'delnegrog@gmail.com'
  LOOP
    PERFORM public.sync_unlimited_credits(r.id);
  END LOOP;
END;
$$;
