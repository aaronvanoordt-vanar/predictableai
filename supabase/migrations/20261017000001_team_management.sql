-- ═══════════════════════════════════════════════════════════════════════════
-- Equipo (2026-10-17, docs/ROADMAP_GTM_OS.md §4): metas de actividad, ranking,
-- revisión del Meeting Coach con comentarios de coaching y rampa de entrada.
--
-- Quién es del equipo
--   `profiles.company_name` agrupa equipos, pero cualquier SDR puede escribirlo
--   en su propio perfil (el trigger anti-escalación solo se lo impide a admin y
--   director). Si el ranking se abriera a todo el que escriba "Acme", cualquiera
--   leería los números del equipo de Acme. Por eso el equipo es una NÓMINA
--   explícita (`sales_team_members`) que arma el director o el admin con
--   perfiles de su misma empresa. Un miembro deja de contar en cuanto su
--   `company_name` ya no coincide (la nómina se valida en cada lectura).
--
-- Qué ve cada uno
--   · Director / admin (de la empresa): la nómina, las metas de todos, el
--     ranking, la rampa con nombres, los reportes del Meeting Coach de cada
--     miembro y los comentarios de coaching.
--   · SDR en la nómina: sus metas, el ranking del equipo, su rampa contra la
--     mediana (los demás sin nombre) y sus propios reportes y comentarios.
--   · Fuera de la nómina: nada del equipo.
--   Nadie lee filas de leads ajenos: las RPC devuelven SOLO conteos de
--   personas, nunca contactos. `coach_meetings` sigue sin grants al cliente;
--   la revisión pasa por `team_review_meetings` (SECURITY DEFINER).
--
-- Cómo se cuenta (personas, no eventos; igual que js/campaign-analytics.js)
--   contacts_new    personas nuevas en sus listas (primera aparición de la
--                   persona en el período: apollo_person_id / email / LinkedIn)
--   sent_<canal>    personas con al menos un envío aceptado por ese canal en el
--                   período (campaña sin `failed` posterior, o mensaje manual
--                   desde la Bandeja)
--   replies         personas que respondieron / escribieron en el período
--   meetings_booked personas cuya PRIMERA entrada a reunion_agendada o
--                   reunion_tomada cae en el período
--   meetings_held   personas cuya primera entrada a reunion_tomada cae en el
--                   período
--   calls           NULL hasta que exista telefonía (enganche: otra sesión la
--                   construye; ver team_member_activity)
--   cohort*         para las TASAS del ranking: personas cuyo primer envío
--                   aceptado cae en el período, y de ellas cuántas respondieron
--                   o llegaron a reunión en cualquier momento (cohorte, como
--                   el filtro de fechas de Analytics de Campañas).
--
-- Reuniones: `prospect_list_members.status_changed_at` solo guarda el ÚLTIMO
-- cambio (un lead que pasó de agendada a tomada pierde la fecha de agendada).
-- `contact_status_history` guarda cada cambio desde hoy; las filas que hoy
-- están en reunión se siembran con su fecha real de cambio (source='backfill').
--
-- Idempotente y no destructiva.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Historial de estados del CRM ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contact_status_history (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Sin FK: borrar un lead no debe borrar la reunión que el SDR ya consiguió.
  member_id   UUID        NOT NULL,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT        NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source      TEXT        NOT NULL DEFAULT 'trigger' CHECK (source IN ('trigger', 'backfill'))
);

CREATE INDEX IF NOT EXISTS contact_status_history_user_idx
  ON public.contact_status_history (user_id, to_status, changed_at);
CREATE INDEX IF NOT EXISTS contact_status_history_member_idx
  ON public.contact_status_history (member_id);

ALTER TABLE public.contact_status_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own status history" ON public.contact_status_history;
CREATE POLICY "Users can view own status history" ON public.contact_status_history
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
REVOKE ALL ON public.contact_status_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.contact_status_history TO authenticated;

DO $$
DECLARE seq TEXT;
BEGIN
  seq := pg_get_serial_sequence('public.contact_status_history', 'id');
  IF seq IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated', seq);
  END IF;
END $$;

