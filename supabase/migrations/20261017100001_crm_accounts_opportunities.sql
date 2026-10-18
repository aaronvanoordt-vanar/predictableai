-- ═══════════════════════════════════════════════════════════════════════════
-- CRM de cuentas y oportunidades — 2026-10-17 (docs/ROADMAP_GTM_OS.md §1 ítem 8)
--
-- Hasta hoy el «CRM» de Predictable era solo prospect_list_members.contact_status.
-- Esta migración agrega el objeto Cuenta (empresa), un pipeline de
-- oportunidades configurable, tareas y el historial de etapas. NO copia datos:
-- las personas, los mensajes de la Bandeja, los eventos de campaña, las
-- reuniones del coach y las señales del Radar se leen de sus tablas de siempre
-- a través de company_id / member_id.
--
--   • crm_companies          — una fila por empresa y usuario. Llave: el dominio
--     normalizado (crm_norm_domain); sin dominio, el nombre normalizado
--     (name_key) solo para ENLAZAR, nunca para crear en automático. Firmografía
--     de Apollo (snapshot.organization del lead) o del Radar; solo rellena
--     huecos, nunca pisa lo que escribió el usuario.
--   • prospect_list_members.company_id / radar_signals.company_id — el enlace.
--     Un lead nuevo con dominio crea o reutiliza su cuenta (trigger BEFORE);
--     una señal se enlaza a una cuenta que ya existe y crea la suya cuando el
--     usuario la guarda. Lo anterior a esta migración lo enlaza
--     crm_backfill_companies() (la pantalla de Cuentas la llama al abrir).
--   • crm_stages             — el pipeline por usuario (kind open/won/lost,
--     probabilidad, auto_key para los enganches). crm_seed_stages() crea el de
--     por defecto: Reunión agendada → Reunión tomada → Propuesta → Negociación
--     → Ganada / Perdida.
--   • crm_opportunities      — monto, moneda local (ISO 4217), fecha de cierre,
--     responsable, motivo de pérdida OBLIGATORIO en una etapa perdida (lo exige
--     el trigger, no solo la UI). El motivo entra al learning-loop (scope
--     deal_loss en learning_insights → _shared/intelligence.ts).
--   • crm_opportunity_history — cada cambio de etapa, con quién lo hizo
--     (user / coach / api). Solo lo escribe el trigger.
--   • crm_tasks              — tareas por lead, cuenta u oportunidad, con
--     vencimiento.
--   • crm_dismissed_suggestions — «Respondió → ¿crear oportunidad?» descartado.
--
-- Enganches automáticos sin inventar:
--   • Reunión cerrada en el Meeting Coach (coach_meetings.status → closed con
--     reporte real) → las oportunidades abiertas de ese lead en una etapa
--     anterior a «Reunión tomada» (auto_key meeting_held) pasan a esa etapa.
--   • Respuesta / reunión agendada → la UI SUGIERE crear la oportunidad; nunca
--     la crea sola (no hay clasificador de respuestas: el humano decide).
--
-- Listo para sincronizar con CRMs externos (otra sesión: Pipedrive, HubSpot en
-- dos sentidos): external_id / external_source / external_synced_at en
-- cuentas, etapas, oportunidades y tareas, con índice único por fuente.
--
-- API pública: eventos company.created, opportunity.created,
-- opportunity.stage_changed, task.created y task.completed (emit_api_event de
-- 20260923000010; los triggers nunca rompen la escritura original).
--
-- Todas las sentencias son idempotentes (seguras de re-aplicar).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Normalización (espejo de _shared/crm.ts y js/crm.js) ─────────────────

