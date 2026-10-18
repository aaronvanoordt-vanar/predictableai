-- Seguimiento de champions (2026-10-17, docs/ROADMAP_GTM_OS.md §4).
--
-- Cuando alguien que ya te compró o te respondió bien cambia de empresa, es
-- la reunión más cálida que existe. Esta migración agrega:
--
--   • champion_watch — la lista de seguimiento: contactos marcados como
--     champion (a mano desde Listas o el Radar, o sugeridos cuando un lead
--     tiene una reunión) y contactos de los clientes actuales que
--     el usuario carga. Cada fila guarda su propia copia de la persona (el
--     lead de la lista se puede borrar) y la EMPRESA BASE contra la que se
--     verifica: si Apollo dice que ya no está ahí, el código (nunca el modelo
--     solo, _shared/champion-watch.ts) decide «Verificado / Cambió / Se fue /
--     Por confirmar / Sin verificar».
--   • el tipo de detector `champion_moves` del Radar: el motor (radar-monitor)
--     chequea las filas vencidas con Apollo /people/match (y búsqueda web de
--     respaldo) y deja la señal «Tu champion se mudó a X».
--   • triggers que SUGIEREN champions (state = 'suggested'; el usuario los
--     acepta con un clic): un lead que pasa a reunion_agendada /
--     reunion_tomada, y una reunión del Meeting Coach con resultado ganado o
--     seguimiento. Una sugerencia que el lead pasa a no_interesado o
--     dado_de_baja se retira. Nunca rompen la escritura que los dispara.
--
-- Escribe: el cliente solo la identidad, el estado y la nota (grants de
-- columna); el veredicto y el historial los escribe solo la service role.

