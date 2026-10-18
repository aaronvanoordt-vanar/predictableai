-- ─────────────────────────────────────────────────────────────────────────────
-- Calidad de reunión en el portal, reporte semanal al cliente, benchmarks por
-- país e industria y plantillas de campaña de Eleva (2026-10-17).
-- docs/ROADMAP_GTM_OS.md §4, filas Agencia.
--
-- 1. lead_meetings: una fila por lead que llegó a reunión. La siembra un
--    trigger cuando prospect_list_members.contact_status pasa a
--    reunion_agendada / reunion_tomada / no_show (el CRM, la Bandeja, el
--    Meeting Coach al cerrar o la API pública: todos escriben ese estado).
--    El cliente final la califica desde el portal (edge function
--    client-portal, acción rate_meeting): se dio / no se presentó /
--    calificada / no calificada + motivo corto. Solo la service role escribe
--    el veredicto; el equipo lo lee (detalle del lead) y learning-loop lo usa
--    como resultado works/fails por canal, ángulo y atributos del ICP.
-- 2. client_weekly_reports: el resumen de la semana de cada cliente con
--    espacio (edge function client-report, cron semanal). Se ve en el portal
--    y se manda por email si hay un canal de envío configurado.
-- 3. Benchmarks: benchmark_cells (agregados anónimos de la plataforma y del
--    histórico importado) los llena refresh_benchmarks(); NADIE los lee
--    directo: la edge function benchmarks aplica el volumen mínimo por celda
--    antes de devolver una tasa. benchmark_history_* guarda el histórico que
--    el dueño importe por CSV (esquema en docs/BENCHMARKS.md). Nace vacío.
-- 4. campaign_templates: plantillas de campaña de Eleva por vertical y país
--    para el asistente de campañas. Nace vacía: las carga el dueño.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Reuniones y su calidad ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lead_meetings (
  member_id       uuid PRIMARY KEY REFERENCES public.prospect_list_members(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  booked_at       timestamptz,
  held_at         timestamptz,
  client_verdict  text CHECK (client_verdict IN ('held', 'no_show', 'qualified', 'not_qualified')),
  client_reason   text CHECK (client_reason IS NULL OR char_length(client_reason) <= 280),
  verdict_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_meetings_user_idx ON public.lead_meetings (user_id, booked_at DESC);
CREATE INDEX IF NOT EXISTS lead_meetings_verdict_idx ON public.lead_meetings (user_id, verdict_at DESC) WHERE client_verdict IS NOT NULL;

ALTER TABLE public.lead_meetings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_meetings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.lead_meetings TO authenticated;

-- El dueño del lead (la cuenta del espacio) y el equipo que gestiona ese
-- cliente leen; nadie escribe desde el navegador.
DROP POLICY IF EXISTS lead_meetings_select ON public.lead_meetings;
CREATE POLICY lead_meetings_select ON public.lead_meetings
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.client_workspaces w
       WHERE w.workspace_user_id = lead_meetings.user_id
         AND public.can_manage_client(w.client_id)
    )
  );

-- El trigger nunca rompe la escritura del CRM: si algo falla, avisa y sigue.
CREATE OR REPLACE FUNCTION public.track_lead_meeting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.contact_status IS NULL OR NEW.contact_status NOT IN ('reunion_agendada', 'reunion_tomada', 'no_show') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.contact_status IS NOT DISTINCT FROM OLD.contact_status THEN
    RETURN NEW;
  END IF;
  BEGIN
    INSERT INTO public.lead_meetings (member_id, user_id, booked_at, held_at)
    VALUES (NEW.id, NEW.user_id, now(), CASE WHEN NEW.contact_status = 'reunion_tomada' THEN now() END)
    ON CONFLICT (member_id) DO UPDATE
      SET held_at    = COALESCE(public.lead_meetings.held_at, EXCLUDED.held_at),
          booked_at  = COALESCE(public.lead_meetings.booked_at, EXCLUDED.booked_at),
          updated_at = now();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[track_lead_meeting] %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.track_lead_meeting() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS prospect_list_members_track_meeting ON public.prospect_list_members;
