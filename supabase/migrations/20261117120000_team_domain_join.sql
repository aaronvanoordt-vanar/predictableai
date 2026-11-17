-- ════════════════════════════════════════════════════════════════════════════
-- Equipo por dominio corporativo (2026-11-17, pedido del dueño)
-- ════════════════════════════════════════════════════════════════════════════
-- Hasta hoy el equipo (`sales_team_members`, migración 20261018000003) solo lo
-- armaba un perfil con rol admin/director y `company_name` escrito a mano, y
-- nadie puede darse ese rol a sí mismo. Un cliente con varias personas del
-- mismo dominio (p. ej. @empresa.com) no tenía cómo empezar.
--
-- Ahora:
--   1. Una persona con email corporativo CONFIRMADO (no gmail/hotmail…) crea
--      el equipo de su dominio y queda como CUENTA PRINCIPAL (`sales_teams`,
--      un equipo por dominio). La cuenta principal administra el equipo como
--      un director (metas, ranking, revisión, rampa, miembros) SIN cambiar
--      `profiles.role` (sigue prohibido escribirlo desde el cliente).
--   2. Quien tenga ese mismo dominio ve la cuenta principal en Equipo y
--      SOLICITA unirse (`sales_team_join_requests`); la cuenta principal (o un
--      director de la empresa) aprueba o rechaza. Aprobar fija el
--      `company_name` del perfil al del equipo y lo agrega a la nómina.
--   3. La cuenta principal también puede agregar directamente a quien tenga
--      el dominio, aunque no haya escrito la empresa en su perfil.
-- Los créditos siguen siendo de cada usuario: nada de esto los toca.
-- Todo pasa por RPC SECURITY DEFINER; las tablas nuevas no tienen grants para
-- el cliente.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Tablas ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sales_teams (
  domain       TEXT        PRIMARY KEY CHECK (domain = lower(btrim(domain)) AND domain LIKE '%.%'),
  company_name TEXT        NOT NULL CHECK (char_length(btrim(company_name)) BETWEEN 2 AND 80),
  owner_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_teams_company_key ON public.sales_teams (lower(company_name));
CREATE UNIQUE INDEX IF NOT EXISTS sales_teams_owner_key   ON public.sales_teams (owner_id);

CREATE TABLE IF NOT EXISTS public.sales_team_join_requests (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  team_domain TEXT        NOT NULL REFERENCES public.sales_teams(domain) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status      TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at  TIMESTAMPTZ,
  decided_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_team_join_requests_pending_key
  ON public.sales_team_join_requests (user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS sales_team_join_requests_team_idx
  ON public.sales_team_join_requests (team_domain, status, created_at DESC);

DROP TRIGGER IF EXISTS sales_teams_updated_at ON public.sales_teams;
CREATE TRIGGER sales_teams_updated_at
  BEFORE UPDATE ON public.sales_teams
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.sales_teams              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_team_join_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_teams              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sales_team_join_requests FROM PUBLIC, anon, authenticated;

-- ── 2. Ayudantes ───────────────────────────────────────────────────────────
-- Dominio corporativo y confirmado de un usuario (NULL si el email no está
-- confirmado o es de un proveedor gratuito).
CREATE OR REPLACE FUNCTION public.team_user_domain(p_user UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$
  SELECT CASE
           WHEN d IS NULL OR d = '' OR d NOT LIKE '%.%' THEN NULL
           WHEN public.crm_is_free_mail_domain(d) THEN NULL
           ELSE d
         END
    FROM (SELECT lower(btrim(split_part(u.email, '@', 2))) AS d
            FROM auth.users u
           WHERE u.id = p_user AND u.email_confirmed_at IS NOT NULL) x;
$$;
REVOKE EXECUTE ON FUNCTION public.team_user_domain(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.team_user_domain(UUID) TO service_role;

-- La cuenta principal del equipo de mi empresa (si la empresa de mi perfil es
-- la de un equipo por dominio).
CREATE OR REPLACE FUNCTION public.team_my_team_domain()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT s.domain FROM public.sales_teams s
   WHERE s.company_name = public.team_my_company()
   LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION public.team_my_team_domain() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.team_my_team_domain() TO authenticated, service_role;

-- Manager = admin/director con empresa (como antes) O la cuenta principal del
-- equipo de su empresa. Lo usan todas las RPC y políticas del equipo.
CREATE OR REPLACE FUNCTION public.team_is_manager()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT lower(coalesce(role, '')) IN ('admin', 'director') AND NULLIF(btrim(company_name), '') IS NOT NULL
      FROM public.profiles WHERE id = auth.uid()), false)
  OR EXISTS (
    SELECT 1 FROM public.sales_teams s
      JOIN public.profiles p ON p.id = s.owner_id
     WHERE s.owner_id = auth.uid()
       AND btrim(p.company_name) = s.company_name);
$$;

-- ── 3. La cuenta principal no puede "mudarse" de empresa desde su perfil ───
-- (como un admin/director): `company_name` define a qué equipo pertenece.
CREATE OR REPLACE FUNCTION public.prevent_profile_role_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Service role, triggers de auth (handle_new_user) y SQL manual: sin cambios.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF auth.uid() = NEW.id THEN
      IF NEW.role IS NOT NULL AND lower(NEW.role) <> 'sdr' THEN
        NEW.role := 'sdr';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF auth.uid() = OLD.id THEN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'No puedes cambiar tu propio rol.'
        USING ERRCODE = '42501';
    END IF;
    IF lower(coalesce(OLD.role, '')) IN ('admin', 'director')
       AND OLD.company_name IS NOT NULL
       AND NEW.company_name IS DISTINCT FROM OLD.company_name THEN
      RAISE EXCEPTION 'Un administrador o director no puede cambiar la empresa de su propio perfil: company_name define a qué equipo pertenece.'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.company_name IS DISTINCT FROM OLD.company_name
       AND EXISTS (SELECT 1 FROM public.sales_teams s
                    WHERE s.owner_id = OLD.id AND s.company_name = btrim(OLD.company_name)) THEN
      RAISE EXCEPTION 'Eres la cuenta principal del equipo de %: no puedes cambiar la empresa de tu perfil.', btrim(OLD.company_name)
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.prevent_profile_role_escalation() FROM PUBLIC, anon, authenticated;

-- ── 4. Estado del equipo para la página ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.team_overview()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_company  TEXT := public.team_my_company();
  v_manager  BOOLEAN := public.team_is_manager();
  v_in       BOOLEAN := public.team_is_rostered(auth.uid());
  v_domain   TEXT := public.team_user_domain(auth.uid());
  v_raw_dom  TEXT;
  v_team     public.sales_teams%ROWTYPE;
  v_elsewhere BOOLEAN;
  v_roster   JSONB := '[]'::jsonb;
  v_cands    JSONB := '[]'::jsonb;
  v_reqs     JSONB := '[]'::jsonb;
  v_disc     JSONB := '[]'::jsonb;
  v_team_js  JSONB := NULL;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sesión requerida.' USING ERRCODE = '42501';
  END IF;

  SELECT lower(btrim(split_part(email, '@', 2))) INTO v_raw_dom FROM auth.users WHERE id = v_uid;
  SELECT * INTO v_team FROM public.sales_teams WHERE company_name = v_company LIMIT 1;
  v_elsewhere := EXISTS (SELECT 1 FROM public.sales_team_members t WHERE t.user_id = v_uid);

  IF v_team.domain IS NOT NULL THEN
    SELECT jsonb_build_object(
             'domain', v_team.domain,
             'company', v_team.company_name,
             'owner_id', v_team.owner_id,
             'owner_name', COALESCE(NULLIF(btrim(p.full_name), ''), split_part(p.email, '@', 1)),
             'is_owner', v_team.owner_id = v_uid)
      INTO v_team_js
      FROM public.profiles p WHERE p.id = v_team.owner_id;
  END IF;

  IF v_company IS NOT NULL AND (v_manager OR v_in) THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'user_id', t.user_id,
             'full_name', NULLIF(btrim(p.full_name), ''),
             'email', CASE WHEN v_manager OR t.user_id = v_uid THEN p.email END,
             'role', lower(coalesce(p.role, 'sdr')),
             'is_owner', t.user_id = v_team.owner_id,
             'started_at', t.started_at,
             'joined_at', (u.created_at)::date
           ) ORDER BY lower(coalesce(p.full_name, p.email, ''))), '[]'::jsonb)
      INTO v_roster
      FROM public.sales_team_members t
      JOIN public.profiles p ON p.id = t.user_id AND btrim(p.company_name) = t.company_name
      LEFT JOIN auth.users u ON u.id = t.user_id
     WHERE t.company_name = v_company;
  END IF;

  IF v_manager THEN
    -- Candidatos: misma empresa en el perfil o, si el equipo tiene dominio,
    -- el mismo dominio corporativo confirmado. Nunca alguien ya en otra nómina.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'user_id', p.id,
             'full_name', NULLIF(btrim(p.full_name), ''),
             'email', p.email,
             'role', lower(coalesce(p.role, 'sdr')),
             'joined_at', (u.created_at)::date
           ) ORDER BY lower(coalesce(p.full_name, p.email, ''))), '[]'::jsonb)
      INTO v_cands
      FROM public.profiles p
      LEFT JOIN auth.users u ON u.id = p.id
     WHERE (btrim(p.company_name) = v_company
            OR (v_team.domain IS NOT NULL
                AND u.email_confirmed_at IS NOT NULL
                AND lower(btrim(split_part(u.email, '@', 2))) = v_team.domain))
       AND NOT EXISTS (SELECT 1 FROM public.sales_team_members t WHERE t.user_id = p.id);

    IF v_team.domain IS NOT NULL THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', r.id,
               'user_id', r.user_id,
               'full_name', NULLIF(btrim(p.full_name), ''),
               'email', p.email,
               'created_at', r.created_at
             ) ORDER BY r.created_at), '[]'::jsonb)
        INTO v_reqs
        FROM public.sales_team_join_requests r
        JOIN public.profiles p ON p.id = r.user_id
       WHERE r.team_domain = v_team.domain AND r.status = 'pending';
    END IF;
  END IF;

  -- Fuera de cualquier nómina: la cuenta principal de mi dominio (si existe)
  -- con el estado de mi solicitud.
  IF NOT v_elsewhere AND v_domain IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'domain', s.domain,
             'company', s.company_name,
             'owner_name', COALESCE(NULLIF(btrim(p.full_name), ''), split_part(p.email, '@', 1)),
             'members', (SELECT count(*) FROM public.sales_team_members t WHERE t.company_name = s.company_name),
             'request', (SELECT jsonb_build_object('id', r.id, 'status', r.status, 'at', COALESCE(r.decided_at, r.created_at))
                           FROM public.sales_team_join_requests r
                          WHERE r.team_domain = s.domain AND r.user_id = v_uid
                          ORDER BY r.created_at DESC LIMIT 1)
           )), '[]'::jsonb)
      INTO v_disc
      FROM public.sales_teams s
      JOIN public.profiles p ON p.id = s.owner_id
     WHERE s.domain = v_domain AND s.owner_id <> v_uid;
  END IF;

  RETURN jsonb_build_object(
    'company', v_company,
    'is_manager', v_manager,
    'in_roster', v_in,
    'me', v_uid,
    'team', v_team_js,
    'roster', v_roster,
    'candidates', v_cands,
    'requests', v_reqs,
    'discover', v_disc,
    'my_domain', COALESCE(v_domain, NULLIF(v_raw_dom, '')),
    'domain_ok', v_domain IS NOT NULL,
    'can_create', v_domain IS NOT NULL AND NOT v_elsewhere
                  AND NOT EXISTS (SELECT 1 FROM public.sales_teams s WHERE s.domain = v_domain),
    'suggested_name', (SELECT COALESCE(NULLIF(btrim(company_name), ''), NULLIF(btrim(brand_name), ''))
                         FROM public.profiles WHERE id = v_uid));