-- Nunca rompe la escritura del lead.
CREATE OR REPLACE FUNCTION public.record_contact_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.contact_status IS NOT NULL AND NEW.contact_status <> 'no_contactado' THEN
      INSERT INTO public.contact_status_history (member_id, user_id, from_status, to_status)
      VALUES (NEW.id, NEW.user_id, NULL, NEW.contact_status);
    END IF;
  ELSIF NEW.contact_status IS DISTINCT FROM OLD.contact_status THEN
    INSERT INTO public.contact_status_history (member_id, user_id, from_status, to_status)
    VALUES (NEW.id, NEW.user_id, OLD.contact_status, NEW.contact_status);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'record_contact_status_change: %', SQLERRM;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.record_contact_status_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS prospect_list_members_status_history ON public.prospect_list_members;
CREATE TRIGGER prospect_list_members_status_history
  AFTER INSERT OR UPDATE OF contact_status ON public.prospect_list_members
  FOR EACH ROW EXECUTE FUNCTION public.record_contact_status_change();

-- Siembra: los leads que HOY están en reunión, con su fecha real de cambio.
INSERT INTO public.contact_status_history (member_id, user_id, from_status, to_status, changed_at, source)
SELECT m.id, m.user_id, NULL, m.contact_status, COALESCE(m.status_changed_at, m.created_at), 'backfill'
  FROM public.prospect_list_members m
 WHERE m.contact_status IN ('reunion_agendada', 'reunion_tomada')
   AND NOT EXISTS (SELECT 1 FROM public.contact_status_history h WHERE h.member_id = m.id);

-- Índices para contar por usuario y fecha.
CREATE INDEX IF NOT EXISTS prospect_list_members_user_created_idx
  ON public.prospect_list_members (user_id, created_at);
CREATE INDEX IF NOT EXISTS campaign_events_user_type_created_idx
  ON public.campaign_events (user_id, type, created_at);
CREATE INDEX IF NOT EXISTS inbox_messages_user_dir_sent_idx
  ON public.inbox_messages (user_id, direction, sent_at);

-- ── 2. Nómina, metas y comentarios ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sales_team_members (
  user_id      UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  company_name TEXT        NOT NULL,
  -- Inicio de la rampa. Por defecto, el día en que entró a Predictable.
  started_at   DATE        NOT NULL DEFAULT CURRENT_DATE,
  added_by     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sales_team_members_company_idx ON public.sales_team_members (company_name);

CREATE TABLE IF NOT EXISTS public.sales_team_goals (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_name TEXT        NOT NULL,
  period       TEXT        NOT NULL CHECK (period IN ('week', 'month')),
  metric       TEXT        NOT NULL CHECK (metric IN (
                 'contacts_new', 'sent_email', 'sent_whatsapp', 'sent_linkedin',
                 'calls', 'replies', 'meetings_booked', 'meetings_held')),
  target       INTEGER     NOT NULL CHECK (target BETWEEN 1 AND 100000),
  set_by       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sales_team_goals_user_period_metric_key UNIQUE (user_id, period, metric)
);

CREATE TABLE IF NOT EXISTS public.sales_team_comments (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT        NOT NULL,
  member_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  author_id    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  -- meeting = coach_meetings.id · call = id de la llamada (telefonía, cuando
  -- exista) · general = sin objeto.
  subject_kind TEXT        NOT NULL DEFAULT 'general' CHECK (subject_kind IN ('meeting', 'call', 'general')),
  subject_id   TEXT,
  body         TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sales_team_comments_member_idx ON public.sales_team_comments (member_id, created_at DESC);

DROP TRIGGER IF EXISTS sales_team_members_updated_at ON public.sales_team_members;
CREATE TRIGGER sales_team_members_updated_at
  BEFORE UPDATE ON public.sales_team_members
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS sales_team_goals_updated_at ON public.sales_team_goals;
CREATE TRIGGER sales_team_goals_updated_at
  BEFORE UPDATE ON public.sales_team_goals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 3. Ayudantes (SECURITY DEFINER: leen profiles sin RLS recursivo) ───────
CREATE OR REPLACE FUNCTION public.team_my_company()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT NULLIF(btrim(company_name), '') FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.team_is_manager()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT lower(coalesce(role, '')) IN ('admin', 'director') AND NULLIF(btrim(company_name), '') IS NOT NULL
      FROM public.profiles WHERE id = auth.uid()), false);