CREATE TRIGGER prospect_list_members_track_meeting
  AFTER INSERT OR UPDATE OF contact_status ON public.prospect_list_members
  FOR EACH ROW EXECUTE FUNCTION public.track_lead_meeting();

-- Las reuniones que ya existen: la mejor fecha real que hay es la del último
-- cambio de estado (status_changed_at). No se inventa ningún veredicto.
INSERT INTO public.lead_meetings (member_id, user_id, booked_at, held_at)
SELECT m.id, m.user_id,
       COALESCE(m.status_changed_at, m.updated_at, m.created_at),
       CASE WHEN m.contact_status = 'reunion_tomada' THEN COALESCE(m.status_changed_at, m.updated_at, m.created_at) END
  FROM public.prospect_list_members m
 WHERE m.contact_status IN ('reunion_agendada', 'reunion_tomada', 'no_show')
ON CONFLICT (member_id) DO NOTHING;

-- learning-loop escribe el veredicto agregado como scope `meeting_quality`.
ALTER TABLE public.learning_insights DROP CONSTRAINT IF EXISTS learning_insights_scope_check;
ALTER TABLE public.learning_insights ADD CONSTRAINT learning_insights_scope_check
  CHECK (scope IN ('radar_detector', 'campaign_node', 'campaign', 'channel', 'angle',
                   'winning_message', 'objection', 'icp_attribute', 'summary', 'meeting_quality'));

-- ── 2. Reporte semanal ─────────────────────────────────────────────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS report_emails TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS weekly_report_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.clients.report_emails IS
  'Destinatarios del reporte semanal (máx. 5). Los define el equipo en Clientes; el portal no los edita.';

CREATE TABLE IF NOT EXISTS public.client_weekly_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  week_start    date NOT NULL,
  week_end      date NOT NULL,
  timezone      text NOT NULL,
  metrics       jsonb NOT NULL DEFAULT '{}',
  computed_at   timestamptz NOT NULL DEFAULT now(),
  email_status  text NOT NULL DEFAULT 'pending'
                CHECK (email_status IN ('pending', 'sent', 'no_channel', 'no_recipients', 'failed', 'disabled')),
  email_error   text,
  emailed_at    timestamptz,
  UNIQUE (client_id, week_start)
);

CREATE INDEX IF NOT EXISTS client_weekly_reports_client_idx ON public.client_weekly_reports (client_id, week_start DESC);

ALTER TABLE public.client_weekly_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_weekly_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.client_weekly_reports TO authenticated;

DROP POLICY IF EXISTS client_weekly_reports_select ON public.client_weekly_reports;
CREATE POLICY client_weekly_reports_select ON public.client_weekly_reports
  FOR SELECT TO authenticated
  USING (public.can_manage_client(client_id));

-- ── 3. Benchmarks ──────────────────────────────────────────────────────────
-- Histórico importado (Eleva). Filas AGREGADAS, nunca personas: el CSV no
-- trae nombres, emails ni teléfonos (esquema en docs/BENCHMARKS.md).
CREATE TABLE IF NOT EXISTS public.benchmark_history_imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source      text NOT NULL DEFAULT 'eleva' CHECK (source IN ('eleva')),
  file_name   text,
  row_count   integer NOT NULL DEFAULT 0,
  imported_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.benchmark_history_rows (
  id                 bigserial PRIMARY KEY,
  import_id          uuid NOT NULL REFERENCES public.benchmark_history_imports(id) ON DELETE CASCADE,
  source             text NOT NULL DEFAULT 'eleva',
  period_month       date NOT NULL,
  country            text NOT NULL,
  industry           text NOT NULL,
  channel            text NOT NULL,
  clients            integer NOT NULL CHECK (clients >= 0),
  contacts           integer NOT NULL CHECK (contacts >= 0),
  replied            integer NOT NULL CHECK (replied >= 0),
  meetings_booked    integer NOT NULL CHECK (meetings_booked >= 0),
  meetings_held      integer NOT NULL CHECK (meetings_held >= 0),
  no_shows           integer NOT NULL CHECK (no_shows >= 0),
  meetings_qualified integer CHECK (meetings_qualified IS NULL OR meetings_qualified >= 0)
);