-- ── 1. tipo de detector ─────────────────────────────────────────────────────
-- Reemplaza el CHECK de 20261017000031_public_registries.sql: la lista incluye
-- su 'public_registry' para no borrarlo al aplicarse después.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.radar_detectors'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%kind%website_visitors%'
  LOOP
    EXECUTE format('ALTER TABLE public.radar_detectors DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.radar_detectors
  ADD CONSTRAINT radar_detectors_kind_check
  CHECK (kind IN ('news', 'hiring', 'technographics', 'site_probe', 'funding',
                  'leadership', 'growth', 'tenders', 'presence', 'website_visitors',
                  'web_footprint', 'public_registry', 'champion_moves'));

-- ── 2. lista de seguimiento ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.champion_watch (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_id         UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  -- manual | customer | meeting | qualified_meeting (solo con reunión:
  -- una respuesta sola no basta para sugerir un champion, decisión del dueño)
  origin            TEXT        NOT NULL DEFAULT 'manual'
                    CHECK (origin IN ('manual', 'customer', 'meeting', 'qualified_meeting')),
  -- suggested (lo propuso el sistema) | active (se chequea) | dismissed
  state             TEXT        NOT NULL DEFAULT 'active'
                    CHECK (state IN ('suggested', 'active', 'dismissed')),
  name              TEXT,
  first_name        TEXT,
  last_name         TEXT,
  title             TEXT,
  -- Empresa BASE: donde trabaja según lo último que verificamos.
  company           TEXT,
  company_domain    TEXT,
  linkedin_url      TEXT,
  email             TEXT,
  apollo_person_id  TEXT,
  -- Cliente actual al que pertenece (current_customers[].name), si aplica.
  customer_name     TEXT,
  note              TEXT        CHECK (note IS NULL OR char_length(note) <= 2000),
  -- Lo escribe el motor:
  -- pending | current | moved | left | unconfirmed | unknown
  employment_status TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (employment_status IN ('pending', 'current', 'moved', 'left', 'unconfirmed', 'unknown')),
  employment        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Último cambio de empresa detectado: {from_company, from_title, to_company,
  -- to_title, to_domain, since, detected_at}.
  last_move         JSONB,
  moved_at          TIMESTAMPTZ,
  last_checked_at   TIMESTAMPTZ,
  next_check_at     TIMESTAMPTZ,
  check_count       INT         NOT NULL DEFAULT 0,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (coalesce(nullif(trim(name), ''), nullif(trim(first_name), '')) IS NOT NULL)
);

-- Un lead de lista se sigue una sola vez; la misma persona de Apollo, también.
CREATE UNIQUE INDEX IF NOT EXISTS champion_watch_member_key
  ON public.champion_watch (user_id, member_id) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS champion_watch_person_key
  ON public.champion_watch (user_id, apollo_person_id) WHERE apollo_person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS champion_watch_due_idx
  ON public.champion_watch (user_id, state, next_check_at);

DROP TRIGGER IF EXISTS champion_watch_updated_at ON public.champion_watch;
CREATE TRIGGER champion_watch_updated_at
  BEFORE UPDATE ON public.champion_watch
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.champion_watch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.champion_watch FROM anon, PUBLIC;

DROP POLICY IF EXISTS "champion_watch_select_own" ON public.champion_watch;
CREATE POLICY "champion_watch_select_own" ON public.champion_watch
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "champion_watch_insert_own" ON public.champion_watch;
CREATE POLICY "champion_watch_insert_own" ON public.champion_watch
  FOR INSERT TO authenticated WITH CHECK (
    auth.uid() = user_id
    AND (member_id IS NULL OR EXISTS (
      SELECT 1 FROM public.prospect_list_members m WHERE m.id = member_id AND m.user_id = auth.uid()))
  );
DROP POLICY IF EXISTS "champion_watch_update_own" ON public.champion_watch;
CREATE POLICY "champion_watch_update_own" ON public.champion_watch
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "champion_watch_delete_own" ON public.champion_watch;
CREATE POLICY "champion_watch_delete_own" ON public.champion_watch
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE ON public.champion_watch FROM authenticated;
GRANT SELECT, DELETE ON public.champion_watch TO authenticated;
GRANT INSERT (user_id, member_id, origin, state, name, first_name, last_name, title, company,
              company_domain, linkedin_url, email, apollo_person_id, customer_name, note)
  ON public.champion_watch TO authenticated;
-- Corregir la empresa base reinicia la verificación (next_check_at) para que
-- el motor la vuelva a chequear contra el dato corregido.
GRANT UPDATE (state, name, title, company, company_domain, linkedin_url, email, customer_name, note, next_check_at)
  ON public.champion_watch TO authenticated;

COMMENT ON TABLE public.champion_watch IS
  'Seguimiento de champions: contactos cuyo cambio de empresa es una señal del Radar (detector champion_moves). El veredicto lo escribe radar-monitor con _shared/champion-watch.ts.';

-- ── 3. sugerencias automáticas ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.champion_suggest_from_member(p_member_id UUID, p_origin TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m public.prospect_list_members%ROWTYPE;
BEGIN
  SELECT * INTO m FROM public.prospect_list_members WHERE id = p_member_id;
  IF NOT FOUND OR m.user_id IS NULL THEN RETURN; END IF;
  IF coalesce(nullif(trim(m.name), ''), nullif(trim(m.first_name), '')) IS NULL THEN RETURN; END IF;
  IF coalesce(nullif(trim(m.company), ''), nullif(trim(m.company_domain), '')) IS NULL THEN RETURN; END IF;

  -- Una sugerencia pendiente sube de categoría (reunión → calificada).
  UPDATE public.champion_watch w SET origin = p_origin
   WHERE w.user_id = m.user_id AND w.member_id = m.id AND w.state = 'suggested'
     AND array_position(ARRAY['meeting', 'qualified_meeting'], p_origin)
       > coalesce(array_position(ARRAY['meeting', 'qualified_meeting'], w.origin), 0);
  IF FOUND THEN RETURN; END IF;

  INSERT INTO public.champion_watch
    (user_id, member_id, origin, state, name, first_name, last_name, title, company,
     company_domain, linkedin_url, email, apollo_person_id)
  VALUES
    (m.user_id, m.id, p_origin, 'suggested', m.name, m.first_name, m.last_name, m.title, m.company,
     m.company_domain, m.linkedin_url, m.email, m.apollo_person_id)
  ON CONFLICT DO NOTHING;
END $$;
REVOKE EXECUTE ON FUNCTION public.champion_suggest_from_member(UUID, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.champion_suggest_on_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    IF NEW.contact_status IS DISTINCT FROM OLD.contact_status THEN
      IF NEW.contact_status IN ('reunion_agendada', 'reunion_tomada') THEN
        PERFORM public.champion_suggest_from_member(NEW.id, 'meeting');
      ELSIF NEW.contact_status IN ('no_interesado', 'dado_de_baja') THEN
        DELETE FROM public.champion_watch
         WHERE user_id = NEW.user_id AND member_id = NEW.id AND state = 'suggested';
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'champion_suggest_on_status: %', SQLERRM;
  END;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.champion_suggest_on_status() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS champion_suggest_on_status ON public.prospect_list_members;
CREATE TRIGGER champion_suggest_on_status
  AFTER UPDATE OF contact_status ON public.prospect_list_members
  FOR EACH ROW EXECUTE FUNCTION public.champion_suggest_on_status();

CREATE OR REPLACE FUNCTION public.champion_suggest_on_meeting()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    IF NEW.outcome IN ('ganado', 'seguimiento')
       AND NEW.outcome IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.outcome ELSE NULL END)
       AND NEW.prospect_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      -- Solo leads del mismo dueño de la reunión.
      IF EXISTS (SELECT 1 FROM public.prospect_list_members m
                  WHERE m.id = NEW.prospect_id::uuid AND m.user_id = NEW.user_id) THEN
        PERFORM public.champion_suggest_from_member(NEW.prospect_id::uuid, 'qualified_meeting');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'champion_suggest_on_meeting: %', SQLERRM;
  END;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.champion_suggest_on_meeting() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS champion_suggest_on_meeting ON public.coach_meetings;
CREATE TRIGGER champion_suggest_on_meeting
  AFTER INSERT OR UPDATE OF outcome ON public.coach_meetings
  FOR EACH ROW EXECUTE FUNCTION public.champion_suggest_on_meeting();

-- ── 4. sugerencias iniciales: los leads que ya tuvieron reunión ─────────────
-- (una respuesta sin reunión no se sugiere: se marca a mano con la estrella).

INSERT INTO public.champion_watch
  (user_id, member_id, origin, state, name, first_name, last_name, title, company,
   company_domain, linkedin_url, email, apollo_person_id)
SELECT m.user_id, m.id, 'meeting', 'suggested', m.name, m.first_name, m.last_name, m.title, m.company,
       m.company_domain, m.linkedin_url, m.email, m.apollo_person_id
  FROM public.prospect_list_members m
 WHERE m.user_id IS NOT NULL
   AND m.contact_status IN ('reunion_agendada', 'reunion_tomada')
   AND coalesce(nullif(trim(m.name), ''), nullif(trim(m.first_name), '')) IS NOT NULL
   AND coalesce(nullif(trim(m.company), ''), nullif(trim(m.company_domain), '')) IS NOT NULL
ON CONFLICT DO NOTHING;
