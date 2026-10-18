-- ═══════════════════════════════════════════════════════════════════════════
-- Inbound: widget web (formulario + botón de WhatsApp), enrutamiento y
-- speed-to-lead — 2026-10-17 (docs/ROADMAP_GTM_OS.md §4, fila «Inbound»)
--
-- En Latam el inbound B2B llega por WhatsApp más que por formulario. El
-- cliente pega un <script> en su sitio (widget/inbound.js) que muestra un
-- botón de WhatsApp y/o un formulario corto. Lo que se envía entra por la
-- edge function pública `inbound-capture` (clave pública por sitio, rate
-- limit, honeypot, tiempo mínimo de llenado) y termina como un lead de una
-- lista «Inbound» del SDR al que lo asignan las reglas del sitio.
--
--   • inbound_sites — un sitio/widget por fila. CLIENT-WRITABLE por su dueño
--     (RLS). `site_key` es pública por diseño (va en el HTML del cliente) y
--     no se puede cambiar desde el navegador. El trigger valida el
--     enrutamiento: solo un admin/director reparte a otros, y solo a cuentas
--     de su misma empresa (profiles.company_name, la misma regla de equipos
--     de profiles_admin_select_company).
--   • inbound_leads — cada envío. Solo la service role inserta. La leen el
--     dueño del sitio (ve a todo su equipo: métricas por SDR) y el SDR
--     asignado. Se actualiza solo por la RPC inbound_lead_mark().
--   • inbound_hits — registro para el rate limit y las estadísticas (envíos,
--     clics de WhatsApp, bloqueados). Sin grants: solo la service role.
--
-- Speed-to-lead: el trigger de inbox_messages sella first_contact_at con el
-- PRIMER mensaje saliente (Bandeja o campaña, cualquier canal) al lead. La
-- respuesta automática del sitio (payload.source = 'inbound_auto_reply') no
-- cuenta: es la máquina, no el SDR. El SDR también puede marcarlo a mano
-- («Lo llamé») con inbound_lead_mark(…, 'contacted', 'phone').
--
-- prospect_list_members.source para estos leads:
--   {kind: 'inbound', site_id, inbound_lead_id, page_url, utm}
--
-- Idempotente (seguro de re-aplicar).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Sitios ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.inbound_sites (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name                 TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  site_key             TEXT        NOT NULL UNIQUE
                       DEFAULT ('pis_' || replace(gen_random_uuid()::text, '-', '')),
  enabled              BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Dominios desde los que el widget puede enviar (sufijo: "acme.com" acepta
  -- www.acme.com). Vacío = cualquiera (la UI lo advierte).
  allowed_domains      TEXT[]      NOT NULL DEFAULT '{}',
  -- Apariencia y campos del widget (normalizeSiteConfig en _shared/inbound.ts
  -- es la única lectura: el navegador escribe, el servidor nunca confía).
  config               JSONB       NOT NULL DEFAULT '{}',
  -- Aviso de privacidad y texto de consentimiento que ve el visitante.
  privacy_notice       TEXT        CHECK (char_length(privacy_notice) <= 6000),
  privacy_url          TEXT        CHECK (privacy_url IS NULL OR privacy_url ~ '^https?://'),
  consent_text         TEXT        CHECK (char_length(consent_text) <= 600),
  -- Enrutamiento: {mode: 'owner'|'round_robin', pool: [uuid], rules: [
  --   {field: 'country'|'size', values: [...], assignee: uuid}]}
  routing              JSONB       NOT NULL DEFAULT '{"mode":"owner"}',
  rr_cursor            INTEGER     NOT NULL DEFAULT 0,
  list_name            TEXT        NOT NULL DEFAULT 'Inbound' CHECK (char_length(list_name) BETWEEN 1 AND 120),
  -- Automático al llegar (opcional, con créditos del SDR asignado).
  auto_enrich          BOOLEAN     NOT NULL DEFAULT FALSE,
  auto_research        BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Plantilla aprobada de WhatsApp que sale al instante (vacía = no se manda).
  auto_reply_template  TEXT        CHECK (char_length(auto_reply_template) <= 512),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS inbound_sites_user_idx ON public.inbound_sites (user_id);

DROP TRIGGER IF EXISTS inbound_sites_updated_at ON public.inbound_sites;
CREATE TRIGGER inbound_sites_updated_at
  BEFORE UPDATE ON public.inbound_sites
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ¿p_member es del equipo de p_owner? (misma empresa, no nula) — o él mismo.
CREATE OR REPLACE FUNCTION public.inbound_is_teammate(p_owner UUID, p_member UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_owner = p_member OR EXISTS (
    SELECT 1
      FROM public.profiles o
      JOIN public.profiles m ON m.id = p_member
     WHERE o.id = p_owner
       AND o.company_name IS NOT NULL
       AND btrim(o.company_name) <> ''
       AND m.company_name = o.company_name
  );
$$;

REVOKE ALL ON FUNCTION public.inbound_is_teammate(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inbound_is_teammate(UUID, UUID) TO service_role;

-- Valida lo que el navegador escribe: clave inmutable, dueño fijo y
-- enrutamiento solo hacia el propio equipo.
CREATE OR REPLACE FUNCTION public.inbound_sites_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   TEXT;
  v_uid    UUID;
  v_ids    UUID[] := '{}';
  v_rule   JSONB;
BEGIN
  -- Service role, SQL manual e inbound_next_cursor (que solo avanza el turno
  -- del round robin): sin cambios. inbound-capture revalida el equipo en cada
  -- envío con inbound_is_teammate.
  IF auth.uid() IS NULL OR coalesce(current_setting('inbound.advancing_cursor', true), '') = '1' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.site_key  := OLD.site_key;
    NEW.user_id   := OLD.user_id;
    NEW.rr_cursor := OLD.rr_cursor;
  ELSE
    NEW.site_key  := 'pis_' || replace(gen_random_uuid()::text, '-', '');
    NEW.rr_cursor := 0;
  END IF;

  IF jsonb_typeof(NEW.routing) <> 'object' THEN
    NEW.routing := '{"mode":"owner"}';
  END IF;

  -- Todos los user_id que nombra el enrutamiento.
  IF jsonb_typeof(NEW.routing->'pool') = 'array' THEN
    SELECT coalesce(array_agg(x::uuid), '{}') INTO v_ids
      FROM jsonb_array_elements_text(NEW.routing->'pool') x
     WHERE x ~* '^[0-9a-f-]{36}$';
  END IF;
  IF jsonb_typeof(NEW.routing->'rules') = 'array' THEN
    FOR v_rule IN SELECT * FROM jsonb_array_elements(NEW.routing->'rules') LOOP
      IF coalesce(v_rule->>'assignee', '') ~* '^[0-9a-f-]{36}$' THEN
        v_ids := v_ids || (v_rule->>'assignee')::uuid;
      END IF;
    END LOOP;
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(v_ids) u WHERE u <> NEW.user_id) THEN
    SELECT lower(coalesce(role, '')) INTO v_role FROM public.profiles WHERE id = NEW.user_id;
    IF v_role NOT IN ('admin', 'director') THEN
      RAISE EXCEPTION 'Solo un administrador o director puede repartir leads a su equipo.'
        USING ERRCODE = '42501';
    END IF;
    FOREACH v_uid IN ARRAY v_ids LOOP
      IF NOT public.inbound_is_teammate(NEW.user_id, v_uid) THEN
        RAISE EXCEPTION 'Solo puedes asignar leads a personas de tu equipo (misma empresa en su perfil).'
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.inbound_sites_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS inbound_sites_guard ON public.inbound_sites;
CREATE TRIGGER inbound_sites_guard
  BEFORE INSERT OR UPDATE ON public.inbound_sites
  FOR EACH ROW EXECUTE FUNCTION public.inbound_sites_guard();

ALTER TABLE public.inbound_sites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbound_sites FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbound_sites TO authenticated;

DROP POLICY IF EXISTS "Users manage own inbound sites" ON public.inbound_sites;
CREATE POLICY "Users manage own inbound sites"
  ON public.inbound_sites FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── 2. Leads inbound ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.inbound_leads (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id                UUID        NOT NULL REFERENCES public.inbound_sites(id) ON DELETE CASCADE,
  owner_id               UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assignee_id            UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_id              UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  list_id                UUID        REFERENCES public.prospect_lists(id) ON DELETE SET NULL,
  kind                   TEXT        NOT NULL DEFAULT 'form' CHECK (kind IN ('form', 'whatsapp')),
  name                   TEXT,
  email                  TEXT,
  phone                  TEXT,
  company                TEXT,
  title                  TEXT,
  country                TEXT,
  company_size           TEXT,
  message                TEXT,
  page_url               TEXT,
  referrer               TEXT,
  utm                    JSONB       NOT NULL DEFAULT '{}',
  -- {given, text, text_sha256, privacy_url, at, ip_sha256, user_agent}
  consent                JSONB       NOT NULL DEFAULT '{}',
  -- Calificación determinista contra el ICP declarado: {score, label, reasons}
  fit                    JSONB       NOT NULL DEFAULT '{}',
  routing_reason         TEXT,
  status                 TEXT        NOT NULL DEFAULT 'new'
                         CHECK (status IN ('new', 'contacted', 'qualified', 'disqualified', 'spam')),
  first_contact_at       TIMESTAMPTZ,
  first_contact_channel  TEXT,
  first_contact_by       UUID,
  -- {status: sent|skipped|failed, template, detail, at}
  auto_reply             JSONB       NOT NULL DEFAULT '{}',
  submissions            INTEGER     NOT NULL DEFAULT 1,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS inbound_leads_owner_idx    ON public.inbound_leads (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inbound_leads_assignee_idx ON public.inbound_leads (assignee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inbound_leads_member_idx   ON public.inbound_leads (member_id) WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbound_leads_dedupe_idx   ON public.inbound_leads (site_id, created_at DESC);

DROP TRIGGER IF EXISTS inbound_leads_updated_at ON public.inbound_leads;
CREATE TRIGGER inbound_leads_updated_at
  BEFORE UPDATE ON public.inbound_leads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.inbound_leads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbound_leads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.inbound_leads TO authenticated;

DROP POLICY IF EXISTS "Owner and assignee read inbound leads" ON public.inbound_leads;
CREATE POLICY "Owner and assignee read inbound leads"
  ON public.inbound_leads FOR SELECT
  TO authenticated
  USING (auth.uid() = owner_id OR auth.uid() = assignee_id);

-- Estado y primer contacto manual: el SDR asignado o el dueño del sitio.
CREATE OR REPLACE FUNCTION public.inbound_lead_mark(
  p_id      UUID,
  p_status  TEXT,
  p_channel TEXT DEFAULT NULL
)
RETURNS public.inbound_leads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_row public.inbound_leads;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('new', 'contacted', 'qualified', 'disqualified', 'spam') THEN
    RAISE EXCEPTION 'estado inválido' USING ERRCODE = '22023';
  END IF;
  IF p_channel IS NOT NULL AND p_channel NOT IN ('phone', 'whatsapp', 'email', 'linkedin', 'other') THEN
    RAISE EXCEPTION 'canal inválido' USING ERRCODE = '22023';
  END IF;

  UPDATE public.inbound_leads l
     SET status = p_status,
         first_contact_at      = CASE WHEN p_status = 'contacted' AND l.first_contact_at IS NULL THEN NOW() ELSE l.first_contact_at END,
         first_contact_channel = CASE WHEN p_status = 'contacted' AND l.first_contact_at IS NULL THEN coalesce(p_channel, 'other') ELSE l.first_contact_channel END,
         first_contact_by      = CASE WHEN p_status = 'contacted' AND l.first_contact_at IS NULL THEN v_uid ELSE l.first_contact_by END
   WHERE l.id = p_id
     AND (l.assignee_id = v_uid OR l.owner_id = v_uid)
  RETURNING l.* INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'lead no encontrado' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.inbound_lead_mark(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbound_lead_mark(UUID, TEXT, TEXT) TO authenticated;

-- Round robin atómico: dos envíos simultáneos no caen en el mismo SDR.
CREATE OR REPLACE FUNCTION public.inbound_next_cursor(p_site_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cursor INTEGER;
BEGIN
  PERFORM set_config('inbound.advancing_cursor', '1', true);
  UPDATE public.inbound_sites SET rr_cursor = rr_cursor + 1
   WHERE id = p_site_id
  RETURNING rr_cursor - 1 INTO v_cursor;
  PERFORM set_config('inbound.advancing_cursor', '', true);
  RETURN v_cursor;
END;
$$;

REVOKE ALL ON FUNCTION public.inbound_next_cursor(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inbound_next_cursor(UUID) TO service_role;

-- ── 3. Registro de envíos (rate limit + estadísticas) ───────────────────────

CREATE TABLE IF NOT EXISTS public.inbound_hits (
  id         BIGSERIAL   PRIMARY KEY,
  site_id    UUID        NOT NULL REFERENCES public.inbound_sites(id) ON DELETE CASCADE,
  ip_hash    TEXT,
  kind       TEXT        NOT NULL CHECK (kind IN ('submit', 'whatsapp_click', 'blocked')),
  reason     TEXT,
  page_url   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS inbound_hits_site_idx ON public.inbound_hits (site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inbound_hits_ip_idx   ON public.inbound_hits (site_id, ip_hash, created_at DESC);

ALTER TABLE public.inbound_hits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbound_hits FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.inbound_hits_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.inbound_hits TO authenticated;

DROP POLICY IF EXISTS "Site owner reads hits" ON public.inbound_hits;
CREATE POLICY "Site owner reads hits"
  ON public.inbound_hits FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.inbound_sites s WHERE s.id = site_id AND s.user_id = auth.uid()));

-- ── 4. Speed-to-lead: primer saliente → first_contact_at ────────────────────

CREATE OR REPLACE FUNCTION public.inbound_on_outbound_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.direction <> 'out'
     OR NEW.member_id IS NULL
     OR NEW.status = 'failed'
     OR coalesce(NEW.payload->>'source', '') = 'inbound_auto_reply' THEN
    RETURN NULL;
  END IF;

  UPDATE public.inbound_leads l
     SET first_contact_at      = NEW.sent_at,
         first_contact_channel = NEW.channel,
         first_contact_by      = NEW.user_id,
         status                = CASE WHEN l.status = 'new' THEN 'contacted' ELSE l.status END
   WHERE l.member_id = NEW.member_id
     AND l.first_contact_at IS NULL
     AND NEW.sent_at >= l.created_at;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'inbound_on_outbound_message: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.inbound_on_outbound_message() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS inbound_on_outbound_message ON public.inbox_messages;
CREATE TRIGGER inbound_on_outbound_message
  AFTER INSERT ON public.inbox_messages
  FOR EACH ROW EXECUTE FUNCTION public.inbound_on_outbound_message();

-- ── 5. Realtime: el cronómetro de la Bandeja aparece al instante ────────────

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.inbound_leads;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.prospect_list_members.source IS
  'Qué encontró al lead: {kind: search|radar|manual|import|inbox|inbound, detector_id?, signal_id?, saved_search_id?, site_id?, inbound_lead_id?, page_url?, utm?}. Lo usa learning-loop para atribuir respuestas y reuniones.';