END;
$$;

-- ── 5. Crear el equipo de mi dominio (quedo como cuenta principal) ─────────
CREATE OR REPLACE FUNCTION public.team_create_for_domain(p_company TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_domain TEXT := public.team_user_domain(auth.uid());
  v_prof   public.profiles%ROWTYPE;
  v_name   TEXT;
  v_joined DATE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sesión requerida.' USING ERRCODE = '42501';
  END IF;
  IF v_domain IS NULL THEN
    RAISE EXCEPTION 'Necesitas un email corporativo confirmado (no gmail, hotmail ni similares) para crear el equipo de tu empresa.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_teams WHERE domain = v_domain) THEN
    RAISE EXCEPTION 'Ya existe un equipo para @%: solicita unirte a él.', v_domain USING ERRCODE = '23505';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_team_members WHERE user_id = v_uid) THEN
    RAISE EXCEPTION 'Ya estás en un equipo. Pide que te quiten para crear otro.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_prof FROM public.profiles WHERE id = v_uid;
  IF lower(coalesce(v_prof.role, '')) IN ('admin', 'director') AND NULLIF(btrim(v_prof.company_name), '') IS NOT NULL THEN
    -- Un director ya tiene empresa y no la puede cambiar: se usa la suya.
    v_name := btrim(v_prof.company_name);
  ELSE
    v_name := btrim(COALESCE(NULLIF(btrim(p_company), ''), NULLIF(btrim(v_prof.company_name), ''), NULLIF(btrim(v_prof.brand_name), ''), ''));
  END IF;
  IF char_length(v_name) < 2 OR char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'Escribe el nombre de tu empresa (de 2 a 80 caracteres).' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_teams WHERE lower(company_name) = lower(v_name)) THEN
    RAISE EXCEPTION 'El nombre «%» ya lo usa otro equipo. Prueba con uno más específico (por ejemplo, con el país).', v_name USING ERRCODE = '23505';
  END IF;
  -- Un admin/director de OTRO dominio con ese mismo nombre vería a este equipo
  -- por las políticas que agrupan por company_name: no se comparte el nombre.
  IF EXISTS (SELECT 1 FROM public.profiles p JOIN auth.users u ON u.id = p.id
              WHERE btrim(p.company_name) = v_name AND p.id <> v_uid
                AND lower(coalesce(p.role, '')) IN ('admin', 'director')
                AND lower(btrim(split_part(u.email, '@', 2))) <> v_domain) THEN
    RAISE EXCEPTION 'El nombre «%» ya lo usa otra empresa. Prueba con uno más específico (por ejemplo, con el país).', v_name USING ERRCODE = '23505';
  END IF;

  -- Primero el perfil (el trigger revisa la empresa ANTERIOR), luego el equipo.
  UPDATE public.profiles SET company_name = v_name WHERE id = v_uid AND company_name IS DISTINCT FROM v_name;
  INSERT INTO public.sales_teams (domain, company_name, owner_id) VALUES (v_domain, v_name, v_uid);
  SELECT (created_at)::date INTO v_joined FROM auth.users WHERE id = v_uid;
  INSERT INTO public.sales_team_members (user_id, company_name, started_at, added_by)
  VALUES (v_uid, v_name, COALESCE(v_joined, CURRENT_DATE), v_uid)
  ON CONFLICT (user_id) DO UPDATE SET company_name = EXCLUDED.company_name;
  UPDATE public.sales_team_join_requests SET status = 'cancelled', decided_at = NOW()
   WHERE user_id = v_uid AND status = 'pending';
  RETURN jsonb_build_object('domain', v_domain, 'company', v_name);