$$;

-- ¿`p_user` está HOY en la nómina de la empresa del que llama? (la empresa de
-- su perfil tiene que seguir coincidiendo con la de la nómina).
CREATE OR REPLACE FUNCTION public.team_is_rostered(p_user UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.sales_team_members t
      JOIN public.profiles p ON p.id = t.user_id
     WHERE t.user_id = p_user
       AND t.company_name = public.team_my_company()
       AND btrim(p.company_name) = t.company_name);
$$;

-- El que llama puede ver el equipo: dirige la empresa o está en su nómina.
CREATE OR REPLACE FUNCTION public.team_can_view()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.team_my_company() IS NOT NULL
     AND (public.team_is_manager() OR public.team_is_rostered(auth.uid()));
$$;

REVOKE EXECUTE ON FUNCTION public.team_my_company()        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.team_is_manager()        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.team_is_rostered(UUID)   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.team_can_view()          FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.team_my_company()        TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.team_is_manager()        TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.team_is_rostered(UUID)   TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.team_can_view()          TO authenticated, service_role;

-- ── 4. RLS: lectura por rol; toda escritura pasa por las RPC de abajo ──────
ALTER TABLE public.sales_team_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_team_goals    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_team_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Team can view roster" ON public.sales_team_members;
CREATE POLICY "Team can view roster" ON public.sales_team_members
  FOR SELECT TO authenticated
  USING (company_name = public.team_my_company() AND public.team_can_view());

DROP POLICY IF EXISTS "Own goals or manager" ON public.sales_team_goals;
CREATE POLICY "Own goals or manager" ON public.sales_team_goals
  FOR SELECT TO authenticated
  USING (company_name = public.team_my_company()
         AND (user_id = auth.uid() OR public.team_is_manager()));

DROP POLICY IF EXISTS "Own comments or manager" ON public.sales_team_comments;
CREATE POLICY "Own comments or manager" ON public.sales_team_comments
  FOR SELECT TO authenticated
  USING (company_name = public.team_my_company()
         AND (member_id = auth.uid() OR author_id = auth.uid() OR public.team_is_manager()));

REVOKE ALL ON public.sales_team_members  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sales_team_goals    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sales_team_comments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sales_team_members  TO authenticated;
GRANT SELECT ON public.sales_team_goals    TO authenticated;
GRANT SELECT ON public.sales_team_comments TO authenticated;

