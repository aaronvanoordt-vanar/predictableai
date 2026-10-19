-- Agendamiento propio con recordatorios por WhatsApp (2026-10-17).
-- Hoja de ruta GTM OS, P2 «Agendamiento con recordatorios por WhatsApp».
--
--   • booking_pages  — la agenda pública de cada usuario (tipo Calendly):
--                      slug, tipos de reunión, disponibilidad semanal, preguntas
--                      de calificación y recordatorios. Una por usuario. Solo la
--                      escribe la edge function `booking` (valida y sanea); el
--                      dueño la lee con su JWT.
--   • bookings       — cada reunión agendada desde esa página: invitado, horario,
--                      evento de Google Calendar, estado de confirmación
--                      (pending / confirmed / rescheduled / reschedule_requested
--                      / no_response), asistencia real (pending / held /
--                      no_show), recordatorios enviados y la nota BANT del
--                      traspaso al AE. Solo la escribe `booking` (service role);
--                      el dueño la lee.
--   • prospect_list_members.booking_ref     — referencia opaca por lead para
--                      {{link_agenda}}: el enlace de la campaña o de la Bandeja
--                      dice a QUÉ lead atribuir la reunión sin exponer su id.
--   • prospect_list_members.meeting_handoff — la última nota BANT del lead
--                      (copia de bookings.handoff) para «Preparar con IA» del
--                      Meeting Coach y generate-outreach.
--   • learning_insights.scope 'meeting_attendance' — asistencia real por
--                      confirmación, recordatorio y origen (learning-loop).
--   • integration_connections.provider 'outlook_calendar' — Outlook / Microsoft
--                      365 por Microsoft Graph (Integraciones y la agenda).
--
-- La página pública (agenda.html) NO lee estas tablas: todo pasa por la edge
-- function `booking` (desplegada con --no-verify-jwt), que solo devuelve lo
-- público (nombre, tipos, preguntas, horarios libres). anon no tiene permisos.

-- ── booking_pages ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.booking_pages (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  slug          TEXT        NOT NULL UNIQUE
                CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,40}$'),
  enabled       BOOLEAN     NOT NULL DEFAULT FALSE,
  title         TEXT        NOT NULL DEFAULT '',
  intro         TEXT        NOT NULL DEFAULT '',
  timezone      TEXT        NOT NULL DEFAULT 'America/Lima',
  -- De qué calendario sale la disponibilidad y dónde se crea la reunión.
  calendar_provider TEXT    NOT NULL DEFAULT 'google' CHECK (calendar_provider IN ('google', 'outlook')),
  meeting_types JSONB       NOT NULL DEFAULT '[]'::jsonb,
  availability  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  questions     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  reminders     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.booking_pages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_pages FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.booking_pages FROM authenticated;
GRANT SELECT ON public.booking_pages TO authenticated;

DROP POLICY IF EXISTS booking_pages_owner_select ON public.booking_pages;
CREATE POLICY booking_pages_owner_select ON public.booking_pages
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- ── bookings ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bookings (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_id             UUID        REFERENCES public.booking_pages(id) ON DELETE SET NULL,
  meeting_type_id     TEXT,
  meeting_type_name   TEXT,
  duration_min        INTEGER     NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  member_id           UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  guest_name          TEXT        NOT NULL,
  guest_email         TEXT        NOT NULL,
  guest_phone         TEXT,
  guest_company       TEXT,
  guest_timezone      TEXT,
  answers             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  start_at            TIMESTAMPTZ NOT NULL,
  end_at              TIMESTAMPTZ NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  confirmation        TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (confirmation IN ('pending', 'confirmed', 'rescheduled', 'reschedule_requested', 'no_response')),
  attendance          TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (attendance IN ('pending', 'held', 'no_show')),
  attendance_source   TEXT,       -- 'manual' (botón) | 'coach' (al cerrar la reunión en el Meeting Coach)
  attendance_marked_at TIMESTAMPTZ,
  confirmed_at        TIMESTAMPTZ,
  reschedule_count    INTEGER     NOT NULL DEFAULT 0,
  rescheduled_at      TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       TEXT,
  calendar_provider   TEXT        NOT NULL DEFAULT 'google' CHECK (calendar_provider IN ('google', 'outlook')),
  calendar_event_id   TEXT,
  calendar_html_link  TEXT,
  meeting_url         TEXT,
  manage_token        TEXT        NOT NULL UNIQUE,
  reminders           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  handoff             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  handoff_status      TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (handoff_status IN ('pending', 'generating', 'ready', 'skipped', 'error')),
  handoff_error       TEXT,
  source              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_at > start_at)
);