CREATE INDEX IF NOT EXISTS benchmark_history_rows_import_idx ON public.benchmark_history_rows (import_id);

-- Celdas agregadas (country/industry = '' significa «todos»). Con conteos
-- crudos de pocas cuentas se podría deducir el resultado de un cliente: por
-- eso no se exponen; las lee solo la edge function benchmarks.
CREATE TABLE IF NOT EXISTS public.benchmark_cells (
  source       text NOT NULL CHECK (source IN ('platform', 'eleva')),
  country      text NOT NULL DEFAULT '',
  industry     text NOT NULL DEFAULT '',
  accounts     integer NOT NULL DEFAULT 0,
  contacts     integer NOT NULL DEFAULT 0,
  replied      integer NOT NULL DEFAULT 0,
  meetings     integer NOT NULL DEFAULT 0,
  attended     integer NOT NULL DEFAULT 0,
  no_show      integer NOT NULL DEFAULT 0,
  qualified    integer NOT NULL DEFAULT 0,
  judged       integer NOT NULL DEFAULT 0,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, country, industry)
);

ALTER TABLE public.benchmark_history_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.benchmark_history_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.benchmark_cells ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.benchmark_history_imports FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.benchmark_history_rows FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.benchmark_cells FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.benchmark_history_rows_id_seq FROM PUBLIC, anon, authenticated;

-- Recalcula las celdas. Plataforma: leads con al menos un envío aceptado en
-- los últimos 365 días (un `sent`/`connection_sent` cuyo provider_message_id
-- no tiene un `failed`, igual que js/campaign-analytics.js), contados como
-- personas. Respondió = algún enrolamiento con respuesta. Reunión =
-- lead_meetings. Asistió / no se presentó = el veredicto del cliente o, sin
-- él, el CRM (held_at / no_show).
CREATE OR REPLACE FUNCTION public.refresh_benchmarks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  DELETE FROM public.benchmark_cells;

  WITH accepted AS (
    SELECT DISTINCT e.enrollment_id
      FROM public.campaign_events e
     WHERE e.type IN ('sent', 'connection_sent')
       AND e.created_at >= now() - interval '365 days'
       AND e.enrollment_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.campaign_events f
          WHERE f.type = 'failed'
            AND e.provider_message_id IS NOT NULL
            AND f.provider_message_id = e.provider_message_id
       )
  ), leads AS (
    SELECT m.id AS member_id,
           m.user_id,
           lower(btrim(COALESCE(m.country, ''))) AS country,
           lower(btrim(COALESCE(m.snapshot->'organization'->>'industry', ''))) AS industry,
           m.contact_status,
           bool_or(en.replied_at IS NOT NULL OR en.status = 'replied') AS replied
      FROM accepted a
      JOIN public.campaign_enrollments en ON en.id = a.enrollment_id
      JOIN public.prospect_list_members m ON m.id = en.member_id
     GROUP BY m.id
  ), scored AS (
    SELECT l.*,
           (lm.member_id IS NOT NULL) AS meeting,
           (lm.member_id IS NOT NULL AND (
              lm.client_verdict IN ('held', 'qualified', 'not_qualified')
              OR (lm.client_verdict IS NULL AND lm.held_at IS NOT NULL AND l.contact_status <> 'no_show'))) AS attended,
           (lm.member_id IS NOT NULL AND (
              lm.client_verdict = 'no_show'
              OR (lm.client_verdict IS NULL AND l.contact_status = 'no_show'))) AS no_show,
           (lm.client_verdict = 'qualified') AS qualified,
           (lm.client_verdict IN ('qualified', 'not_qualified')) AS judged
      FROM leads l
      LEFT JOIN public.lead_meetings lm ON lm.member_id = l.member_id
  )
  INSERT INTO public.benchmark_cells (source, country, industry, accounts, contacts, replied, meetings, attended, no_show, qualified, judged, computed_at)
  SELECT 'platform',
         CASE WHEN GROUPING(country) = 1 THEN '' ELSE country END,
         CASE WHEN GROUPING(industry) = 1 THEN '' ELSE industry END,
         count(DISTINCT user_id), count(*),
         count(*) FILTER (WHERE replied), count(*) FILTER (WHERE meeting),
         count(*) FILTER (WHERE attended), count(*) FILTER (WHERE no_show),
         count(*) FILTER (WHERE qualified), count(*) FILTER (WHERE judged),
         now()
    FROM scored
   GROUP BY GROUPING SETS ((country, industry), (country), (industry), ())
  HAVING (GROUPING(country) = 1 OR country <> '') AND (GROUPING(industry) = 1 OR industry <> '');

  -- Histórico importado: «accounts» = el máximo de clientes declarado en la
  -- celda (cota inferior de clientes distintos; sumar meses los contaría dos veces).
  INSERT INTO public.benchmark_cells (source, country, industry, accounts, contacts, replied, meetings, attended, no_show, qualified, judged, computed_at)
  SELECT 'eleva',
         CASE WHEN GROUPING(country) = 1 THEN '' ELSE country END,
         CASE WHEN GROUPING(industry) = 1 THEN '' ELSE industry END,
         max(clients), sum(contacts), sum(replied), sum(meetings_booked),
         sum(meetings_held), sum(no_shows),
         COALESCE(sum(meetings_qualified), 0),
         COALESCE(sum(meetings_held) FILTER (WHERE meetings_qualified IS NOT NULL), 0),
         now()
    FROM public.benchmark_history_rows
   GROUP BY GROUPING SETS ((country, industry), (country), (industry), ());

  SELECT count(*) INTO n FROM public.benchmark_cells;
  RETURN n;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refresh_benchmarks() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_benchmarks() TO service_role;

