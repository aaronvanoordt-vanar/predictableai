-- ═══════════════════════════════════════════════════════════════════════════
-- Desarrolladores: API pública, servidor MCP y webhooks salientes — 2026-09-23
--
-- Para que el CRM interno de un cliente (o Zapier / Make / n8n, o un agente
-- de IA por MCP) se conecte a Predictable igual que una app se conecta a
-- HubSpot. Diseño completo en docs/API.md.
--
--   • api_keys               — claves por usuario. Solo se guarda el SHA-256
--     de la clave; el texto plano sale UNA vez de create_api_key(). El cliente
--     lee sus claves (sin el hash) y las revoca con revoke_api_key().
--   • api_webhooks           — endpoints del cliente que reciben eventos.
--     CLIENT-WRITABLE por dueño (URL https, eventos, activo). El secreto de
--     firma lo genera la base y el dueño puede verlo (lo necesita para
--     verificar la firma, igual que en Stripe).
--   Requiere 20260923000009_radar_daily_batch (radar_signals.surfaced_at).
--   • api_events             — el registro de eventos del usuario. Lo
--     escriben SOLO los triggers de abajo, y solo si el usuario tiene una
--     clave activa o un webhook activo (quien no integra nada no paga el
--     costo). Lo lee GET /v1/events (polling) y el despachador.
--   • api_webhook_deliveries — una fila por (evento × webhook suscrito). La
--     reclama y envía la edge function api-webhooks (pg_cron cada minuto),
--     con firma HMAC y reintentos con espera creciente.
--   • api_request_log        — una fila por request a la API/MCP (pestaña
--     «Registro» y límite de ritmo). Solo la service role escribe.
--   • prospect_list_members.external_id / external_source — el id del
--     registro en el CRM del cliente, para sincronizar sin duplicar.
--
-- Los triggers NUNCA rompen la escritura original: cualquier error se
-- degrada a WARNING (un webhook caído no puede impedir guardar un lead).
--
-- Todas las sentencias son idempotentes (seguras de re-aplicar).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── 1. Id externo en los contactos ──────────────────────────────────────────

ALTER TABLE public.prospect_list_members
  ADD COLUMN IF NOT EXISTS external_id     TEXT,
  ADD COLUMN IF NOT EXISTS external_source TEXT;

COMMENT ON COLUMN public.prospect_list_members.external_id IS
  'Id del registro en el sistema del cliente (CRM). Lo escribe la API pública; sirve para upsert sin duplicar.';

