-- ═══════════════════════════════════════════════════════════════════════════
-- Telefonía (2026-10-17): dialer nativo (Twilio) + conectores CloudTalk,
-- Aircall y Ringover + la llamada como paso de campaña.
-- Diseño, proveedores y pasos del dueño en docs/TELEFONIA.md.
--
-- Modelo común de llamadas — mismo criterio de escritura que channel_accounts
-- / campaign_events:
--   • telephony_accounts — escrita SOLO por la edge function `telephony`
--     (service role) tras validar la credencial contra el proveedor. El
--     cliente lee sin las columnas secretas y puede borrar (desconectar).
--   • calls              — una fila por llamada, venga del dialer nativo, de
--     un conector o de un webhook. Solo service role escribe: el resultado lo
--     fija la edge function (porque mueve el enrolamiento y el CRM).
--   • call_tasks         — la tarea de llamar que crea un paso `call` de una
--     campaña (campaign-run). Solo service role escribe.
--
-- `provider` es texto libre validado en código (_shared/telephony/registry.ts):
-- sumar un proveedor nuevo no necesita migración.
--
-- Idempotente (seguro de re-aplicar).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Cuentas de telefonía ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.telephony_accounts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- twilio (dialer nativo) | cloudtalk | aircall | ringover | …
  provider        TEXT        NOT NULL CHECK (char_length(provider) BETWEEN 2 AND 32),
  -- Lo que la UI muestra: agente/usuario del proveedor, números, identificador
  -- de llamada verificado, URL del webhook, última sincronización.
  config          JSONB       NOT NULL DEFAULT '{}',
  -- API key / token del proveedor ('' en el dialer nativo: la cuenta de
  -- Twilio es de la plataforma). Oculto al cliente por grants de columna.
  secret          TEXT        NOT NULL DEFAULT '',
  -- Viaja en la URL del webhook (?key=…): Aircall manda un token en el body y
  -- Ringover firma con su propio secreto, pero la clave de la URL es lo que
  -- dice de QUÉ cuenta es el evento.
  webhook_secret  TEXT        NOT NULL DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  -- El proveedor con el que sale el clic para llamar (uno por usuario).
  is_default      BOOLEAN     NOT NULL DEFAULT false,
  status          TEXT        NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error')),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT telephony_accounts_user_provider_key UNIQUE (user_id, provider)
);

DROP TRIGGER IF EXISTS telephony_accounts_updated_at ON public.telephony_accounts;
CREATE TRIGGER telephony_accounts_updated_at
  BEFORE UPDATE ON public.telephony_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.telephony_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own telephony accounts" ON public.telephony_accounts;
CREATE POLICY "Users can view own telephony accounts"
  ON public.telephony_accounts FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own telephony accounts" ON public.telephony_accounts;
CREATE POLICY "Users can delete own telephony accounts"
  ON public.telephony_accounts FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.telephony_accounts FROM anon, PUBLIC;
REVOKE SELECT, INSERT, UPDATE ON public.telephony_accounts FROM authenticated;
GRANT  SELECT (id, user_id, provider, config, is_default, status, last_error, created_at, updated_at)
       ON public.telephony_accounts TO authenticated;
GRANT  DELETE ON public.telephony_accounts TO authenticated;

CREATE INDEX IF NOT EXISTS telephony_accounts_webhook_secret_idx
  ON public.telephony_accounts (webhook_secret);