-- ── 5. Actividad de un usuario en una ventana (interna, nunca del cliente) ─
CREATE OR REPLACE FUNCTION public.team_member_activity(p_user UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_contacts INTEGER; v_email INTEGER; v_wa INTEGER; v_li INTEGER; v_sent INTEGER;
  v_replies INTEGER; v_booked INTEGER; v_held INTEGER;
  v_cohort INTEGER; v_cohort_replied INTEGER; v_cohort_meetings INTEGER;
BEGIN
  -- Personas nuevas: primera aparición de la persona en sus listas.
  SELECT count(*) INTO v_contacts FROM (
    SELECT min(m.created_at) AS first_at
      FROM public.prospect_list_members m
     WHERE m.user_id = p_user AND m.created_at < p_to
     GROUP BY COALESCE(NULLIF(m.apollo_person_id, ''), lower(NULLIF(m.email, '')),
                       lower(NULLIF(m.linkedin_url, '')), m.id::text)
  ) s WHERE s.first_at >= p_from;

  -- Envíos aceptados en la ventana (campaña sin `failed` posterior + manuales).
  WITH sends AS (
    SELECT COALESCE(ev.member_id::text, ev.enrollment_id::text, ev.id::text) AS who, ev.channel AS ch
      FROM public.campaign_events ev
     WHERE ev.user_id = p_user
       AND ev.type IN ('sent', 'connection_sent')
       AND ev.channel IN ('email', 'whatsapp', 'linkedin')
       AND ev.created_at >= p_from AND ev.created_at < p_to
       AND (ev.provider_message_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM public.campaign_events f
              WHERE f.provider_message_id = ev.provider_message_id AND f.type = 'failed'))
    UNION ALL
    SELECT COALESCE(im.member_id::text, 'ref:' || im.channel || ':' || COALESCE(im.contact_ref, im.id::text)), im.channel
      FROM public.inbox_messages im
     WHERE im.user_id = p_user AND im.direction = 'out'
       AND im.campaign_id IS NULL AND im.status <> 'failed'
       AND im.sent_at >= p_from AND im.sent_at < p_to
  )
  SELECT count(DISTINCT who) FILTER (WHERE ch = 'email'),
         count(DISTINCT who) FILTER (WHERE ch = 'whatsapp'),
         count(DISTINCT who) FILTER (WHERE ch = 'linkedin'),
         count(DISTINCT who)
    INTO v_email, v_wa, v_li, v_sent FROM sends;

  -- Personas que respondieron / escribieron en la ventana.
  SELECT count(DISTINCT who) INTO v_replies FROM (
    SELECT COALESCE(e.member_id::text, e.id::text) AS who
      FROM public.campaign_enrollments e
     WHERE e.user_id = p_user AND e.replied_at >= p_from AND e.replied_at < p_to
    UNION
    SELECT COALESCE(ev.member_id::text, ev.enrollment_id::text, ev.id::text)
      FROM public.campaign_events ev
     WHERE ev.user_id = p_user AND ev.type = 'replied' AND ev.created_at >= p_from AND ev.created_at < p_to
    UNION
    SELECT COALESCE(im.member_id::text, 'ref:' || im.channel || ':' || COALESCE(im.contact_ref, im.id::text))
      FROM public.inbox_messages im
     WHERE im.user_id = p_user AND im.direction = 'in' AND im.sent_at >= p_from AND im.sent_at < p_to
  ) r;

  -- Reuniones: primera entrada de cada persona.
  SELECT count(*) FILTER (WHERE booked_at >= p_from AND booked_at < p_to),
         count(*) FILTER (WHERE held_at >= p_from AND held_at < p_to)
    INTO v_booked, v_held
    FROM (SELECT h.member_id,
                 min(h.changed_at) FILTER (WHERE h.to_status IN ('reunion_agendada', 'reunion_tomada')) AS booked_at,
                 min(h.changed_at) FILTER (WHERE h.to_status = 'reunion_tomada') AS held_at
            FROM public.contact_status_history h
           WHERE h.user_id = p_user AND h.to_status IN ('reunion_agendada', 'reunion_tomada')
           GROUP BY h.member_id) mtg;

  -- Cohorte para las tasas: primer envío aceptado de campaña en la ventana.
  WITH first_send AS (
    SELECT ev.member_id, min(ev.created_at) AS first_at
      FROM public.campaign_events ev
     WHERE ev.user_id = p_user AND ev.member_id IS NOT NULL
       AND ev.type IN ('sent', 'connection_sent')
       AND ev.channel IN ('email', 'whatsapp', 'linkedin')
       AND ev.created_at < p_to
       AND (ev.provider_message_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM public.campaign_events f
              WHERE f.provider_message_id = ev.provider_message_id AND f.type = 'failed'))
     GROUP BY ev.member_id
  ), cohort AS (
    SELECT member_id FROM first_send WHERE first_at >= p_from
  )
  SELECT count(*),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.campaign_enrollments e
            WHERE e.user_id = p_user AND e.member_id = c.member_id
              AND (e.replied_at IS NOT NULL OR e.status = 'replied'))
           OR EXISTS (
           SELECT 1 FROM public.campaign_events ev
            WHERE ev.user_id = p_user AND ev.member_id = c.member_id AND ev.type = 'replied')
           OR EXISTS (
           SELECT 1 FROM public.inbox_messages im
            WHERE im.user_id = p_user AND im.member_id = c.member_id AND im.direction = 'in')),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.contact_status_history h
            WHERE h.user_id = p_user AND h.member_id = c.member_id
              AND h.to_status IN ('reunion_agendada', 'reunion_tomada')))
    INTO v_cohort, v_cohort_replied, v_cohort_meetings
    FROM cohort c;

  RETURN jsonb_build_object(
    'contacts_new', v_contacts,
    'sent_email', v_email, 'sent_whatsapp', v_wa, 'sent_linkedin', v_li, 'sent_total', v_sent,
    -- Enganche de telefonía: cuando exista la tabla de llamadas, cuéntalas
    -- aquí (personas llamadas en la ventana) en vez de NULL. NULL = la UI dice
    -- «sin telefonía», nunca muestra un cero inventado.
    'calls', NULL,
    'replies', v_replies,
    'meetings_booked', v_booked, 'meetings_held', v_held,
    'cohort', v_cohort, 'cohort_replied', v_cohort_replied, 'cohort_meetings', v_cohort_meetings);