-- ── 4. Plantillas de campaña de Eleva ──────────────────────────────────────
-- `flow` es un grafo campaigns.flow (validado con _shared/campaign-flow.ts al
-- cargarlo). Al usarla, el asistente le pone ids nuevos y deja los pasos de
-- WhatsApp sin plantilla elegida: cada tenant tiene su propio catálogo.
CREATE TABLE IF NOT EXISTS public.campaign_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text NOT NULL DEFAULT 'eleva' CHECK (source IN ('eleva')),
  vertical      text NOT NULL CHECK (char_length(vertical) BETWEEN 1 AND 80),
  country       text CHECK (country IS NULL OR char_length(country) <= 60),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  summary       text CHECK (summary IS NULL OR char_length(summary) <= 600),
  results_note  text CHECK (results_note IS NULL OR char_length(results_note) <= 400),
  flow          jsonb NOT NULL,
  published     boolean NOT NULL DEFAULT false,
  sort          integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.campaign_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.campaign_templates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.campaign_templates TO authenticated;

DROP POLICY IF EXISTS campaign_templates_select ON public.campaign_templates;
CREATE POLICY campaign_templates_select ON public.campaign_templates
  FOR SELECT TO authenticated
  USING (published);

-- ── Crons (ejecutar a mano en el SQL editor, con la URL del proyecto y la
--    service role; igual que learning-loop) ─────────────────────────────────
-- Reporte semanal, lunes 12:10 UTC (≈ 7:10 en Bogotá/Lima, 6:10 en CDMX):
-- SELECT cron.schedule('client-report-weekly', '10 12 * * 1', $cron$
--   SELECT net.http_post(
--     url := 'https://<project-ref>.supabase.co/functions/v1/client-report',
--     headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <SUPABASE_SERVICE_ROLE_KEY>'),
--     body := '{"action":"run_weekly"}'::jsonb,
--     timeout_milliseconds := 150000);
-- $cron$);
--
-- Benchmarks, diario (no necesita la edge function):
-- SELECT cron.schedule('refresh-benchmarks', '40 6 * * *', $cron$ SELECT public.refresh_benchmarks(); $cron$);