-- ── 2. Llamadas ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.calls (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_id          UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  campaign_id        UUID        REFERENCES public.campaigns(id) ON DELETE SET NULL,
  enrollment_id      UUID        REFERENCES public.campaign_enrollments(id) ON DELETE SET NULL,
  task_id            UUID,
  provider           TEXT        NOT NULL,
  -- CallSid de Twilio / id de la llamada en el conector. NULL mientras el
  -- conector no lo devuelva (CloudTalk no lo da al iniciar: se enlaza al
  -- sincronizar por número y hora).
  provider_call_id   TEXT,
  direction          TEXT        NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
  from_number        TEXT,
  to_number          TEXT,
  -- queued → ringing → in_progress → completed | failed | busy | no_answer | canceled
  status             TEXT        NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'ringing', 'in_progress', 'completed', 'failed', 'busy', 'no_answer', 'canceled')),
  -- Resultado que marca el SDR (o el webhook cuando el proveedor lo sabe:
  -- buzón, no contestó). Alimenta las ramas de la campaña.
  outcome            TEXT        CHECK (outcome IN ('answered', 'voicemail', 'no_answer', 'meeting_booked', 'not_interested')),
  outcome_note       TEXT        CHECK (outcome_note IS NULL OR char_length(outcome_note) <= 2000),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at        TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  duration_seconds   INTEGER     CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  -- Grabación: con Twilio se guarda el SID (el audio se sirve por la edge
  -- function, nunca la URL con credenciales); con un conector, el enlace que
  -- da el proveedor.
  recording_ref      TEXT,
  recording_url      TEXT,
  recording_duration INTEGER,
  -- El SDR dejó la grabación encendida y al lead se le avisó al contestar.
  recording_notice   BOOLEAN     NOT NULL DEFAULT false,
  transcript         TEXT,
  transcript_status  TEXT        NOT NULL DEFAULT 'none' CHECK (transcript_status IN ('none', 'pending', 'ready', 'error')),
  -- Sesión del Meeting Coach que escuchó la llamada (su reporte queda en la
  -- ficha del lead).
  coach_meeting_id   UUID,
  credits_reserved   INTEGER     NOT NULL DEFAULT 0,
  credits_charged    INTEGER     NOT NULL DEFAULT 0,
  error_detail       TEXT,
  payload            JSONB       NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS calls_provider_call_key
  ON public.calls (provider, provider_call_id) WHERE provider_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_user_started_idx ON public.calls (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS calls_member_idx ON public.calls (member_id, started_at DESC);

DROP TRIGGER IF EXISTS calls_updated_at ON public.calls;
CREATE TRIGGER calls_updated_at
  BEFORE UPDATE ON public.calls
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own calls" ON public.calls;
CREATE POLICY "Users can view own calls"
  ON public.calls FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.calls FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.calls FROM authenticated;
GRANT  SELECT ON public.calls TO authenticated;

-- ── 3. Tareas de llamada (paso `call` de una campaña) ───────────────────────

CREATE TABLE IF NOT EXISTS public.call_tasks (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_id      UUID        REFERENCES public.prospect_list_members(id) ON DELETE CASCADE,
  campaign_id    UUID        REFERENCES public.campaigns(id) ON DELETE CASCADE,
  enrollment_id  UUID        REFERENCES public.campaign_enrollments(id) ON DELETE CASCADE,
  node_id        TEXT        NOT NULL,
  -- Guion para el SDR (IA desde campaign_messages, o el texto propio del paso).
  script         TEXT,
  -- pending → done (hubo resultado) | skipped (el SDR la saltó) | expired
  -- (venció el plazo del paso sin llamada) | canceled (el lead respondió).
  status         TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'done', 'skipped', 'expired', 'canceled')),
  due_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  call_id        UUID        REFERENCES public.calls(id) ON DELETE SET NULL,
  outcome        TEXT        CHECK (outcome IN ('answered', 'voicemail', 'no_answer', 'meeting_booked', 'not_interested')),
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT call_tasks_enrollment_node_key UNIQUE (enrollment_id, node_id)
);

CREATE INDEX IF NOT EXISTS call_tasks_user_status_idx ON public.call_tasks (user_id, status, due_at);

DROP TRIGGER IF EXISTS call_tasks_updated_at ON public.call_tasks;
CREATE TRIGGER call_tasks_updated_at
  BEFORE UPDATE ON public.call_tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.call_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own call tasks" ON public.call_tasks;
CREATE POLICY "Users can view own call tasks"
  ON public.call_tasks FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.call_tasks FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.call_tasks FROM authenticated;
