-- ─────────────────────────────────────────────────────────────────────────────
-- Espacios de trabajo por cliente («Entrar al espacio» desde Clientes).
--
-- Todo Predictable (Contexto, Intelligence Hub, Radar, Listas, Campañas…) está
-- llaveado por user_id. En vez de reescribir cada tabla y cada edge function
-- para que acepten un client_id, cada cliente recibe su PROPIA cuenta
-- administrada (un usuario de auth sin contraseña, con un email de un
-- subdominio sin buzón) y el equipo entra a ella desde la ficha del cliente:
-- la edge function `client-workspace` valida al que entra y le entrega un
-- token de un solo uso para esa cuenta. La app entera funciona igual, ahora
-- sobre los datos del cliente.
--
-- Quién puede entrar: una cuenta del equipo (is_vanarsi_account) que además
-- gestiona el cliente (can_manage_client). Lo valida la edge function; esta
-- tabla solo la escribe la service role.
--
-- Una cuenta de espacio NUNCA es del equipo: is_vanarsi_account la excluye
-- explícitamente (además, su email no termina en @vanarsi.com), así que no ve
-- Clientes ni puede abrir otros espacios. Los créditos: es ilimitada mientras
-- quien la creó lo sea; si se borra el cliente, deja de serlo.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS website TEXT;

CREATE TABLE IF NOT EXISTS public.client_workspaces (
  client_id          uuid PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
  workspace_user_id  uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  created_by         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_entered_at    timestamptz,
  last_entered_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.client_workspaces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_workspaces FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.client_workspaces TO authenticated;

-- El equipo ve el espacio de sus clientes; la cuenta del espacio se ve a sí
-- misma (así la app sabe que está dentro de un espacio y pinta «Volver»).
DROP POLICY IF EXISTS client_workspaces_select ON public.client_workspaces;
CREATE POLICY client_workspaces_select ON public.client_workspaces
  FOR SELECT TO authenticated
  USING (workspace_user_id = auth.uid() OR public.can_manage_client(client_id));

-- ── ¿Es una cuenta de espacio? ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_workspace_account(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.client_workspaces WHERE workspace_user_id = p_user_id);
$$;

REVOKE EXECUTE ON FUNCTION public.is_workspace_account(uuid) FROM PUBLIC, anon, authenticated;

-- ── Una cuenta de espacio nunca es del equipo ──────────────────────────────
-- Mismo cuerpo que en 20260923000006 + la exclusión. CREATE OR REPLACE
-- conserva los REVOKE.
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
  )
  AND NOT public.is_workspace_account(p_user_id);
$$;

-- ── Créditos: el espacio hereda el «ilimitado» de quien lo creó ────────────
-- Mismo cuerpo que en 20261006000001 + la rama del espacio (sin recursión:
-- quien crea un espacio nunca es él mismo un espacio).
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
      )
      OR EXISTS (
        SELECT 1
          FROM public.client_workspaces w
          JOIN auth.users o ON o.id = w.created_by
         WHERE w.workspace_user_id = p_user_id
           AND o.email_confirmed_at IS NOT NULL
           AND (public.is_vanarsi_account(o.id)
                OR EXISTS (SELECT 1 FROM public.unlimited_credit_emails e WHERE e.email = lower(o.email)))
      );
$$;

-- El trigger de auth.users corre al crear el usuario, ANTES de que exista la
-- fila del espacio: se vuelve a sincronizar al registrar o borrar el espacio.
CREATE OR REPLACE FUNCTION public.handle_client_workspace_credits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.sync_unlimited_credits(OLD.workspace_user_id);
    RETURN OLD;
  END IF;
  PERFORM public.sync_unlimited_credits(NEW.workspace_user_id);
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_client_workspace_credits() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_client_workspace_credits ON public.client_workspaces;
CREATE TRIGGER on_client_workspace_credits
  AFTER INSERT OR DELETE ON public.client_workspaces
  FOR EACH ROW EXECUTE FUNCTION public.handle_client_workspace_credits();

-- ── «Cuentas registradas» no lista las cuentas de espacio ──────────────────
-- Mismo cuerpo que en 20260923000006 + el filtro. CREATE OR REPLACE conserva
-- los grants.
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
     AND NOT EXISTS (SELECT 1 FROM public.client_workspaces w WHERE w.workspace_user_id = u.id)
   ORDER BY u.created_at DESC;
END;
$$;