-- "https://www.Acme.com.mx/contacto" → "acme.com.mx". NULL si no parece un dominio.
CREATE OR REPLACE FUNCTION public.crm_norm_domain(p TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT CASE WHEN d ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' THEN d END
    FROM (
      SELECT regexp_replace(
               regexp_replace(
                 regexp_replace(lower(btrim(COALESCE(p, ''))), '^[a-z]+://', ''),
               '^www\.', ''),
             '[/?#:].*$|\.$', '') AS d
    ) x;
$$;

-- Correos gratuitos: nunca son el dominio de una empresa.
CREATE OR REPLACE FUNCTION public.crm_is_free_mail_domain(p TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT COALESCE(p, '') = ANY (ARRAY[
    'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.es', 'hotmail.com.mx', 'hotmail.com.ar',
    'outlook.com', 'outlook.es', 'live.com', 'live.com.mx', 'msn.com', 'yahoo.com', 'yahoo.es',
    'yahoo.com.mx', 'yahoo.com.ar', 'yahoo.com.br', 'icloud.com', 'me.com', 'aol.com',
    'protonmail.com', 'proton.me', 'gmx.com', 'uol.com.br', 'bol.com.br', 'terra.com.br'
  ]);
$$;

-- "Acmé  S.A." → "acmesa". Solo para enlazar leads sin dominio a una cuenta existente.
CREATE OR REPLACE FUNCTION public.crm_norm_name(p TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT NULLIF(regexp_replace(
    translate(lower(btrim(COALESCE(p, ''))), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc'),
    '[^a-z0-9]', '', 'g'), '');
$$;

REVOKE ALL ON FUNCTION public.crm_norm_domain(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crm_is_free_mail_domain(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crm_norm_name(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_norm_domain(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_is_free_mail_domain(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_norm_name(TEXT) TO authenticated, service_role;

-- ── 2. Cuentas ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_companies (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name               TEXT        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 240),
  name_key           TEXT        GENERATED ALWAYS AS (public.crm_norm_name(name)) STORED,
  domain             TEXT        CHECK (domain IS NULL OR char_length(domain) <= 253),
  -- Firmografía (Apollo o Radar; el usuario la corrige).
  website            TEXT,
  industry           TEXT,
  employee_count     TEXT,
  annual_revenue     TEXT,
  founded_year       INTEGER     CHECK (founded_year IS NULL OR founded_year BETWEEN 1600 AND 2100),
  country            TEXT,
  state              TEXT,
  city               TEXT,
  phone              TEXT,
  linkedin_url       TEXT,
  logo_url           TEXT,
  description        TEXT        CHECK (description IS NULL OR char_length(description) <= 4000),
  apollo_org_id      TEXT,
  firmographics_source TEXT      CHECK (firmographics_source IS NULL OR firmographics_source IN ('apollo', 'radar', 'manual', 'api', 'integration')),
  owner_name         TEXT        CHECK (owner_name IS NULL OR char_length(owner_name) <= 120),
  notes              TEXT        CHECK (notes IS NULL OR char_length(notes) <= 20000),
  -- De dónde salió la fila: lead de una lista, señal del Radar, la UI, la API…
  source             TEXT        NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('lead', 'radar', 'manual', 'api', 'integration', 'backfill')),
  -- Sincronización con CRMs externos (la escribe la integración que la haga).
  external_id        TEXT,
  external_source    TEXT,
  external_synced_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_companies_user_domain_key
  ON public.crm_companies (user_id, domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_companies_user_name_key_idx
  ON public.crm_companies (user_id, name_key);
CREATE INDEX IF NOT EXISTS crm_companies_user_created_idx
  ON public.crm_companies (user_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS crm_companies_external_key
  ON public.crm_companies (user_id, external_source, external_id) WHERE external_id IS NOT NULL;

-- El dominio siempre se guarda normalizado (y nunca uno de correo gratuito).
CREATE OR REPLACE FUNCTION public.crm_companies_normalize()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.name := btrim(NEW.name);
  NEW.domain := public.crm_norm_domain(COALESCE(NEW.domain, NEW.website));
  IF public.crm_is_free_mail_domain(NEW.domain) THEN NEW.domain := NULL; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS crm_companies_normalize ON public.crm_companies;
CREATE TRIGGER crm_companies_normalize
  BEFORE INSERT OR UPDATE OF name, domain, website ON public.crm_companies
  FOR EACH ROW EXECUTE FUNCTION public.crm_companies_normalize();

DROP TRIGGER IF EXISTS crm_companies_updated_at ON public.crm_companies;
CREATE TRIGGER crm_companies_updated_at
  BEFORE UPDATE ON public.crm_companies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.prospect_list_members
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.crm_companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS prospect_list_members_company_idx
  ON public.prospect_list_members (company_id) WHERE company_id IS NOT NULL;

ALTER TABLE public.radar_signals
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.crm_companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS radar_signals_company_idx
  ON public.radar_signals (company_id) WHERE company_id IS NOT NULL;

COMMENT ON COLUMN public.prospect_list_members.company_id IS
  'Cuenta del CRM (crm_companies). La pone el trigger crm_link_member por dominio; el usuario la puede cambiar.';
COMMENT ON COLUMN public.radar_signals.company_id IS
  'Cuenta del CRM de la empresa de la señal. Se enlaza a una cuenta existente; al guardar la señal se crea.';

-- Rellena huecos de firmografía con un objeto tipo Apollo organization.
-- Nunca pisa un valor que ya existe.
CREATE OR REPLACE FUNCTION public.crm_fill_firmographics(p_company UUID, p_org JSONB, p_source TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year TEXT;
BEGIN
  IF p_company IS NULL OR p_org IS NULL OR jsonb_typeof(p_org) <> 'object' OR p_org = '{}'::jsonb THEN RETURN; END IF;
  v_year := NULLIF(p_org ->> 'founded_year', '');
  UPDATE public.crm_companies c SET
    website        = COALESCE(c.website, NULLIF(p_org ->> 'website_url', '')),
    industry       = COALESCE(c.industry, NULLIF(p_org ->> 'industry', '')),
    employee_count = COALESCE(c.employee_count, NULLIF(p_org ->> 'estimated_num_employees', '')),
    annual_revenue = COALESCE(c.annual_revenue, NULLIF(p_org ->> 'annual_revenue_printed', '')),
    founded_year   = COALESCE(c.founded_year, CASE WHEN v_year ~ '^\d{4}$' AND v_year::INT BETWEEN 1600 AND 2100 THEN v_year::INT END),
    country        = COALESCE(c.country, NULLIF(p_org ->> 'country', '')),
    state          = COALESCE(c.state, NULLIF(p_org ->> 'state', '')),
    city           = COALESCE(c.city, NULLIF(p_org ->> 'city', '')),
    phone          = COALESCE(c.phone, NULLIF(p_org #>> '{primary_phone,sanitized_number}', ''), NULLIF(p_org ->> 'phone', '')),
    linkedin_url   = COALESCE(c.linkedin_url, NULLIF(p_org ->> 'linkedin_url', '')),
    logo_url       = COALESCE(c.logo_url, NULLIF(p_org ->> 'logo_url', '')),
    description    = COALESCE(c.description, left(NULLIF(p_org ->> 'short_description', ''), 4000)),
    apollo_org_id  = COALESCE(c.apollo_org_id, NULLIF(p_org ->> 'id', '')),
    firmographics_source = COALESCE(c.firmographics_source, p_source)
  WHERE c.id = p_company
    AND (c.website IS NULL OR c.industry IS NULL OR c.employee_count IS NULL OR c.country IS NULL
         OR c.linkedin_url IS NULL OR c.logo_url IS NULL OR c.apollo_org_id IS NULL);
END;
$$;

-- Devuelve la cuenta de una empresa: por dominio (y la crea si p_create) o, sin
-- dominio, la que ya exista con el mismo nombre normalizado (nunca la crea).
CREATE OR REPLACE FUNCTION public.crm_company_for(
  p_user UUID, p_name TEXT, p_domain TEXT, p_org JSONB, p_create BOOLEAN, p_source TEXT DEFAULT 'lead'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org  JSONB := CASE WHEN p_org IS NOT NULL AND jsonb_typeof(p_org) = 'object' THEN p_org ELSE '{}'::jsonb END;
  v_dom  TEXT;
  v_name TEXT;
  v_key  TEXT;
  v_id   UUID;
  v_prev TEXT;
BEGIN
  IF p_user IS NULL THEN RETURN NULL; END IF;
  v_dom := public.crm_norm_domain(COALESCE(NULLIF(btrim(p_domain), ''), v_org ->> 'primary_domain', v_org ->> 'website_url'));
  IF public.crm_is_free_mail_domain(v_dom) THEN v_dom := NULL; END IF;
  v_name := left(btrim(COALESCE(NULLIF(btrim(p_name), ''), v_org ->> 'name', '')), 240);

  IF v_dom IS NOT NULL THEN
    SELECT id INTO v_id FROM public.crm_companies WHERE user_id = p_user AND domain = v_dom;
    IF v_id IS NULL AND p_create THEN
      -- Avisa al trigger AFTER INSERT que no recorra los leads del usuario: el
      -- que llama ya enlaza el suyo (con 500 leads nuevos serían 500 recorridos).
      v_prev := current_setting('crm.linking', true);
      PERFORM set_config('crm.linking', 'member', true);
      INSERT INTO public.crm_companies (user_id, name, domain, source)
      VALUES (p_user, COALESCE(NULLIF(v_name, ''), v_dom), v_dom, CASE WHEN p_source IN ('lead', 'radar', 'manual', 'api', 'integration', 'backfill') THEN p_source ELSE 'lead' END)
      ON CONFLICT (user_id, domain) WHERE domain IS NOT NULL DO NOTHING
      RETURNING id INTO v_id;
      PERFORM set_config('crm.linking', COALESCE(v_prev, ''), true);
      IF v_id IS NULL THEN
        SELECT id INTO v_id FROM public.crm_companies WHERE user_id = p_user AND domain = v_dom;
      END IF;
    END IF;
  ELSE
    v_key := public.crm_norm_name(v_name);
    IF v_key IS NOT NULL AND char_length(v_key) >= 2 THEN
      SELECT id INTO v_id FROM public.crm_companies
       WHERE user_id = p_user AND name_key = v_key
       ORDER BY (domain IS NULL), created_at
       LIMIT 1;
    END IF;
  END IF;

  IF v_id IS NOT NULL AND v_org <> '{}'::jsonb THEN
    PERFORM public.crm_fill_firmographics(v_id, v_org, CASE WHEN p_source = 'radar' THEN 'radar' ELSE 'apollo' END);
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_fill_firmographics(UUID, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crm_company_for(UUID, TEXT, TEXT, JSONB, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;

-- Lead → cuenta. BEFORE: no hay una segunda escritura sobre la fila.
CREATE OR REPLACE FUNCTION public.crm_link_member()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org JSONB;
BEGIN
  v_org := CASE WHEN jsonb_typeof(NEW.snapshot -> 'organization') = 'object' THEN NEW.snapshot -> 'organization' ELSE NULL END;
  IF TG_OP = 'INSERT' THEN
    IF NEW.company_id IS NULL THEN
      NEW.company_id := public.crm_company_for(NEW.user_id, NEW.company, NEW.company_domain, v_org, TRUE, 'lead');
    ELSIF NOT EXISTS (SELECT 1 FROM public.crm_companies c WHERE c.id = NEW.company_id AND c.user_id = NEW.user_id) THEN
      NEW.company_id := NULL;
    END IF;
  ELSE
    IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      -- Cambio manual de cuenta: solo a una cuenta propia.
      IF NEW.company_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.crm_companies c WHERE c.id = NEW.company_id AND c.user_id = NEW.user_id) THEN
        NEW.company_id := OLD.company_id;
      END IF;
    ELSIF public.crm_norm_domain(NEW.company_domain) IS DISTINCT FROM public.crm_norm_domain(OLD.company_domain)
          OR (NEW.company_id IS NULL AND public.crm_norm_name(NEW.company) IS DISTINCT FROM public.crm_norm_name(OLD.company)) THEN
      NEW.company_id := COALESCE(public.crm_company_for(NEW.user_id, NEW.company, NEW.company_domain, v_org, TRUE, 'lead'), NEW.company_id);
    ELSIF NEW.company_id IS NOT NULL AND v_org IS NOT NULL AND NEW.snapshot IS DISTINCT FROM OLD.snapshot THEN
      PERFORM public.crm_fill_firmographics(NEW.company_id, v_org, 'apollo');
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Enlazar una cuenta jamás impide guardar un lead.
  RAISE WARNING 'crm_link_member: %', SQLERRM;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_link_member() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_link_member_ins ON public.prospect_list_members;
CREATE TRIGGER crm_link_member_ins
  BEFORE INSERT ON public.prospect_list_members
  FOR EACH ROW EXECUTE FUNCTION public.crm_link_member();

DROP TRIGGER IF EXISTS crm_link_member_upd ON public.prospect_list_members;
CREATE TRIGGER crm_link_member_upd
  BEFORE UPDATE OF company, company_domain, snapshot, company_id ON public.prospect_list_members
  FOR EACH ROW EXECUTE FUNCTION public.crm_link_member();

-- Señal → cuenta existente; al guardarla (status → saved) crea la cuenta.
CREATE OR REPLACE FUNCTION public.crm_link_signal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_create BOOLEAN;
  v_org    JSONB;
BEGIN
  IF NEW.company_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.company_id IS NOT DISTINCT FROM OLD.company_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.company_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.crm_companies c WHERE c.id = NEW.company_id AND c.user_id = NEW.user_id) THEN
      NEW.company_id := OLD.company_id;
    END IF;
    RETURN NEW;
  END IF;
  v_create := NEW.status = 'saved';
  v_org := jsonb_strip_nulls(jsonb_build_object(
    'name', NEW.company_name, 'website_url', NEW.website, 'industry', NEW.industry,
    'estimated_num_employees', NEW.employee_count, 'country', NEW.country, 'id', NEW.apollo_org_id));
  NEW.company_id := public.crm_company_for(NEW.user_id, NEW.company_name, COALESCE(NEW.company_domain, NEW.website), v_org, v_create, 'radar');
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'crm_link_signal: %', SQLERRM;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_link_signal() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_link_signal_ins ON public.radar_signals;
CREATE TRIGGER crm_link_signal_ins
  BEFORE INSERT ON public.radar_signals
  FOR EACH ROW EXECUTE FUNCTION public.crm_link_signal();

DROP TRIGGER IF EXISTS crm_link_signal_upd ON public.radar_signals;
CREATE TRIGGER crm_link_signal_upd
  BEFORE UPDATE OF status, company_domain, company_id ON public.radar_signals
  FOR EACH ROW EXECUTE FUNCTION public.crm_link_signal();

-- Cuenta nueva (desde la UI o la API) → enlaza los leads y señales que ya
-- existían con ese dominio (o ese nombre, para leads sin dominio).
CREATE OR REPLACE FUNCTION public.crm_companies_after_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mode TEXT := COALESCE(current_setting('crm.linking', true), '');
BEGIN
  IF v_mode = '' THEN
    UPDATE public.prospect_list_members m
       SET company_id = NEW.id
     WHERE m.user_id = NEW.user_id
       AND m.company_id IS NULL
       AND ((NEW.domain IS NOT NULL AND public.crm_norm_domain(m.company_domain) = NEW.domain)
         OR (public.crm_norm_domain(m.company_domain) IS NULL AND public.crm_norm_name(m.company) = NEW.name_key));
    UPDATE public.radar_signals s
       SET company_id = NEW.id
     WHERE s.user_id = NEW.user_id
       AND s.company_id IS NULL
       AND ((NEW.domain IS NOT NULL AND public.crm_norm_domain(COALESCE(s.company_domain, s.website)) = NEW.domain)
         OR (public.crm_norm_domain(COALESCE(s.company_domain, s.website)) IS NULL AND public.crm_norm_name(s.company_name) = NEW.name_key));
  END IF;
  IF v_mode <> 'backfill' THEN
    PERFORM public.emit_api_event(NEW.user_id, 'company.created', jsonb_build_object('company', public.crm_company_json(NEW)));
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'crm_companies_after_insert: %', SQLERRM;
  RETURN NULL;
END;
$$;

-- ── 3. Pipeline ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_stages (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name               TEXT        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  position           INTEGER     NOT NULL DEFAULT 0,
  -- open = en curso; won = ganada; lost = perdida (exige motivo).
  kind               TEXT        NOT NULL DEFAULT 'open' CHECK (kind IN ('open', 'won', 'lost')),
  probability        INTEGER     NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  -- Enganches automáticos: meeting_scheduled (reunión agendada) / meeting_held
  -- (reunión tomada: la mueve el cierre del Meeting Coach).
  auto_key           TEXT        CHECK (auto_key IS NULL OR auto_key IN ('meeting_scheduled', 'meeting_held')),
  external_id        TEXT,
  external_source    TEXT,
  external_synced_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS crm_stages_user_idx ON public.crm_stages (user_id, position);
-- Una sola etapa ganada y una sola perdida por pipeline; un enganche por clave.
CREATE UNIQUE INDEX IF NOT EXISTS crm_stages_user_kind_key
  ON public.crm_stages (user_id, kind) WHERE kind <> 'open';
CREATE UNIQUE INDEX IF NOT EXISTS crm_stages_user_auto_key
  ON public.crm_stages (user_id, auto_key) WHERE auto_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS crm_stages_external_key
  ON public.crm_stages (user_id, external_source, external_id) WHERE external_id IS NOT NULL;

DROP TRIGGER IF EXISTS crm_stages_updated_at ON public.crm_stages;
CREATE TRIGGER crm_stages_updated_at
  BEFORE UPDATE ON public.crm_stages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Crea el pipeline por defecto si el usuario no tiene ninguno y devuelve sus etapas.
CREATE OR REPLACE FUNCTION public.crm_seed_stages(p_user UUID)
RETURNS SETOF public.crm_stages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user IS NULL THEN RETURN; END IF;
  -- Dos pestañas abiertas a la vez no duplican el pipeline.
  PERFORM pg_advisory_xact_lock(hashtext('crm_seed_stages:' || p_user::TEXT));
  IF NOT EXISTS (SELECT 1 FROM public.crm_stages WHERE user_id = p_user) THEN
    INSERT INTO public.crm_stages (user_id, name, position, kind, probability, auto_key) VALUES
      (p_user, 'Reunión agendada', 1, 'open', 20, 'meeting_scheduled'),
      (p_user, 'Reunión tomada',   2, 'open', 40, 'meeting_held'),
      (p_user, 'Propuesta',        3, 'open', 60, NULL),
      (p_user, 'Negociación',      4, 'open', 80, NULL),
      (p_user, 'Ganada',           5, 'won', 100, NULL),
      (p_user, 'Perdida',          6, 'lost',  0, NULL);
  END IF;
  RETURN QUERY SELECT * FROM public.crm_stages WHERE user_id = p_user ORDER BY position, created_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_ensure_pipeline()
RETURNS SETOF public.crm_stages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  RETURN QUERY SELECT * FROM public.crm_seed_stages(auth.uid());
END;
$$;

REVOKE ALL ON FUNCTION public.crm_seed_stages(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_seed_stages(UUID) TO service_role;
REVOKE ALL ON FUNCTION public.crm_ensure_pipeline() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_ensure_pipeline() TO authenticated;

-- ── 4. Oportunidades ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_opportunities (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name               TEXT          NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  company_id         UUID          REFERENCES public.crm_companies(id) ON DELETE SET NULL,
  -- Contacto principal (un lead de Listas).
  member_id          UUID          REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  stage_id           UUID          NOT NULL REFERENCES public.crm_stages(id) ON DELETE RESTRICT,
  amount             NUMERIC(16,2) CHECK (amount IS NULL OR amount >= 0),
  -- Moneda local ISO 4217 (MXN, COP, CLP, PEN, ARS, BRL, USD…). Sin conversión.
  currency           TEXT          NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  close_date         DATE,
  owner_name         TEXT          CHECK (owner_name IS NULL OR char_length(owner_name) <= 120),
  owner_id           UUID          REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Motivo de pérdida: obligatorio en una etapa kind = 'lost' (trigger).
  -- Espejo de LOST_REASONS en _shared/crm.ts y js/crm.js.
  lost_reason        TEXT          CHECK (lost_reason IS NULL OR lost_reason IN (
                       'precio', 'presupuesto', 'competencia', 'timing', 'prioridad',
                       'decisor', 'sin_respuesta', 'no_encaja', 'interno', 'otro')),
  lost_note          TEXT          CHECK (lost_note IS NULL OR char_length(lost_note) <= 1000),
  lost_competitor    TEXT          CHECK (lost_competitor IS NULL OR char_length(lost_competitor) <= 120),
  closed_at          TIMESTAMPTZ,
  notes              TEXT          CHECK (notes IS NULL OR char_length(notes) <= 20000),
  -- Cómo nació: a mano, desde una respuesta, desde una reunión, el Radar o la API.
  source             TEXT          NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual', 'reply', 'meeting', 'radar', 'api', 'integration')),
  stage_changed_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  stage_changed_by   TEXT          NOT NULL DEFAULT 'user' CHECK (stage_changed_by IN ('user', 'coach', 'api', 'integration')),
  external_id        TEXT,
  external_source    TEXT,
  external_synced_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS crm_opportunities_user_created_idx ON public.crm_opportunities (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS crm_opportunities_stage_idx ON public.crm_opportunities (stage_id);
CREATE INDEX IF NOT EXISTS crm_opportunities_company_idx ON public.crm_opportunities (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_opportunities_member_idx ON public.crm_opportunities (member_id) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS crm_opportunities_external_key
  ON public.crm_opportunities (user_id, external_source, external_id) WHERE external_id IS NOT NULL;

DROP TRIGGER IF EXISTS crm_opportunities_updated_at ON public.crm_opportunities;
CREATE TRIGGER crm_opportunities_updated_at
  BEFORE UPDATE ON public.crm_opportunities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.crm_opportunity_history (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  opportunity_id  UUID        NOT NULL REFERENCES public.crm_opportunities(id) ON DELETE CASCADE,
  from_stage_id   UUID        REFERENCES public.crm_stages(id) ON DELETE SET NULL,
  to_stage_id     UUID        REFERENCES public.crm_stages(id) ON DELETE SET NULL,
  -- Nombre y tipo al momento del cambio (una etapa se puede renombrar después).
  from_stage_name TEXT,
  to_stage_name   TEXT,
  to_stage_kind   TEXT,
  changed_by      TEXT        NOT NULL DEFAULT 'user',
  lost_reason     TEXT,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS crm_opportunity_history_opp_idx ON public.crm_opportunity_history (opportunity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crm_opportunity_history_user_idx ON public.crm_opportunity_history (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.crm_company_json(c public.crm_companies)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'name', c.name, 'domain', c.domain, 'website', c.website,
    'industry', c.industry, 'employee_count', c.employee_count, 'annual_revenue', c.annual_revenue,
    'founded_year', c.founded_year, 'country', c.country, 'state', c.state, 'city', c.city,
    'phone', c.phone, 'linkedin_url', c.linkedin_url, 'logo_url', c.logo_url,
    'apollo_org_id', c.apollo_org_id, 'owner_name', c.owner_name, 'source', c.source,
    'external_id', c.external_id, 'external_source', c.external_source,
    'created_at', c.created_at, 'updated_at', c.updated_at);
$$;

CREATE OR REPLACE FUNCTION public.crm_opportunity_json(o public.crm_opportunities)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', o.id, 'name', o.name, 'company_id', o.company_id, 'contact_id', o.member_id,
    'stage_id', o.stage_id, 'stage_name', s.name, 'stage_kind', s.kind, 'probability', s.probability,
    'amount', o.amount, 'currency', o.currency, 'close_date', o.close_date,
    'owner_name', o.owner_name, 'lost_reason', o.lost_reason, 'lost_note', o.lost_note,
    'lost_competitor', o.lost_competitor, 'closed_at', o.closed_at, 'source', o.source,
    'stage_changed_at', o.stage_changed_at, 'stage_changed_by', o.stage_changed_by,
    'external_id', o.external_id, 'external_source', o.external_source,
    'created_at', o.created_at, 'updated_at', o.updated_at)
  FROM (SELECT 1) one
  LEFT JOIN public.crm_stages s ON s.id = o.stage_id;
$$;

REVOKE ALL ON FUNCTION public.crm_company_json(public.crm_companies) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crm_opportunity_json(public.crm_opportunities) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crm_companies_after_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_companies_after_insert ON public.crm_companies;
CREATE TRIGGER crm_companies_after_insert
  AFTER INSERT ON public.crm_companies
  FOR EACH ROW EXECUTE FUNCTION public.crm_companies_after_insert();

-- Validación: etapa, cuenta y contacto del mismo dueño; motivo de pérdida
-- obligatorio; fechas de cierre y de cambio de etapa; quién lo movió.
CREATE OR REPLACE FUNCTION public.crm_opportunities_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stage   public.crm_stages;
  v_actor   TEXT := NULLIF(current_setting('crm.actor', true), '');
  v_changed BOOLEAN := TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id;
BEGIN
  SELECT * INTO v_stage FROM public.crm_stages WHERE id = NEW.stage_id AND user_id = NEW.user_id;
  IF v_stage.id IS NULL THEN
    RAISE EXCEPTION 'invalid_stage' USING ERRCODE = '23503', HINT = 'La etapa no existe o no es de tu pipeline.';
  END IF;
  IF NEW.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.crm_companies c WHERE c.id = NEW.company_id AND c.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'invalid_company' USING ERRCODE = '23503';
  END IF;
  IF NEW.member_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.prospect_list_members m WHERE m.id = NEW.member_id AND m.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'invalid_contact' USING ERRCODE = '23503';
    END IF;
    IF NEW.company_id IS NULL THEN
      SELECT m.company_id INTO NEW.company_id FROM public.prospect_list_members m WHERE m.id = NEW.member_id;
    END IF;
  END IF;
  IF NEW.owner_id IS NOT NULL AND NEW.owner_id <> NEW.user_id AND (TG_OP = 'INSERT' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id) THEN
    -- Sin equipos todavía: el responsable con id es el dueño; otro va en owner_name.
    NEW.owner_id := NEW.user_id;
  END IF;
  NEW.name := btrim(NEW.name);
  NEW.currency := upper(btrim(NEW.currency));

  IF v_stage.kind = 'lost' THEN
    IF NEW.lost_reason IS NULL THEN
      RAISE EXCEPTION 'lost_reason_required' USING ERRCODE = '23514', HINT = 'Una oportunidad perdida necesita su motivo.';
    END IF;
    IF NEW.lost_reason = 'otro' AND char_length(btrim(COALESCE(NEW.lost_note, ''))) < 3 THEN
      RAISE EXCEPTION 'lost_note_required' USING ERRCODE = '23514', HINT = 'Con el motivo «Otro», escribe cuál fue.';
    END IF;
  ELSE
    NEW.lost_reason := NULL;
    NEW.lost_note := NULL;
    NEW.lost_competitor := NULL;
  END IF;

  -- Fecha de cierre: la que manda quien escribe (p. ej. una importación
  -- histórica) o ahora; una oportunidad reabierta no tiene cierre.
  IF v_stage.kind IN ('won', 'lost') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.closed_at := COALESCE(NEW.closed_at, NOW());
    ELSIF v_changed AND NEW.closed_at IS NOT DISTINCT FROM OLD.closed_at THEN
      NEW.closed_at := NOW();
    ELSE
      NEW.closed_at := COALESCE(NEW.closed_at, NOW());
    END IF;
  ELSE
    NEW.closed_at := NULL;
  END IF;

  IF v_changed THEN
    NEW.stage_changed_at := NOW();
    NEW.stage_changed_by := CASE
      WHEN v_actor IN ('user', 'coach', 'api', 'integration') THEN v_actor
      WHEN COALESCE(auth.role(), '') = 'service_role' THEN 'api'
      ELSE 'user' END;
  ELSE
    NEW.stage_changed_at := OLD.stage_changed_at;
    NEW.stage_changed_by := OLD.stage_changed_by;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_opportunities_validate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_opportunities_validate ON public.crm_opportunities;
CREATE TRIGGER crm_opportunities_validate
  BEFORE INSERT OR UPDATE ON public.crm_opportunities
  FOR EACH ROW EXECUTE FUNCTION public.crm_opportunities_validate();

-- Historial + eventos de la API.
CREATE OR REPLACE FUNCTION public.crm_opportunities_after()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from public.crm_stages;
  v_to   public.crm_stages;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id THEN RETURN NULL; END IF;
  SELECT * INTO v_to FROM public.crm_stages WHERE id = NEW.stage_id;
  IF TG_OP = 'UPDATE' THEN SELECT * INTO v_from FROM public.crm_stages WHERE id = OLD.stage_id; END IF;

  INSERT INTO public.crm_opportunity_history
    (user_id, opportunity_id, from_stage_id, to_stage_id, from_stage_name, to_stage_name, to_stage_kind, changed_by, lost_reason, note)
  VALUES
    (NEW.user_id, NEW.id, v_from.id, v_to.id, v_from.name, v_to.name, v_to.kind, NEW.stage_changed_by, NEW.lost_reason,
     NULLIF(left(COALESCE(current_setting('crm.note', true), ''), 300), ''));

  IF TG_OP = 'INSERT' THEN
    PERFORM public.emit_api_event(NEW.user_id, 'opportunity.created', jsonb_build_object('opportunity', public.crm_opportunity_json(NEW)));
  ELSE
    PERFORM public.emit_api_event(NEW.user_id, 'opportunity.stage_changed', jsonb_build_object(
      'opportunity', public.crm_opportunity_json(NEW),
      'previous_stage_id', OLD.stage_id, 'previous_stage_name', v_from.name,
      'stage_id', NEW.stage_id, 'stage_name', v_to.name, 'stage_kind', v_to.kind));
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'crm_opportunities_after: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_opportunities_after() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_opportunities_after ON public.crm_opportunities;
CREATE TRIGGER crm_opportunities_after
  AFTER INSERT OR UPDATE ON public.crm_opportunities
  FOR EACH ROW EXECUTE FUNCTION public.crm_opportunities_after();

-- ── 5. Tareas ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_tasks (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title              TEXT        NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 240),
  notes              TEXT        CHECK (notes IS NULL OR char_length(notes) <= 4000),
  due_at             TIMESTAMPTZ,
  done_at            TIMESTAMPTZ,
  company_id         UUID        REFERENCES public.crm_companies(id) ON DELETE CASCADE,
  -- Quitar a un lead de una lista borra su fila: la tarea queda en la cuenta.
  member_id          UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  opportunity_id     UUID        REFERENCES public.crm_opportunities(id) ON DELETE CASCADE,
  owner_name         TEXT        CHECK (owner_name IS NULL OR char_length(owner_name) <= 120),
  external_id        TEXT,
  external_source    TEXT,
  external_synced_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS crm_tasks_user_due_idx ON public.crm_tasks (user_id, due_at) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS crm_tasks_user_created_idx ON public.crm_tasks (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS crm_tasks_company_idx ON public.crm_tasks (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_tasks_member_idx ON public.crm_tasks (member_id) WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_tasks_opportunity_idx ON public.crm_tasks (opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS crm_tasks_external_key
  ON public.crm_tasks (user_id, external_source, external_id) WHERE external_id IS NOT NULL;

DROP TRIGGER IF EXISTS crm_tasks_updated_at ON public.crm_tasks;
CREATE TRIGGER crm_tasks_updated_at
  BEFORE UPDATE ON public.crm_tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.crm_task_json(t public.crm_tasks)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', t.id, 'title', t.title, 'notes', t.notes, 'due_at', t.due_at, 'done_at', t.done_at,
    'company_id', t.company_id, 'contact_id', t.member_id, 'opportunity_id', t.opportunity_id,
    'owner_name', t.owner_name, 'external_id', t.external_id, 'external_source', t.external_source,
    'created_at', t.created_at, 'updated_at', t.updated_at);
$$;

REVOKE ALL ON FUNCTION public.crm_task_json(public.crm_tasks) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.crm_tasks_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.opportunity_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.crm_opportunities o WHERE o.id = NEW.opportunity_id AND o.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'invalid_opportunity' USING ERRCODE = '23503';
    END IF;
    IF NEW.company_id IS NULL OR NEW.member_id IS NULL THEN
      SELECT COALESCE(NEW.company_id, o.company_id), COALESCE(NEW.member_id, o.member_id)
        INTO NEW.company_id, NEW.member_id
        FROM public.crm_opportunities o WHERE o.id = NEW.opportunity_id;
    END IF;
  END IF;
  IF NEW.member_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.prospect_list_members m WHERE m.id = NEW.member_id AND m.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'invalid_contact' USING ERRCODE = '23503';
    END IF;
    IF NEW.company_id IS NULL THEN
      SELECT m.company_id INTO NEW.company_id FROM public.prospect_list_members m WHERE m.id = NEW.member_id;
    END IF;
  END IF;
  IF NEW.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.crm_companies c WHERE c.id = NEW.company_id AND c.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'invalid_company' USING ERRCODE = '23503';
  END IF;
  NEW.title := btrim(NEW.title);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_tasks_validate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_tasks_validate ON public.crm_tasks;
CREATE TRIGGER crm_tasks_validate
  BEFORE INSERT OR UPDATE OF opportunity_id, member_id, company_id, title ON public.crm_tasks
  FOR EACH ROW EXECUTE FUNCTION public.crm_tasks_validate();

CREATE OR REPLACE FUNCTION public.crm_tasks_after()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.emit_api_event(NEW.user_id, 'task.created', jsonb_build_object('task', public.crm_task_json(NEW)));
  ELSIF NEW.done_at IS NOT NULL AND OLD.done_at IS NULL THEN
    PERFORM public.emit_api_event(NEW.user_id, 'task.completed', jsonb_build_object('task', public.crm_task_json(NEW)));
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'crm_tasks_after: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_tasks_after() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_tasks_after ON public.crm_tasks;
CREATE TRIGGER crm_tasks_after
  AFTER INSERT OR UPDATE OF done_at ON public.crm_tasks
  FOR EACH ROW EXECUTE FUNCTION public.crm_tasks_after();

-- ── 6. Sugerencias descartadas ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_dismissed_suggestions (
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_id  UUID        NOT NULL REFERENCES public.prospect_list_members(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, member_id)
);

-- ── 7. RLS (dueño) ──────────────────────────────────────────────────────────

ALTER TABLE public.crm_companies             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_stages                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_opportunities         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_opportunity_history   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_tasks                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_dismissed_suggestions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t   TEXT;
  cmd TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_companies', 'crm_stages', 'crm_opportunities', 'crm_tasks', 'crm_dismissed_suggestions'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    FOREACH cmd IN ARRAY ARRAY['select', 'insert', 'update', 'delete'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Owner can ' || cmd || ' ' || t, t);
    END LOOP;
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (auth.uid() = user_id)', 'Owner can select ' || t, t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id)', 'Owner can insert ' || t, t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)', 'Owner can update ' || t, t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (auth.uid() = user_id)', 'Owner can delete ' || t, t);
  END LOOP;
END $$;

-- name_key es generada; el resto de columnas las puede escribir el dueño.
-- El historial solo lo escribe el trigger.
REVOKE ALL ON public.crm_opportunity_history FROM anon, PUBLIC, authenticated;
GRANT SELECT ON public.crm_opportunity_history TO authenticated;
DROP POLICY IF EXISTS "Owner can select crm_opportunity_history" ON public.crm_opportunity_history;
CREATE POLICY "Owner can select crm_opportunity_history" ON public.crm_opportunity_history
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- ── 8. Backfill por usuario (lo llama la pantalla de Cuentas) ───────────────

CREATE OR REPLACE FUNCTION public.crm_backfill_companies_for(p_user UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_created INTEGER := 0;
  v_members INTEGER := 0;
  v_named   INTEGER := 0;
  v_signals INTEGER := 0;
BEGIN
  IF p_user IS NULL THEN RETURN '{}'::jsonb; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('crm_backfill:' || p_user::TEXT));
  PERFORM set_config('crm.linking', 'backfill', true);

  -- Una cuenta por dominio de los leads que aún no tienen.
  WITH doms AS (
    SELECT DISTINCT ON (d)
           d, COALESCE(NULLIF(btrim(m.company), ''), m.snapshot #>> '{organization,name}', d) AS name,
           CASE WHEN jsonb_typeof(m.snapshot -> 'organization') = 'object' THEN m.snapshot -> 'organization' END AS org
      FROM (SELECT mm.*, public.crm_norm_domain(COALESCE(NULLIF(btrim(mm.company_domain), ''), mm.snapshot #>> '{organization,primary_domain}')) AS d
              FROM public.prospect_list_members mm
             WHERE mm.user_id = p_user AND mm.company_id IS NULL) m
     WHERE d IS NOT NULL AND NOT public.crm_is_free_mail_domain(d)
     ORDER BY d, (jsonb_typeof(m.snapshot -> 'organization') = 'object') DESC, m.created_at
  ), ins AS (
    INSERT INTO public.crm_companies (user_id, name, domain, source)
    SELECT p_user, left(name, 240), d, 'backfill' FROM doms
    ON CONFLICT (user_id, domain) WHERE domain IS NOT NULL DO NOTHING
    RETURNING id, domain
  )
  SELECT count(*) INTO v_created FROM ins;

  -- Firmografía de Apollo para las cuentas nuevas (solo huecos).
  PERFORM public.crm_fill_firmographics(c.id, x.org, 'apollo')
     FROM public.crm_companies c
     JOIN LATERAL (
       SELECT m.snapshot -> 'organization' AS org
         FROM public.prospect_list_members m
        WHERE m.user_id = p_user AND m.company_id IS NULL
          AND jsonb_typeof(m.snapshot -> 'organization') = 'object'
          AND public.crm_norm_domain(COALESCE(NULLIF(btrim(m.company_domain), ''), m.snapshot #>> '{organization,primary_domain}')) = c.domain
        LIMIT 1
     ) x ON TRUE
    WHERE c.user_id = p_user AND c.source = 'backfill' AND c.industry IS NULL AND c.apollo_org_id IS NULL;

  UPDATE public.prospect_list_members m
     SET company_id = c.id
    FROM public.crm_companies c
   WHERE m.user_id = p_user AND c.user_id = p_user AND m.company_id IS NULL
     AND c.domain = public.crm_norm_domain(COALESCE(NULLIF(btrim(m.company_domain), ''), m.snapshot #>> '{organization,primary_domain}'));
  GET DIAGNOSTICS v_members = ROW_COUNT;

  -- Leads sin dominio: solo a una cuenta que ya existe con el mismo nombre.
  UPDATE public.prospect_list_members m
     SET company_id = c.id
    FROM (SELECT DISTINCT ON (name_key) id, name_key FROM public.crm_companies
           WHERE user_id = p_user AND name_key IS NOT NULL AND char_length(name_key) >= 2
           ORDER BY name_key, (domain IS NULL), created_at) c
   WHERE m.user_id = p_user AND m.company_id IS NULL
     AND public.crm_norm_domain(COALESCE(NULLIF(btrim(m.company_domain), ''), m.snapshot #>> '{organization,primary_domain}')) IS NULL
     AND public.crm_norm_name(m.company) = c.name_key;
  GET DIAGNOSTICS v_named = ROW_COUNT;

  UPDATE public.radar_signals s
     SET company_id = c.id
    FROM public.crm_companies c
   WHERE s.user_id = p_user AND c.user_id = p_user AND s.company_id IS NULL
     AND c.domain = public.crm_norm_domain(COALESCE(s.company_domain, s.website));
  GET DIAGNOSTICS v_signals = ROW_COUNT;

  PERFORM set_config('crm.linking', '', true);
  RETURN jsonb_build_object('companies_created', v_created, 'contacts_linked', v_members + v_named, 'signals_linked', v_signals);
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_backfill_companies()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  RETURN public.crm_backfill_companies_for(auth.uid());
END;
$$;

REVOKE ALL ON FUNCTION public.crm_backfill_companies_for(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_backfill_companies_for(UUID) TO service_role;
REVOKE ALL ON FUNCTION public.crm_backfill_companies() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_backfill_companies() TO authenticated;

-- ── 9. Enganche: reunión cerrada en el Meeting Coach → «Reunión tomada» ─────
-- Solo con un reporte real (resumen no vacío; el informe «insuficiente» no
-- mueve nada), solo oportunidades abiertas de ESE lead y solo hacia adelante.

CREATE OR REPLACE FUNCTION public.crm_on_meeting_closed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_held public.crm_stages;
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed'
     AND NEW.prospect_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND char_length(btrim(COALESCE(NEW.final_report ->> 'resumen', ''))) > 0 THEN
    SELECT * INTO v_held FROM public.crm_stages WHERE user_id = NEW.user_id AND auto_key = 'meeting_held';
    IF v_held.id IS NOT NULL THEN
      PERFORM set_config('crm.actor', 'coach', true);
      PERFORM set_config('crm.note', 'Reunión analizada en el Meeting Coach', true);
      UPDATE public.crm_opportunities o
         SET stage_id = v_held.id
        FROM public.crm_stages s
       WHERE o.user_id = NEW.user_id
         AND o.member_id = NEW.prospect_id::UUID
         AND s.id = o.stage_id
         AND s.kind = 'open'
         AND s.position < v_held.position;
      PERFORM set_config('crm.actor', '', true);
      PERFORM set_config('crm.note', '', true);
    END IF;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'crm_on_meeting_closed: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_on_meeting_closed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_on_meeting_closed ON public.coach_meetings;
CREATE TRIGGER crm_on_meeting_closed
  AFTER UPDATE OF status ON public.coach_meetings
  FOR EACH ROW EXECUTE FUNCTION public.crm_on_meeting_closed();

-- ── 10. Aprendizaje: motivos de pérdida (learning-loop → intelligence.ts) ───

ALTER TABLE public.learning_insights DROP CONSTRAINT IF EXISTS learning_insights_scope_check;
ALTER TABLE public.learning_insights ADD CONSTRAINT learning_insights_scope_check
  CHECK (scope IN ('radar_detector', 'campaign_node', 'campaign', 'channel', 'angle',
                   'winning_message', 'objection', 'icp_attribute', 'summary', 'deal_loss'));

-- ── 11. API pública: el contacto lleva su cuenta ────────────────────────────
-- Mismas columnas que CONTACT_COLUMNS de _shared/devapi.ts.

CREATE OR REPLACE FUNCTION public.api_contact_json(m public.prospect_list_members)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', m.id, 'list_id', m.list_id,
    'external_id', m.external_id, 'external_source', m.external_source,
    'first_name', m.first_name, 'last_name', m.last_name, 'name', m.name,
    'title', m.title, 'company', m.company, 'company_domain', m.company_domain,
    'email', m.email, 'email_status', m.email_status,
    'phone', m.phone, 'phone_status', m.phone_status,
    'linkedin_url', m.linkedin_url,
    'city', m.city, 'state', m.state, 'country', m.country,
    'contact_status', m.contact_status, 'status_changed_at', m.status_changed_at,
    'enriched_at', m.enriched_at, 'created_at', m.created_at, 'updated_at', m.updated_at,
    'company_id', m.company_id
  );
$$;

REVOKE ALL ON FUNCTION public.api_contact_json(public.prospect_list_members) FROM PUBLIC, anon;