END;
$$;

-- ── 6. Solicitar / cancelar ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.team_request_join(p_domain TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_domain TEXT := public.team_user_domain(auth.uid());
  v_team   public.sales_teams%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sesión requerida.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_team FROM public.sales_teams WHERE domain = lower(btrim(p_domain));
  IF v_team.domain IS NULL OR v_domain IS DISTINCT FROM v_team.domain THEN
    RAISE EXCEPTION 'Solo puedes unirte al equipo de tu propio dominio (email confirmado).' USING ERRCODE = '42501';
  END IF;
  IF v_team.owner_id = v_uid OR EXISTS (SELECT 1 FROM public.sales_team_members WHERE user_id = v_uid) THEN
    RAISE EXCEPTION 'Ya estás en un equipo.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_team_join_requests
              WHERE user_id = v_uid AND team_domain = v_team.domain AND status = 'rejected'
                AND decided_at > NOW() - INTERVAL '3 days') THEN
    RAISE EXCEPTION 'Tu solicitud anterior fue rechazada hace poco. Habla con la cuenta principal de tu equipo antes de volver a pedirlo.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_team_join_requests WHERE user_id = v_uid AND status = 'pending') THEN
    RETURN;
  END IF;
  INSERT INTO public.sales_team_join_requests (team_domain, user_id) VALUES (v_team.domain, v_uid);
