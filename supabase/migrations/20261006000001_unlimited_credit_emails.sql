-- ─────────────────────────────────────────────────────────────────────────────
-- Créditos ilimitados por lista de emails (además del dominio @vanarsi.com).
--
-- Para cuentas que no son @vanarsi.com (p. ej. el Gmail personal del dueño).
-- La lista vive en public.unlimited_credit_emails; solo la service role / el
-- SQL editor la escriben (RLS activo, sin políticas, sin grants).
--
-- NO se toca is_vanarsi_account(): esa función también autoriza
-- platform_list_accounts() (ver todas las cuentas), y un email de la lista no
-- debe ganar ese acceso, solo los créditos. sync_unlimited_credits() pasa a
-- usar is_unlimited_account(), que suma ambos criterios. Igual que con el
-- dominio, el email debe estar confirmado.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.unlimited_credit_emails (
  email      text PRIMARY KEY CHECK (email = lower(email)),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.unlimited_credit_emails ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.unlimited_credit_emails FROM PUBLIC, anon, authenticated;

INSERT INTO public.unlimited_credit_emails (email, note)
VALUES ('aaronvanoordt@gmail.com', 'Dueño de la plataforma (cuenta personal)')
ON CONFLICT (email) DO NOTHING;

CREATE OR REPLACE FUNCTION public.is_unlimited_account(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT public.is_vanarsi_account(p_user_id)
      OR EXISTS (
        SELECT 1
          FROM auth.users u
          JOIN public.unlimited_credit_emails e ON e.email = lower(u.email)
         WHERE u.id = p_user_id
           AND u.email_confirmed_at IS NOT NULL
      );
$$;

REVOKE EXECUTE ON FUNCTION public.is_unlimited_account(uuid) FROM PUBLIC, anon, authenticated;

-- Mismo cuerpo que en 20260923000006, con is_unlimited_account().
CREATE OR REPLACE FUNCTION public.sync_unlimited_credits(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cushion constant integer := 1000000;
  want boolean := public.is_unlimited_account(p_user_id);
BEGIN
  INSERT INTO public.user_credits (user_id, balance)
  VALUES (p_user_id, 10)
  ON CONFLICT (user_id) DO NOTHING;

  IF want THEN
    UPDATE public.user_credits
       SET unlimited = true, balance = balance + cushion
     WHERE user_id = p_user_id AND unlimited = false;
  ELSE
    UPDATE public.user_credits
       SET unlimited = false, balance = GREATEST(balance - cushion, 0)
     WHERE user_id = p_user_id AND unlimited = true;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sync_unlimited_credits(uuid) FROM PUBLIC, anon, authenticated;

-- Aplica la lista a las cuentas que ya existen (idempotente: quien ya es
-- ilimitado no recibe el colchón dos veces).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT u.id FROM auth.users u
      JOIN public.unlimited_credit_emails e ON e.email = lower(u.email)
  LOOP
    PERFORM public.sync_unlimited_credits(r.id);
  END LOOP;
END;
$$;