CREATE INDEX IF NOT EXISTS bookings_user_start_idx ON public.bookings (user_id, start_at DESC);
CREATE INDEX IF NOT EXISTS bookings_member_idx ON public.bookings (member_id) WHERE member_id IS NOT NULL;
-- El pase de recordatorios solo mira reuniones vivas que todavía no empiezan.
CREATE INDEX IF NOT EXISTS bookings_upcoming_idx ON public.bookings (start_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS bookings_guest_phone_idx ON public.bookings (user_id, guest_phone) WHERE status = 'scheduled';

ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bookings FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.bookings FROM authenticated;
-- El token de gestión del invitado no se le muestra al navegador del dueño.
REVOKE SELECT ON public.bookings FROM authenticated;
GRANT SELECT (id, user_id, page_id, meeting_type_id, meeting_type_name, duration_min, member_id,
              guest_name, guest_email, guest_phone, guest_company, guest_timezone, answers,
              start_at, end_at, status, confirmation, attendance, attendance_source, attendance_marked_at,
              confirmed_at, reschedule_count, rescheduled_at, cancelled_at, cancel_reason,
              calendar_provider, calendar_event_id, calendar_html_link, meeting_url, reminders,
              handoff, handoff_status, handoff_error, source, created_at, updated_at)
  ON public.bookings TO authenticated;

DROP POLICY IF EXISTS bookings_owner_select ON public.bookings;
CREATE POLICY bookings_owner_select ON public.bookings
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- ── prospect_list_members ────────────────────────────────────────────────
-- Referencia opaca para {{link_agenda}}. DEFAULT volátil: Postgres le da un
-- valor distinto a cada fila existente al agregar la columna.
ALTER TABLE public.prospect_list_members
  ADD COLUMN IF NOT EXISTS booking_ref TEXT NOT NULL DEFAULT substr(md5(gen_random_uuid()::text), 1, 16),
  ADD COLUMN IF NOT EXISTS meeting_handoff JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS prospect_list_members_booking_ref_idx
  ON public.prospect_list_members (booking_ref);

COMMENT ON COLUMN public.prospect_list_members.booking_ref IS
  'Referencia opaca del lead en {{link_agenda}} (agenda.html?u=<slug>&r=<booking_ref>). La edge function booking atribuye la reunión con ella.';
COMMENT ON COLUMN public.prospect_list_members.meeting_handoff IS
  'Última nota BANT del traspaso al AE (copia de bookings.handoff). La leen Preparar con IA del Meeting Coach y generate-outreach.';

-- ── CHECKs compartidos: se SUMAN valores, nunca se reemplaza la lista ─────
-- Varias sesiones agregan valores a estos CHECK en paralelo (el CRM agregó
-- 'deal_loss'; otras integraciones agregan proveedores). Se leen los valores
-- que el CHECK ya permite y se suman los nuestros: así no se borra lo de otra
-- migración aplicada antes o después. Idempotente.
--   • learning_insights.scope: 'meeting_attendance' (asistencia real) y
--     'automation_rule' (lo escribe learning-loop desde #362 y ninguna
--     migración lo permitía: el upsert por usuario fallaba entero para quien
--     tuviera reglas).
--   • integration_connections.provider: 'outlook_calendar' (Microsoft Graph).
DO $$
DECLARE
  spec RECORD;
  c    RECORD;
  vals TEXT[];
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('public.learning_insights'::regclass, 'scope', 'learning_insights_scope_check',
       ARRAY['radar_detector', 'campaign_node', 'campaign', 'channel', 'angle', 'winning_message',
             'objection', 'icp_attribute', 'summary', 'deal_loss', 'automation_rule', 'meeting_attendance']),
      ('public.integration_connections'::regclass, 'provider', 'integration_connections_provider_check',
       ARRAY['hubspot', 'salesforce', 'amplemarket', 'google_sheets', 'google_calendar',
             'outlook_calendar', 'notion', 'clickup'])
    ) AS t(tbl, col, conname, add_vals)
  LOOP
    vals := spec.add_vals;
    -- Todos los CHECK sobre esa columna (el inline de la tabla no tiene nombre fijo).
    FOR c IN SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS def
               FROM pg_constraint con
              WHERE con.conrelid = spec.tbl AND con.contype = 'c'
                AND pg_get_constraintdef(con.oid) ~ ('\m' || spec.col || '\M')
    LOOP
      vals := vals || ARRAY(SELECT (regexp_matches(c.def, '''([^'']+)''', 'g'))[1]);
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', spec.tbl, c.name);
    END LOOP;
    vals := ARRAY(SELECT DISTINCT v FROM unnest(vals) AS v ORDER BY 1);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I IN (%s))', spec.tbl, spec.conname, spec.col,
      (SELECT string_agg(quote_literal(x), ', ') FROM unnest(vals) AS x));
  END LOOP;
END $$;

-- ── Cron de recordatorios (cada 5 minutos, con la service role) ──────────
-- SELECT cron.schedule('booking-reminders', '*/5 * * * *', $cron$
--   SELECT net.http_post(
--     url     := 'https://<project-ref>.supabase.co/functions/v1/booking',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'),
--     body    := '{"action":"tick"}'::jsonb,
--     timeout_milliseconds := 120000);
-- $cron$);