END;
$$;

CREATE OR REPLACE FUNCTION public.team_cancel_request()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sesión requerida.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.sales_team_join_requests SET status = 'cancelled', decided_at = NOW()
   WHERE user_id = auth.uid() AND status = 'pending';
END;
$$;

-- Lo común de aprobar una solicitud y de agregar a alguien del dominio:
-- fija la empresa del perfil y lo pone en la nómina.
CREATE OR REPLACE FUNCTION public.team_enroll_domain_member(p_user UUID, p_company TEXT, p_started_at DATE)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE
  v_prof   public.profiles%ROWTYPE;
  v_joined DATE;
BEGIN
  SELECT * INTO v_prof FROM public.profiles WHERE id = p_user;
  IF v_prof.id IS NULL THEN
    RAISE EXCEPTION 'Esa persona no tiene perfil en Predictable.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_team_members WHERE user_id = p_user AND company_name <> p_company) THEN
    RAISE EXCEPTION 'Esa persona ya está en el equipo de otra empresa.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_teams WHERE owner_id = p_user AND company_name <> p_company) THEN
    RAISE EXCEPTION 'Esa persona es la cuenta principal de otro equipo.' USING ERRCODE = '42501';
  END IF;
  IF lower(coalesce(v_prof.role, '')) IN ('admin', 'director')
     AND NULLIF(btrim(v_prof.company_name), '') IS NOT NULL
     AND btrim(v_prof.company_name) <> p_company THEN
    RAISE EXCEPTION 'Esa persona es director o admin de otra empresa («%»).', btrim(v_prof.company_name) USING ERRCODE = '42501';
  END IF;
  UPDATE public.profiles SET company_name = p_company WHERE id = p_user AND company_name IS DISTINCT FROM p_company;
  SELECT (created_at)::date INTO v_joined FROM auth.users WHERE id = p_user;
  INSERT INTO public.sales_team_members (user_id, company_name, started_at, added_by)
  VALUES (p_user, p_company, COALESCE(p_started_at, v_joined, CURRENT_DATE), auth.uid())
  ON CONFLICT (user_id) DO UPDATE SET started_at = COALESCE(p_started_at, public.sales_team_members.started_at);
  UPDATE public.sales_team_join_requests SET status = 'approved', decided_at = NOW(), decided_by = auth.uid()
   WHERE user_id = p_user AND status = 'pending';