GRANT  SELECT ON public.call_tasks TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calls_task_id_fkey') THEN
    ALTER TABLE public.calls
      ADD CONSTRAINT calls_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.call_tasks(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── 4. Campañas: el canal `phone` en eventos y mensajes IA ──────────────────
-- Mismo listado de antes + 'phone'. Tipos nuevos: `task_created` (la tarea
-- de llamar quedó en la cola del SDR) y `called` (resultado en payload.outcome).

ALTER TABLE public.campaign_events DROP CONSTRAINT IF EXISTS campaign_events_channel_check;
ALTER TABLE public.campaign_events
  ADD CONSTRAINT campaign_events_channel_check
  CHECK (channel IN ('whatsapp', 'email', 'linkedin', 'phone', 'system'));

ALTER TABLE public.campaign_events DROP CONSTRAINT IF EXISTS campaign_events_type_check;
ALTER TABLE public.campaign_events
  ADD CONSTRAINT campaign_events_type_check
  CHECK (type IN ('queued', 'sent', 'delivered', 'read', 'replied', 'failed', 'skipped',
                  'opted_out', 'connection_sent', 'connection_accepted', 'stopped', 'completed',
                  'opened', 'generated', 'branched', 'task_created', 'called'));

ALTER TABLE public.campaign_messages DROP CONSTRAINT IF EXISTS campaign_messages_channel_check;
ALTER TABLE public.campaign_messages
  ADD CONSTRAINT campaign_messages_channel_check
  CHECK (channel IN ('whatsapp', 'email', 'linkedin', 'phone'));

-- ── 5. Realtime: el dialer y la cola de llamadas se actualizan solos ────────

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.calls;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.call_tasks;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 6. Equipo: las llamadas en las metas, el ranking, la rampa y la revisión ─
-- La página Equipo (migración 20261018000003_team_management, js/team.js)
-- dejó el enganche: `calls` llegaba NULL («Sin telefonía») y las llamadas se
-- registran para la revisión con Team.registerCallSource. Aquí:
--   • team_member_activity cuenta las PERSONAS llamadas en la ventana (la
--     misma función alimenta metas, ranking y rampa). Se reemplaza entera: es
--     la de 20261018000003 con el conteo de llamadas en lugar de NULL.
--   • team_review_calls: las llamadas de un miembro para la revisión del
--     director (mismo permiso que team_review_meetings: él mismo, o su
--     director si está en la nómina). Sin transcripción ni audio nativo: el
--     resultado, la nota y el resumen del Meeting Coach; el enlace de la
--     grabación solo si es de un conector (https).
--   • team_add_comment valida que la llamada comentada sea de esa persona.

CREATE OR REPLACE FUNCTION public.team_member_activity(p_user UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_contacts INTEGER; v_email INTEGER; v_wa INTEGER; v_li INTEGER; v_sent INTEGER;
  v_replies INTEGER; v_booked INTEGER; v_held INTEGER;
  v_cohort INTEGER; v_cohort_replied INTEGER; v_cohort_meetings INTEGER;
  v_calls INTEGER;
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

  -- Personas llamadas en la ventana (telefonía, 2026-10-17): cada lead (o
  -- número suelto) al que se le marcó al menos una vez, contestara o no.
  -- Una llamada que no llegó a salir (`failed`) no cuenta.
  SELECT count(DISTINCT COALESCE(c.member_id::text, 'tel:' || COALESCE(c.to_number, c.id::text)))
    INTO v_calls
    FROM public.calls c
   WHERE c.user_id = p_user AND c.direction = 'outbound' AND c.status <> 'failed'
     AND c.started_at >= p_from AND c.started_at < p_to;

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
    -- Personas llamadas (tabla calls de telefonía).
    'calls', v_calls,
    'replies', v_replies,
    'meetings_booked', v_booked, 'meetings_held', v_held,
    'cohort', v_cohort, 'cohort_replied', v_cohort_replied, 'cohort_meetings', v_cohort_meetings);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.team_member_activity(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.team_member_activity(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

CREATE OR REPLACE FUNCTION public.team_review_calls(p_member UUID, p_limit INTEGER DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (
       p_member = auth.uid()
       OR (public.team_is_manager() AND public.team_is_rostered(p_member))) THEN
    RAISE EXCEPTION 'No puedes ver las llamadas de esa persona.' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(x ORDER BY x->>'started_at' DESC)
      FROM (
        SELECT jsonb_build_object(
                 'id', c.id,
                 'started_at', c.started_at,
                 'provider', c.provider,
                 'direction', c.direction,
                 'status', c.status,
                 'outcome', c.outcome,
                 'outcome_note', c.outcome_note,
                 'duration_seconds', c.duration_seconds,
                 'lead_name', m.name,
                 'lead_company', m.company,
                 'coach', c.payload->'coach',
                 'coach_meeting_id', c.coach_meeting_id,
                 'has_recording', c.recording_ref IS NOT NULL,
                 'recording_url', CASE WHEN c.recording_url ~* '^https://' THEN c.recording_url END
               ) AS x
          FROM public.calls c
          LEFT JOIN public.prospect_list_members m ON m.id = c.member_id
         WHERE c.user_id = p_member AND c.status <> 'failed'
         ORDER BY c.started_at DESC
         LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100)
      ) q), '[]'::jsonb);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.team_review_calls(UUID, INTEGER) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.team_review_calls(UUID, INTEGER) TO authenticated, service_role;

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
  IF v_kind = 'call' AND NOT EXISTS (
       SELECT 1 FROM public.calls WHERE id::text = p_subject AND user_id = p_member) THEN
    RAISE EXCEPTION 'Esa llamada no es de esta persona.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.sales_team_comments (company_name, member_id, author_id, subject_kind, subject_id, body)
  VALUES (public.team_my_company(), p_member, auth.uid(), v_kind,
          CASE WHEN v_kind = 'general' THEN NULL ELSE p_subject END, btrim(p_body))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.team_add_comment(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.team_add_comment(UUID, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ── 7. pg_cron: sincronización de conectores sin webhook (CloudTalk) ───────
-- NO se crea aquí (la service-role key nunca vive en el repo). Aplicar una
-- vez desde el SQL editor de Supabase (docs/TELEFONIA.md):
--
-- SELECT cron.schedule('telephony-sync', '*/10 * * * *', $cron$
--   SELECT net.http_post(
--     url     := 'https://<project-ref>.supabase.co/functions/v1/telephony',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'),
--     body    := '{"action":"sync_all"}'::jsonb,
--     timeout_milliseconds := 150000);
-- $cron$);
