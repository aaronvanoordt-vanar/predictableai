-- ─────────────────────────────────────────────────────────────────────────────
-- Empresas vinculadas a una agencia (invitación por correo).
--
-- Los «espacios» de Agencia son cuentas administradas que crea la agencia
-- (client_workspaces). Esto cubre el otro caso: una empresa que YA tiene (o va
-- a crear) su propia cuenta de Predictable y acepta que una agencia la
-- gestione desde la suya.
--
--   · La agencia (o el equipo) invita por correo → fila `pending`.
--   · La empresa ve la invitación al entrar con ese correo (confirmado) y la
--     acepta o la rechaza. Aceptar es el consentimiento: sin él no hay acceso.
--   · Vinculada = la agencia puede «Entrar» a esa cuenta (edge function
--     `client-workspace`, acción enter_account: token de un solo uso, igual
--     que con los espacios). La empresa puede revocar el acceso cuando quiera.
--   · Cada ingreso queda en `account_access_log`, que la empresa ve.
--
-- El equipo de predictable.ai (is_vanarsi_account) no necesita invitación: la
-- edge function le deja entrar a cualquier cuenta registrada y también deja
-- el rastro en el registro.
--
-- Toda escritura pasa por la edge function (service role) o por los RPC de
-- abajo; `authenticated` solo lee sus propias filas.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.agency_linked_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invited_email   text NOT NULL,
  label           text,
  member_user_id  uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending',
  created_at      timestamptz NOT NULL DEFAULT now(),
  responded_at    timestamptz,
  last_entered_at timestamptz,
  CONSTRAINT agency_linked_status_chk CHECK (status IN ('pending', 'active', 'declined', 'revoked')),
  CONSTRAINT agency_linked_email_chk CHECK (invited_email = lower(invited_email) AND length(invited_email) <= 254),
  CONSTRAINT agency_linked_label_chk CHECK (label IS NULL OR length(label) <= 80),
  CONSTRAINT agency_linked_active_member_chk CHECK (status <> 'active' OR member_user_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS agency_linked_open_uniq
  ON public.agency_linked_accounts (agency_user_id, invited_email)
  WHERE status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS agency_linked_pending_email_idx
  ON public.agency_linked_accounts (invited_email) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS agency_linked_member_idx
  ON public.agency_linked_accounts (member_user_id) WHERE member_user_id IS NOT NULL;

ALTER TABLE public.agency_linked_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agency_linked_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.agency_linked_accounts TO authenticated;

DROP POLICY IF EXISTS agency_linked_select ON public.agency_linked_accounts;
CREATE POLICY agency_linked_select ON public.agency_linked_accounts
  FOR SELECT TO authenticated
  USING (agency_user_id = auth.uid() OR member_user_id = auth.uid());

-- ── Registro de accesos ───────────────────────────────────────────────────
-- Sin claves foráneas a propósito: el registro sobrevive a las cuentas.
CREATE TABLE IF NOT EXISTS public.account_access_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_user_id   uuid NOT NULL,
  actor_user_id    uuid NOT NULL,
  actor_label      text,
  via              text NOT NULL CHECK (via IN ('agency', 'team')),
  link_id          uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_access_log_member_idx ON public.account_access_log (member_user_id, created_at DESC);

ALTER TABLE public.account_access_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_access_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_access_log TO authenticated;

DROP POLICY IF EXISTS account_access_log_select ON public.account_access_log;
CREATE POLICY account_access_log_select ON public.account_access_log
  FOR SELECT TO authenticated
  USING (member_user_id = auth.uid() OR actor_user_id = auth.uid());

-- ── Correo confirmado de quien llama ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.agency_link_my_email()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT lower(u.email)
    FROM auth.users u
   WHERE u.id = auth.uid() AND u.email_confirmed_at IS NOT NULL;
$$;
REVOKE EXECUTE ON FUNCTION public.agency_link_my_email() FROM PUBLIC, anon, authenticated;

-- Nombre con el que se presenta una agencia (ficha → marca → nombre).
CREATE OR REPLACE FUNCTION public.agency_link_display_name(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT NULLIF(a.name, '') FROM public.agencies a WHERE a.owner_user_id = p_user_id),
    (SELECT NULLIF(to_jsonb(p)->>'brand_name', '') FROM public.profiles p WHERE p.id = p_user_id),
    (SELECT NULLIF(to_jsonb(p)->>'full_name', '') FROM public.profiles p WHERE p.id = p_user_id),
    'Una agencia'
  );