END;
$$;
REVOKE EXECUTE ON FUNCTION public.team_enroll_domain_member(UUID, TEXT, DATE) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.team_enroll_domain_member(UUID, TEXT, DATE) TO service_role;

-- ── 7. Decidir una solicitud (cuenta principal o director de la empresa) ───
CREATE OR REPLACE FUNCTION public.team_decide_request(p_request UUID, p_approve BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE
  v_req  public.sales_team_join_requests%ROWTYPE;
  v_team public.sales_teams%ROWTYPE;
BEGIN
  IF NOT public.team_is_manager() THEN
    RAISE EXCEPTION 'Solo la cuenta principal o un director aprueba solicitudes.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_req FROM public.sales_team_join_requests WHERE id = p_request FOR UPDATE;
  SELECT * INTO v_team FROM public.sales_teams WHERE domain = v_req.team_domain;
  IF v_req.id IS NULL OR v_team.company_name IS DISTINCT FROM public.team_my_company() THEN
    RAISE EXCEPTION 'Esa solicitud no es de tu equipo.' USING ERRCODE = '42501';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Esa solicitud ya se resolvió.' USING ERRCODE = '22023';
  END IF;
  IF NOT p_approve THEN
    UPDATE public.sales_team_join_requests SET status = 'rejected', decided_at = NOW(), decided_by = auth.uid()
     WHERE id = p_request;
    RETURN;
  END IF;
  IF public.team_user_domain(v_req.user_id) IS DISTINCT FROM v_team.domain THEN
    RAISE EXCEPTION 'El email de esa persona ya no es @%.', v_team.domain USING ERRCODE = '42501';
  END IF;
  PERFORM public.team_enroll_domain_member(v_req.user_id, v_team.company_name, NULL);
END;
$$;

-- ── 8. Agregar directamente: misma empresa en el perfil o mismo dominio ────
CREATE OR REPLACE FUNCTION public.team_add_member(p_user UUID, p_started_at DATE DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE
  v_company TEXT := public.team_my_company();
  v_domain  TEXT := public.team_my_team_domain();
BEGIN
  IF NOT public.team_is_manager() THEN
    RAISE EXCEPTION 'Solo la cuenta principal, un director o un admin arma el equipo.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user AND btrim(company_name) = v_company)
     AND (v_domain IS NULL OR public.team_user_domain(p_user) IS DISTINCT FROM v_domain) THEN
    RAISE EXCEPTION 'Esa persona no tiene tu empresa en su perfil ni un email de tu dominio.' USING ERRCODE = '42501';
  END IF;
  PERFORM public.team_enroll_domain_member(p_user, v_company, p_started_at);
END;
$$;

-- Quitar a alguien: la cuenta principal no se quita a sí misma.
CREATE OR REPLACE FUNCTION public.team_remove_member(p_user UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.team_is_manager() THEN
    RAISE EXCEPTION 'Solo la cuenta principal, un director o un admin arma el equipo.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_teams WHERE owner_id = p_user AND company_name = public.team_my_company()) THEN
    RAISE EXCEPTION 'La cuenta principal no se puede quitar del equipo.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.sales_team_goals WHERE user_id = p_user AND company_name = public.team_my_company();
  DELETE FROM public.sales_team_members WHERE user_id = p_user AND company_name = public.team_my_company();
END;
$$;

-- ── 9. Permisos de las RPC del cliente ─────────────────────────────────────
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.team_overview()',
    'public.team_create_for_domain(text)',
    'public.team_request_join(text)',
    'public.team_cancel_request()',
    'public.team_decide_request(uuid, boolean)',
    'public.team_add_member(uuid, date)',
    'public.team_remove_member(uuid)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
  END LOOP;
END $$;