CREATE INDEX IF NOT EXISTS prospect_list_members_external_idx
  ON public.prospect_list_members (user_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS prospect_list_members_user_email_idx
  ON public.prospect_list_members (user_id, lower(email))
  WHERE email IS NOT NULL;

-- ── 2. Claves de API ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.api_keys (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  -- Lo que se muestra para reconocerla: "pai_live_3f9a…" (nunca la clave).
  prefix        TEXT        NOT NULL,
  key_hash      TEXT        NOT NULL UNIQUE,
  -- 'read' = solo lectura; 'write' = lectura + escritura.
  scopes        TEXT[]      NOT NULL DEFAULT '{read}'
                CHECK (scopes <@ ARRAY['read', 'write']::TEXT[] AND cardinality(scopes) >= 1),
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_keys_user_idx ON public.api_keys (user_id) WHERE revoked_at IS NULL;

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own api keys" ON public.api_keys;
CREATE POLICY "Users can view own api keys"
  ON public.api_keys FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Sin SELECT de tabla: key_hash no sale nunca al navegador. Crear y revocar
-- van por RPC.
REVOKE ALL ON public.api_keys FROM anon, PUBLIC, authenticated;
GRANT SELECT (id, user_id, name, prefix, scopes, last_used_at, expires_at, revoked_at, created_at)
  ON public.api_keys TO authenticated;

-- Crea una clave y devuelve el texto plano UNA sola vez.
CREATE OR REPLACE FUNCTION public.create_api_key(p_name TEXT, p_scopes TEXT[] DEFAULT ARRAY['read'])
RETURNS TABLE (id UUID, key TEXT, prefix TEXT, name TEXT, scopes TEXT[], created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_key    TEXT;
  v_name   TEXT := btrim(COALESCE(p_name, ''));
  v_scopes TEXT[];
  v_row    public.api_keys;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  IF char_length(v_name) < 1 OR char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = '22023';
  END IF;
  v_scopes := CASE WHEN 'write' = ANY(COALESCE(p_scopes, '{}')) THEN ARRAY['read', 'write'] ELSE ARRAY['read'] END;
  IF (SELECT count(*) FROM public.api_keys k WHERE k.user_id = v_uid AND k.revoked_at IS NULL) >= 10 THEN
    RAISE EXCEPTION 'too_many_keys' USING ERRCODE = '54000';
  END IF;

  v_key := 'pai_live_' || encode(extensions.gen_random_bytes(24), 'hex');
  INSERT INTO public.api_keys (user_id, name, prefix, key_hash, scopes)
  VALUES (v_uid, v_name, left(v_key, 13), encode(extensions.digest(v_key, 'sha256'), 'hex'), v_scopes)
  RETURNING * INTO v_row;

  RETURN QUERY SELECT v_row.id, v_key, v_row.prefix, v_row.name, v_row.scopes, v_row.created_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_api_key(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  UPDATE public.api_keys
     SET revoked_at = NOW()
   WHERE id = p_id AND user_id = auth.uid() AND revoked_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.create_api_key(TEXT, TEXT[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_api_key(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_api_key(TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_api_key(UUID) TO authenticated;

-- ── 3. Webhooks salientes ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.api_webhooks (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  url              TEXT        NOT NULL CHECK (url ~* '^https://[^\s]+$' AND char_length(url) <= 2000),
  description      TEXT        CHECK (description IS NULL OR char_length(description) <= 200),
  -- Tipos de evento suscritos; '*' = todos.
  events           TEXT[]      NOT NULL DEFAULT '{*}' CHECK (cardinality(events) >= 1),
  secret           TEXT        NOT NULL DEFAULT ('whsec_' || encode(extensions.gen_random_bytes(24), 'hex')),
  enabled          BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Lo escribe el despachador.
  last_delivery_at TIMESTAMPTZ,
  last_status      INTEGER,
  failure_count    INTEGER     NOT NULL DEFAULT 0,
  disabled_reason  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS api_webhooks_updated_at ON public.api_webhooks;
CREATE TRIGGER api_webhooks_updated_at
  BEFORE UPDATE ON public.api_webhooks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Reactivar un webhook que el despachador apagó le da una oportunidad limpia.
CREATE OR REPLACE FUNCTION public.api_webhooks_reset_on_enable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.enabled AND NOT OLD.enabled THEN
    NEW.failure_count := 0;
    NEW.disabled_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.api_webhooks_reset_on_enable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS api_webhooks_reset_on_enable ON public.api_webhooks;
CREATE TRIGGER api_webhooks_reset_on_enable
  BEFORE UPDATE ON public.api_webhooks
  FOR EACH ROW EXECUTE FUNCTION public.api_webhooks_reset_on_enable();

CREATE INDEX IF NOT EXISTS api_webhooks_user_idx ON public.api_webhooks (user_id) WHERE enabled;

ALTER TABLE public.api_webhooks ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE cmd TEXT;
BEGIN
  FOREACH cmd IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Users can %1$s own api webhooks" ON public.api_webhooks', lower(cmd));
  END LOOP;
END $$;

CREATE POLICY "Users can select own api webhooks" ON public.api_webhooks
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own api webhooks" ON public.api_webhooks
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own api webhooks" ON public.api_webhooks
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own api webhooks" ON public.api_webhooks
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- El cliente elige URL, eventos, descripción y si está activo; el estado de
-- entrega (last_*, failure_count, disabled_reason) y el secreto solo los
-- escribe la service role.
REVOKE ALL ON public.api_webhooks FROM anon, PUBLIC, authenticated;
GRANT SELECT, DELETE ON public.api_webhooks TO authenticated;
GRANT INSERT (user_id, url, description, events, enabled) ON public.api_webhooks TO authenticated;
GRANT UPDATE (url, description, events, enabled) ON public.api_webhooks TO authenticated;

-- ── 4. Eventos ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.api_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type        TEXT        NOT NULL,
  data        JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_events_user_created_idx ON public.api_events (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS api_events_created_idx ON public.api_events (created_at);

ALTER TABLE public.api_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own api events" ON public.api_events;
CREATE POLICY "Users can view own api events" ON public.api_events
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
REVOKE ALL ON public.api_events FROM anon, PUBLIC, authenticated;
GRANT SELECT ON public.api_events TO authenticated;

CREATE TABLE IF NOT EXISTS public.api_webhook_deliveries (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id      UUID        NOT NULL REFERENCES public.api_webhooks(id) ON DELETE CASCADE,
  event_id        UUID        NOT NULL REFERENCES public.api_events(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type      TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        SMALLINT    NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at      TIMESTAMPTZ,
  response_status INTEGER,
  last_error      TEXT,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_webhook_deliveries_queue_idx
  ON public.api_webhook_deliveries (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS api_webhook_deliveries_webhook_idx
  ON public.api_webhook_deliveries (webhook_id, created_at DESC);

ALTER TABLE public.api_webhook_deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own webhook deliveries" ON public.api_webhook_deliveries;
CREATE POLICY "Users can view own webhook deliveries" ON public.api_webhook_deliveries
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
REVOKE ALL ON public.api_webhook_deliveries FROM anon, PUBLIC, authenticated;
GRANT SELECT ON public.api_webhook_deliveries TO authenticated;

-- Reclamo atómico de un lote (FOR UPDATE SKIP LOCKED): dos corridas del cron
-- nunca envían la misma entrega. Una entrega reclamada hace más de 2 min
-- (invocación muerta) se puede reclamar de nuevo.
CREATE OR REPLACE FUNCTION public.claim_webhook_deliveries(p_limit INTEGER DEFAULT 100)
RETURNS SETOF public.api_webhook_deliveries
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH picked AS (
    SELECT d.id
      FROM public.api_webhook_deliveries d
     WHERE d.status = 'pending'
       AND d.next_attempt_at <= NOW()
       AND (d.claimed_at IS NULL OR d.claimed_at < NOW() - INTERVAL '2 minutes')
     ORDER BY d.next_attempt_at, d.id
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.api_webhook_deliveries d
     SET claimed_at = NOW()
    FROM picked
   WHERE d.id = picked.id
  RETURNING d.*;
$$;

REVOKE ALL ON FUNCTION public.claim_webhook_deliveries(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_webhook_deliveries(INTEGER) TO service_role;

-- ── 5. Registro de requests ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.api_request_log (
  id           BIGSERIAL   PRIMARY KEY,
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_id       UUID        REFERENCES public.api_keys(id) ON DELETE SET NULL,
  surface      TEXT        NOT NULL DEFAULT 'rest' CHECK (surface IN ('rest', 'mcp')),
  method       TEXT        NOT NULL,
  path         TEXT        NOT NULL,
  status       INTEGER     NOT NULL,
  duration_ms  INTEGER,
  error_code   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_request_log_user_idx ON public.api_request_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_request_log_key_idx ON public.api_request_log (key_id, created_at DESC);

ALTER TABLE public.api_request_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own api requests" ON public.api_request_log;
CREATE POLICY "Users can view own api requests" ON public.api_request_log
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
REVOKE ALL ON public.api_request_log FROM anon, PUBLIC, authenticated;
GRANT SELECT ON public.api_request_log TO authenticated;

-- ── 6. Emisión de eventos ───────────────────────────────────────────────────

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
    'enriched_at', m.enriched_at, 'created_at', m.created_at, 'updated_at', m.updated_at
  );
$$;

CREATE OR REPLACE FUNCTION public.emit_api_event(p_user_id UUID, p_type TEXT, p_data JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event UUID;
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;
  -- Quien no integra nada no acumula eventos.
  IF NOT EXISTS (SELECT 1 FROM public.api_keys k WHERE k.user_id = p_user_id AND k.revoked_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.api_webhooks w WHERE w.user_id = p_user_id AND w.enabled) THEN
    RETURN;
  END IF;

  INSERT INTO public.api_events (user_id, type, data)
  VALUES (p_user_id, p_type, COALESCE(p_data, '{}'::jsonb))
  RETURNING id INTO v_event;

  INSERT INTO public.api_webhook_deliveries (webhook_id, event_id, user_id, event_type)
  SELECT w.id, v_event, w.user_id, p_type
    FROM public.api_webhooks w
   WHERE w.user_id = p_user_id
     AND w.enabled
     AND (p_type = ANY (w.events) OR '*' = ANY (w.events));
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'emit_api_event(%): %', p_type, SQLERRM;
END;
$$;

REVOKE ALL ON FUNCTION public.emit_api_event(UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_contact_json(public.prospect_list_members) FROM PUBLIC, anon;

-- Contactos: creado, cambio de estado del CRM, enriquecido.
CREATE OR REPLACE FUNCTION public.api_events_on_member()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.emit_api_event(NEW.user_id, 'contact.created', jsonb_build_object('contact', public.api_contact_json(NEW)));
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.contact_status IS DISTINCT FROM OLD.contact_status THEN
      PERFORM public.emit_api_event(NEW.user_id, 'contact.status_changed', jsonb_build_object(
        'contact', public.api_contact_json(NEW),
        'previous_status', OLD.contact_status,
        'status', NEW.contact_status));
    END IF;
    IF (NEW.enriched_at IS NOT NULL AND NEW.enriched_at IS DISTINCT FROM OLD.enriched_at)
       OR (NEW.phone_status = 'revealed' AND OLD.phone_status IS DISTINCT FROM 'revealed') THEN
      PERFORM public.emit_api_event(NEW.user_id, 'contact.enriched', jsonb_build_object('contact', public.api_contact_json(NEW)));
    END IF;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'api_events_on_member: %', SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS api_events_member_ins ON public.prospect_list_members;
CREATE TRIGGER api_events_member_ins
  AFTER INSERT ON public.prospect_list_members
  FOR EACH ROW EXECUTE FUNCTION public.api_events_on_member();

DROP TRIGGER IF EXISTS api_events_member_upd ON public.prospect_list_members;
CREATE TRIGGER api_events_member_upd
  AFTER UPDATE ON public.prospect_list_members
  FOR EACH ROW EXECUTE FUNCTION public.api_events_on_member();

-- Mensajes de la Bandeja (todos los canales).
CREATE OR REPLACE FUNCTION public.api_events_on_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.emit_api_event(NEW.user_id,
    CASE WHEN NEW.direction = 'in' THEN 'message.received' ELSE 'message.sent' END,
    jsonb_build_object('message', jsonb_build_object(
      'id', NEW.id, 'contact_id', NEW.member_id, 'channel', NEW.channel,
      'direction', NEW.direction, 'contact_ref', NEW.contact_ref, 'body', NEW.body,
      'status', NEW.status, 'sent_at', NEW.sent_at)));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'api_events_on_message: %', SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS api_events_message_ins ON public.inbox_messages;
CREATE TRIGGER api_events_message_ins
  AFTER INSERT ON public.inbox_messages
  FOR EACH ROW EXECUTE FUNCTION public.api_events_on_message();

-- Señales del Radar: cuando el Radar las ENTREGA (lote diario, migración
-- 20260923000009_radar_daily_batch: surfaced_at pasa a tener fecha), no cuando
-- el motor las guarda en reserva. Así el CRM recibe lo mismo que el usuario ve
-- en «Nuevas» y no cientos de señales de una corrida.
CREATE OR REPLACE FUNCTION public.api_events_on_signal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.surfaced_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.surfaced_at IS NULL) THEN
    PERFORM public.emit_api_event(NEW.user_id, 'signal.created', jsonb_build_object('signal', jsonb_build_object(
      'id', NEW.id, 'company_name', NEW.company_name, 'company_domain', NEW.company_domain,
      'website', NEW.website, 'country', NEW.country, 'industry', NEW.industry,
      'employee_count', NEW.employee_count, 'headline', NEW.headline, 'why_fit', NEW.why_fit,
      'strength', NEW.strength, 'score', NEW.score, 'signal_date', NEW.signal_date,
      'detector_kind', NEW.detector_kind, 'detector_name', NEW.detector_name,
      'evidence', NEW.evidence, 'status', NEW.status, 'surfaced_at', NEW.surfaced_at,
      'created_at', NEW.created_at)));
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'api_events_on_signal: %', SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS api_events_signal_ins ON public.radar_signals;
CREATE TRIGGER api_events_signal_ins
  AFTER INSERT ON public.radar_signals
  FOR EACH ROW EXECUTE FUNCTION public.api_events_on_signal();

DROP TRIGGER IF EXISTS api_events_signal_surfaced ON public.radar_signals;
CREATE TRIGGER api_events_signal_surfaced
  AFTER UPDATE OF surfaced_at ON public.radar_signals
  FOR EACH ROW EXECUTE FUNCTION public.api_events_on_signal();

-- Enrolamientos: solo los cambios que significan algo para un CRM. El motor
-- alterna active ↔ processing en cada paso; eso no es un evento.
CREATE OR REPLACE FUNCTION public.api_events_on_enrollment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('replied', 'unsubscribed', 'completed', 'paused', 'error') THEN
    PERFORM public.emit_api_event(NEW.user_id, 'enrollment.status_changed', jsonb_build_object('enrollment', jsonb_build_object(
      'id', NEW.id, 'campaign_id', NEW.campaign_id, 'contact_id', NEW.member_id,
      'status', NEW.status, 'previous_status', OLD.status,
      'replied_at', NEW.replied_at, 'replied_channel', NEW.replied_channel,
      'stop_reason', NEW.stop_reason, 'error_detail', NEW.error_detail,
      'updated_at', NEW.updated_at)));
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'api_events_on_enrollment: %', SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS api_events_enrollment_upd ON public.campaign_enrollments;
CREATE TRIGGER api_events_enrollment_upd
  AFTER UPDATE ON public.campaign_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.api_events_on_enrollment();

-- Reuniones del Meeting Coach: reporte listo.
CREATE OR REPLACE FUNCTION public.api_events_on_meeting()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    PERFORM public.emit_api_event(NEW.user_id, 'meeting.completed', jsonb_build_object('meeting', jsonb_build_object(
      'id', NEW.id, 'contact_id', NEW.prospect_id, 'prospect_name', NEW.prospect_name,
      'started_at', NEW.started_at, 'ended_at', NEW.ended_at,
      'score', NEW.score_total, 'outcome', NEW.outcome,
      'summary', NEW.final_report ->> 'resumen_corto',
      'next_step', NEW.final_report ->> 'siguiente_paso')));
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'api_events_on_meeting: %', SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS api_events_meeting_upd ON public.coach_meetings;
CREATE TRIGGER api_events_meeting_upd
  AFTER UPDATE ON public.coach_meetings
  FOR EACH ROW EXECUTE FUNCTION public.api_events_on_meeting();

REVOKE ALL ON FUNCTION public.api_events_on_member()     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_events_on_message()    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_events_on_signal()     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_events_on_enrollment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_events_on_meeting()    FROM PUBLIC, anon, authenticated;

-- ── 7. Cron del despachador (ejecutar a mano en el SQL editor, con la URL del
--    proyecto y la service role; igual que campaign-run / enrich-list) ──────
-- SELECT cron.schedule('api-webhooks', '* * * * *', $cron$
--   SELECT net.http_post(
--     url := 'https://<project-ref>.supabase.co/functions/v1/api-webhooks',
--     headers := jsonb_build_object('Content-Type', 'application/json',
--                                   'Authorization', 'Bearer <service-role-key>'),
--     body := '{"action":"dispatch"}'::jsonb
--   );
-- $cron$);