END;
$$;
-- Recibe cualquier user_id: jamás expuesta al cliente.
REVOKE EXECUTE ON FUNCTION public.team_member_activity(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.team_member_activity(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

-- ── 6. RPC del cliente ─────────────────────────────────────────────────────

-- Estado del equipo para la página: rol, nómina, candidatos y metas visibles.
CREATE OR REPLACE FUNCTION public.team_overview()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_company TEXT := public.team_my_company();
  v_manager BOOLEAN := public.team_is_manager();
  v_in      BOOLEAN := public.team_is_rostered(auth.uid());
  v_roster  JSONB := '[]'::jsonb;
  v_cands   JSONB := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sesión requerida.' USING ERRCODE = '42501';
  END IF;
  IF v_company IS NOT NULL AND (v_manager OR v_in) THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'user_id', t.user_id,
             'full_name', NULLIF(btrim(p.full_name), ''),
             'email', CASE WHEN v_manager OR t.user_id = auth.uid() THEN p.email END,
             'role', lower(coalesce(p.role, 'sdr')),
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
     WHERE btrim(p.company_name) = v_company
       AND NOT EXISTS (SELECT 1 FROM public.sales_team_members t
                        WHERE t.user_id = p.id AND t.company_name = v_company);
  END IF;
  RETURN jsonb_build_object(
    'company', v_company,
    'is_manager', v_manager,
    'in_roster', v_in,
    'me', auth.uid(),
    'roster', v_roster,
    'candidates', v_cands);
END;
$$;

CREATE OR REPLACE FUNCTION public.team_add_member(p_user UUID, p_started_at DATE DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_company TEXT := public.team_my_company();
  v_joined  DATE;
BEGIN
  IF NOT public.team_is_manager() THEN
    RAISE EXCEPTION 'Solo un director o admin arma el equipo.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user AND btrim(company_name) = v_company) THEN
    RAISE EXCEPTION 'Esa persona no tiene tu empresa en su perfil.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_team_members WHERE user_id = p_user AND company_name <> v_company) THEN
    RAISE EXCEPTION 'Esa persona ya está en el equipo de otra empresa.' USING ERRCODE = '42501';
  END IF;
  SELECT (created_at)::date INTO v_joined FROM auth.users WHERE id = p_user;
  INSERT INTO public.sales_team_members (user_id, company_name, started_at, added_by)
  VALUES (p_user, v_company, COALESCE(p_started_at, v_joined, CURRENT_DATE), auth.uid())
  ON CONFLICT (user_id) DO UPDATE SET started_at = COALESCE(p_started_at, public.sales_team_members.started_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.team_set_member_start(p_user UUID, p_started_at DATE)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.team_is_manager() THEN
    RAISE EXCEPTION 'Solo un director o admin cambia la fecha de inicio.' USING ERRCODE = '42501';
  END IF;
  IF p_started_at IS NULL OR p_started_at > CURRENT_DATE + 31 THEN
    RAISE EXCEPTION 'Fecha de inicio inválida.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.sales_team_members SET started_at = p_started_at
   WHERE user_id = p_user AND company_name = public.team_my_company();
END;
$$;

CREATE OR REPLACE FUNCTION public.team_remove_member(p_user UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.team_is_manager() THEN
    RAISE EXCEPTION 'Solo un director o admin arma el equipo.' USING ERRCODE = '42501';
  END IF;
  -- Las metas se van con la persona; los comentarios quedan (son historia).
  DELETE FROM public.sales_team_goals WHERE user_id = p_user AND company_name = public.team_my_company();
  DELETE FROM public.sales_team_members WHERE user_id = p_user AND company_name = public.team_my_company();
END;
$$;

-- p_target NULL o 0 = quitar la meta.
CREATE OR REPLACE FUNCTION public.team_set_goal(p_user UUID, p_period TEXT, p_metric TEXT, p_target INTEGER)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_company TEXT := public.team_my_company();
BEGIN
  IF NOT public.team_is_manager() THEN
    RAISE EXCEPTION 'Solo un director o admin define metas.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.team_is_rostered(p_user) THEN
    RAISE EXCEPTION 'Primero agrega a esa persona al equipo.' USING ERRCODE = '42501';
  END IF;
  IF p_target IS NULL OR p_target <= 0 THEN
    DELETE FROM public.sales_team_goals
     WHERE user_id = p_user AND period = p_period AND metric = p_metric AND company_name = v_company;
    RETURN;
  END IF;
  INSERT INTO public.sales_team_goals (user_id, company_name, period, metric, target, set_by)
  VALUES (p_user, v_company, p_period, p_metric, p_target, auth.uid())
  ON CONFLICT (user_id, period, metric)
  DO UPDATE SET target = EXCLUDED.target, set_by = EXCLUDED.set_by, company_name = EXCLUDED.company_name;
END;
$$;

-- Conteos por miembro de la nómina en [p_from, p_to). Para el ranking y las
-- metas: el SDR ve los conteos de su equipo (nunca leads), el director también.
CREATE OR REPLACE FUNCTION public.team_metrics(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_company TEXT := public.team_my_company();
  v_out JSONB := '[]'::jsonb;
  r RECORD;
BEGIN
  IF NOT public.team_can_view() THEN
    RAISE EXCEPTION 'No eres parte de un equipo.' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > INTERVAL '400 days' THEN
    RAISE EXCEPTION 'Período inválido.' USING ERRCODE = '22023';
  END IF;
  FOR r IN
    SELECT t.user_id FROM public.sales_team_members t
      JOIN public.profiles p ON p.id = t.user_id AND btrim(p.company_name) = t.company_name
     WHERE t.company_name = v_company
  LOOP
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'user_id', r.user_id,
      'metrics', public.team_member_activity(r.user_id, p_from, p_to)));
  END LOOP;
  RETURN v_out;
END;
$$;

-- Rampa: semanas de antigüedad 1..p_weeks de cada miembro desde su inicio.
-- Para un SDR, los compañeros van SIN user_id (solo sirven para la mediana).
CREATE OR REPLACE FUNCTION public.team_ramp(p_weeks INTEGER DEFAULT 8, p_tz TEXT DEFAULT 'UTC')
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_company TEXT := public.team_my_company();
  v_manager BOOLEAN := public.team_is_manager();
  v_weeks INTEGER := LEAST(GREATEST(COALESCE(p_weeks, 8), 1), 12);
  v_tz TEXT := 'UTC';
  v_out JSONB := '[]'::jsonb;
  v_member JSONB;
  v_start TIMESTAMPTZ;
  v_from TIMESTAMPTZ;
  v_to TIMESTAMPTZ;
  r RECORD;
  w INTEGER;
BEGIN
  IF NOT public.team_can_view() THEN
    RAISE EXCEPTION 'No eres parte de un equipo.' USING ERRCODE = '42501';
  END IF;
  IF p_tz IS NOT NULL AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) THEN
    v_tz := p_tz;
  END IF;
  FOR r IN
    SELECT t.user_id, t.started_at FROM public.sales_team_members t
      JOIN public.profiles p ON p.id = t.user_id AND btrim(p.company_name) = t.company_name
     WHERE t.company_name = v_company
  LOOP
    v_start := (r.started_at::timestamp) AT TIME ZONE v_tz;
    v_member := '[]'::jsonb;
    FOR w IN 0 .. v_weeks - 1 LOOP
      v_from := v_start + make_interval(days => 7 * w);
      EXIT WHEN v_from >= NOW();
      v_to := v_from + INTERVAL '7 days';
      v_member := v_member || jsonb_build_array(jsonb_build_object(
        'week', w + 1,
        'complete', v_to <= NOW(),
        'metrics', public.team_member_activity(r.user_id, v_from, LEAST(v_to, NOW()))));
    END LOOP;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'user_id', CASE WHEN v_manager OR r.user_id = auth.uid() THEN r.user_id END,
      'self', r.user_id = auth.uid(),
      'started_at', r.started_at,
      'weeks', v_member));
  END LOOP;
  RETURN v_out;
END;
$$;

-- Reportes del Meeting Coach de un miembro: el director de su empresa, o él
-- mismo. Solo los campos que la revisión necesita (sin transcript).
CREATE OR REPLACE FUNCTION public.team_review_meetings(p_member UUID, p_limit INTEGER DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (
       p_member = auth.uid()
       OR (public.team_is_manager() AND public.team_is_rostered(p_member))) THEN
    RAISE EXCEPTION 'No puedes ver los reportes de esa persona.' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(x ORDER BY x->>'started_at' DESC)
      FROM (
        SELECT jsonb_build_object(
                 'id', m.id,
                 'started_at', m.started_at,
                 'ended_at', m.ended_at,
                 'status', m.status,
                 'prospect_name', m.prospect_name,
                 'score_total', m.score_total,
                 'outcome', m.outcome,
                 'top_objection', m.top_objection,
                 'report', CASE WHEN m.final_report IS NULL THEN NULL ELSE jsonb_build_object(
                   'scores', m.final_report->'scores',
                   'resumen_corto', m.final_report->'resumen_corto',
                   'resumen', m.final_report->'resumen',
                   'siguiente_paso', m.final_report->'siguiente_paso',
                   'codigo_reptil', m.final_report->'codigo_reptil',
                   'objections', m.final_report->'objections',
                   'feedback', m.final_report->'feedback',
                   'verdict', m.final_report->'verdict',
                   'temperatura_lead', m.final_report->'temperatura_lead') END
               ) AS x
          FROM public.coach_meetings m
         WHERE m.user_id = p_member
         ORDER BY m.started_at DESC NULLS LAST
         LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100)
      ) q), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.team_add_comment(p_member UUID, p_kind TEXT, p_subject TEXT, p_body TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_kind TEXT := COALESCE(NULLIF(p_kind, ''), 'general');
BEGIN
  IF NOT (public.team_is_manager() AND public.team_is_rostered(p_member)) THEN
    RAISE EXCEPTION 'Solo el director del equipo deja comentarios de coaching.' USING ERRCODE = '42501';
  END IF;
  IF v_kind = 'meeting' AND NOT EXISTS (
       SELECT 1 FROM public.coach_meetings WHERE id::text = p_subject AND user_id = p_member) THEN
    RAISE EXCEPTION 'Esa reunión no es de esta persona.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.sales_team_comments (company_name, member_id, author_id, subject_kind, subject_id, body)
  VALUES (public.team_my_company(), p_member, auth.uid(), v_kind,
          CASE WHEN v_kind = 'general' THEN NULL ELSE p_subject END, btrim(p_body))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.team_delete_comment(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  DELETE FROM public.sales_team_comments WHERE id = p_id AND author_id = auth.uid();
END;
$$;

DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.team_overview()',
    'public.team_add_member(uuid, date)',
    'public.team_set_member_start(uuid, date)',
    'public.team_remove_member(uuid)',
    'public.team_set_goal(uuid, text, text, integer)',
    'public.team_metrics(timestamptz, timestamptz)',
    'public.team_ramp(integer, text)',
    'public.team_review_meetings(uuid, integer)',
    'public.team_add_comment(uuid, text, text, text)',
    'public.team_delete_comment(uuid)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
  END LOOP;
END $$;