$$;
REVOKE EXECUTE ON FUNCTION public.agency_link_display_name(uuid) FROM PUBLIC, anon, authenticated;

-- ── Invitaciones que me llegaron ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.my_agency_invites()
RETURNS TABLE (id uuid, agency_name text, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE me text := public.agency_link_my_email();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF me IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT l.id, public.agency_link_display_name(l.agency_user_id), l.created_at
    FROM public.agency_linked_accounts l
   WHERE l.status = 'pending'
     AND l.invited_email = me
     AND l.agency_user_id <> auth.uid()
     AND public.can_open_workspaces(l.agency_user_id)
   ORDER BY l.created_at DESC;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.my_agency_invites() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_agency_invites() TO authenticated;

-- ── Aceptar o rechazar ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.respond_agency_invite(p_id uuid, p_accept boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  me text := public.agency_link_my_email();
  l  public.agency_linked_accounts%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO l FROM public.agency_linked_accounts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR l.status <> 'pending' OR me IS NULL OR l.invited_email <> me THEN
    RAISE EXCEPTION 'invite_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF l.agency_user_id = auth.uid() THEN
    RAISE EXCEPTION 'invite_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_accept AND NOT public.can_open_workspaces(l.agency_user_id) THEN
    RAISE EXCEPTION 'agency_not_active' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.agency_linked_accounts
     SET status = CASE WHEN p_accept THEN 'active' ELSE 'declined' END,
         member_user_id = CASE WHEN p_accept THEN auth.uid() ELSE member_user_id END,
         responded_at = now()
   WHERE id = p_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.respond_agency_invite(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_agency_invite(uuid, boolean) TO authenticated;

-- ── Revocar: la agencia (cancela o desvincula) o la empresa (quita el acceso)
CREATE OR REPLACE FUNCTION public.agency_link_revoke(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  UPDATE public.agency_linked_accounts
     SET status = 'revoked', responded_at = now()
   WHERE id = p_id
     AND status IN ('pending', 'active')
     AND (agency_user_id = auth.uid() OR member_user_id = auth.uid());
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'link_not_found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.agency_link_revoke(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agency_link_revoke(uuid) TO authenticated;

-- ── Lista de la agencia (con el nombre y el último acceso de cada cuenta) ──
CREATE OR REPLACE FUNCTION public.agency_linked_list()
RETURNS TABLE (
  id              uuid,
  invited_email   text,
  label           text,
  status          text,
  member_user_id  uuid,
  member_name     text,
  created_at      timestamptz,
  responded_at    timestamptz,
  last_entered_at timestamptz,
  last_sign_in_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  RETURN QUERY
  SELECT l.id, l.invited_email, l.label, l.status, l.member_user_id,
         CASE WHEN l.status = 'active' THEN
           COALESCE(NULLIF(to_jsonb(p)->>'brand_name', ''), NULLIF(to_jsonb(p)->>'company_name', ''), NULLIF(to_jsonb(p)->>'full_name', ''))
         END,
         l.created_at, l.responded_at, l.last_entered_at,
         CASE WHEN l.status = 'active' THEN u.last_sign_in_at END
    FROM public.agency_linked_accounts l
    LEFT JOIN public.profiles p ON p.id = l.member_user_id
    LEFT JOIN auth.users u ON u.id = l.member_user_id
   WHERE l.agency_user_id = auth.uid()
     AND l.status <> 'revoked'
   ORDER BY (l.status = 'active') DESC, l.created_at DESC;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.agency_linked_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agency_linked_list() TO authenticated;

-- ── Quién tiene acceso a MI cuenta y quién entró ───────────────────────────
CREATE OR REPLACE FUNCTION public.my_account_access()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  RETURN jsonb_build_object(
    'agencies', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', l.id,
               'agency_name', public.agency_link_display_name(l.agency_user_id),
               'since', l.responded_at) ORDER BY l.responded_at DESC)
        FROM public.agency_linked_accounts l
       WHERE l.member_user_id = auth.uid() AND l.status = 'active'), '[]'::jsonb),
    'log', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('actor', g.actor_label, 'via', g.via, 'at', g.created_at) ORDER BY g.created_at DESC)
        FROM (SELECT * FROM public.account_access_log
               WHERE member_user_id = auth.uid()
               ORDER BY created_at DESC LIMIT 10) g), '[]'::jsonb)
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.my_account_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_account_access() TO authenticated;

GRANT EXECUTE ON FUNCTION public.agency_link_display_name(uuid) TO service_role;
