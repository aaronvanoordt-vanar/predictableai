-- ─────────────────────────────────────────────────────────────────────────────
-- Cuentas del equipo Vanar (@vanarsi.com): créditos ilimitados + listado de
-- todas las cuentas registradas en la sección Clientes.
--
-- 1. Créditos ilimitados
--    Una cuenta es "del equipo" cuando su email termina en @vanarsi.com Y está
--    confirmado (email_confirmed_at): sin la confirmación, cualquiera podría
--    registrarse como alguien@vanarsi.com y quedarse con créditos gratis.
--    user_credits.unlimited lo marca (solo lo escribe este trigger; el cliente
--    no tiene UPDATE sobre la tabla). spend_credits / decrement_credits no
--    descuentan nada a esas cuentas. Además se les suma un colchón fijo de
--    1.000.000 créditos al saldo para que las comprobaciones previas de las edge
--    functions (balance >= costo) pasen siempre sin tocar cada función; si la
--    cuenta deja de ser del equipo (cambia de email) se le resta el mismo
--    colchón y vuelve a su saldo real.
--
-- 2. platform_list_accounts()
--    RPC de solo lectura para el equipo: devuelve cada cuenta registrada con su
--    email, nombre, método de acceso, fechas y saldo. Las contraseñas NO se
--    devuelven: Supabase Auth solo guarda su hash bcrypt (irreversible), no
--    existe una contraseña legible que mostrar.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.user_credits
  ADD COLUMN IF NOT EXISTS unlimited BOOLEAN NOT NULL DEFAULT false;

-- ── Quién es del equipo ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_vanarsi_account(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users u
     WHERE u.id = p_user_id
       AND u.email_confirmed_at IS NOT NULL
       AND lower(u.email) LIKE '%@vanarsi.com'
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_vanarsi_account(uuid) FROM PUBLIC, anon, authenticated;

-- ── Sincroniza el flag + el colchón de saldo ───────────────────────────────
CREATE OR REPLACE FUNCTION public.sync_unlimited_credits(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cushion constant integer := 1000000;
  want boolean := public.is_vanarsi_account(p_user_id);
BEGIN
  -- La fila puede no existir aún si este trigger corre antes que
  -- handle_new_user_credits (mismo saldo inicial que ese trigger).
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

CREATE OR REPLACE FUNCTION public.handle_unlimited_credits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.sync_unlimited_credits(NEW.id);
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_unlimited_credits() FROM PUBLIC, anon, authenticated;

-- Al registrarse (Google llega ya confirmado) y al confirmar / cambiar el email.
DROP TRIGGER IF EXISTS on_auth_user_unlimited_credits ON auth.users;
CREATE TRIGGER on_auth_user_unlimited_credits
  AFTER INSERT OR UPDATE OF email, email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_unlimited_credits();

-- Cuentas @vanarsi.com que ya existen.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM auth.users WHERE lower(email) LIKE '%@vanarsi.com' LOOP
    PERFORM public.sync_unlimited_credits(r.id);
  END LOOP;
END;
$$;

-- ── Las cuentas ilimitadas nunca se descuentan ─────────────────────────────
-- Mismas firmas y cuerpo que en 20260701000001_security_hardening.sql, con la
-- salida temprana para unlimited. CREATE OR REPLACE conserva los REVOKE.
CREATE OR REPLACE FUNCTION public.spend_credits(p_user_id uuid, p_amount integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_balance integer;
  is_unlimited boolean;
BEGIN
  SELECT balance, unlimited INTO new_balance, is_unlimited
    FROM public.user_credits WHERE user_id = p_user_id;

  IF is_unlimited OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN new_balance;
  END IF;

  UPDATE public.user_credits
     SET balance = balance - p_amount
   WHERE user_id = p_user_id
     AND balance >= p_amount
  RETURNING balance INTO new_balance;

  RETURN new_balance; -- NULL if no row matched (insufficient / missing)
END;
$$;

REVOKE EXECUTE ON FUNCTION public.spend_credits(uuid, integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.decrement_credits(p_user_id uuid, p_amount integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.user_credits
     SET balance = GREATEST(balance - GREATEST(p_amount, 0), 0)
   WHERE user_id = p_user_id
     AND unlimited = false;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.decrement_credits(uuid, integer) FROM PUBLIC, anon, authenticated;

-- ── Listado de cuentas para el equipo ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.platform_list_accounts()
RETURNS TABLE (
  user_id          uuid,
  email            text,
  full_name        text,
  company          text,
  role             text,
  provider         text,
  email_confirmed  boolean,
  created_at       timestamptz,
  last_sign_in_at  timestamptz,
  balance          integer,
  unlimited        boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vanarsi_account(auth.uid()) THEN
    RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
  END IF;

  -- to_jsonb(p): full_name / brand_name llegaron en migraciones recientes;
  -- leerlas así no rompe el listado si alguna aún no está aplicada.
  RETURN QUERY
  SELECT u.id,
         u.email::text,
         COALESCE(NULLIF(to_jsonb(p)->>'full_name', ''), u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
         COALESCE(NULLIF(to_jsonb(p)->>'brand_name', ''), NULLIF(to_jsonb(p)->>'company_name', '')),
         to_jsonb(p)->>'role',
         COALESCE(u.raw_app_meta_data->>'provider', 'email'),
         u.email_confirmed_at IS NOT NULL,
         u.created_at,
         u.last_sign_in_at,
         CASE WHEN c.unlimited THEN NULL ELSE c.balance END,
         COALESCE(c.unlimited, false)
    FROM auth.users u
    LEFT JOIN public.profiles p     ON p.id = u.id
    LEFT JOIN public.user_credits c ON c.user_id = u.id
   WHERE u.deleted_at IS NULL
   ORDER BY u.created_at DESC;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.platform_list_accounts() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.platform_list_accounts() TO authenticated;
