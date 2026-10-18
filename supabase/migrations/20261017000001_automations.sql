-- Automatizaciones de punta a punta (2026-10-17, docs/ROADMAP_GTM_OS.md ítem 10).
--
-- Reglas «cuando → si → entonces» que encadenan lo que ya existe: señal del
-- Radar → decisores (Apollo) → enriquecer (enrich-list) → investigar
-- (lead-research) → enrolar (campaign-run), más tareas y avisos. Diseño en
-- docs/AUTOMATIONS.md; validación, filtros y costos en
-- supabase/functions/_shared/automations.ts.
--
--   automation_rules  — la regla. La escribe el usuario (RLS por dueño); el
--                       motor la revalida con normalizeRule antes de ejecutar.
--   automation_runs   — una ejecución por (regla, sujeto). La crean SOLO los
--                       triggers de esta migración (UNIQUE (rule_id,
--                       subject_key): la misma señal, lead o mensaje no
--                       dispara dos veces la misma regla) y la avanza el motor
--                       `automation-run` (pg_cron cada minuto, service role).
--                       El usuario la ve y la decide con decide_automation_runs().
--   sales_tasks       — tareas por lead (acción «Crear una tarea»; también
--                       manuales). RLS por dueño.
--
-- Estados de una ejecución:
--   queued → (motor planifica: filtros, costo, topes)
--          → pending_approval → approved → running → done | failed
--          → running (corre sola: sin gasto/envíos, o automática dentro del tope)
--   pending_approval → rejected | expired (7 días) ; queued/approved/running → canceled
-- Lo que el filtro descarta no deja fila (el motor la borra): nada pasó.

-- ── 1. Reglas ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.automation_rules (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  name              TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  trigger_kind      TEXT        NOT NULL CHECK (trigger_kind IN (
                      'radar_signal', 'list_lead', 'inbox_reply',
                      'campaign_no_reply', 'meeting_booked', 'meeting_closed')),
  trigger_config    JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(trigger_config) = 'object'),
  actions           JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) <= 7),
  mode              TEXT        NOT NULL DEFAULT 'approval' CHECK (mode IN ('approval', 'auto')),
  daily_credit_cap  INTEGER     NOT NULL DEFAULT 60 CHECK (daily_credit_cap BETWEEN 0 AND 5000),
  daily_lead_cap    INTEGER     NOT NULL DEFAULT 20 CHECK (daily_lead_cap BETWEEN 0 AND 5000),
  recipe_key        TEXT        CHECK (recipe_key IS NULL OR char_length(recipe_key) <= 60),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS automation_rules_user_kind_idx
  ON public.automation_rules (user_id, trigger_kind) WHERE enabled;

DROP TRIGGER IF EXISTS automation_rules_updated_at ON public.automation_rules;
CREATE TRIGGER automation_rules_updated_at
  BEFORE UPDATE ON public.automation_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.automation_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.automation_rules FROM anon;
DROP POLICY IF EXISTS "Users manage own automation rules" ON public.automation_rules;
CREATE POLICY "Users manage own automation rules" ON public.automation_rules
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── 2. Ejecuciones ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.automation_runs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rule_id          UUID        NOT NULL REFERENCES public.automation_rules(id) ON DELETE CASCADE,
  trigger_kind     TEXT        NOT NULL,
  subject_key      TEXT        NOT NULL CHECK (char_length(subject_key) <= 120),
  subject          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status           TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN (
                     'queued', 'pending_approval', 'approved', 'running',
                     'done', 'failed', 'rejected', 'expired', 'canceled')),
  approval_reason  TEXT,
  step             INTEGER     NOT NULL DEFAULT 0,
  state            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  log              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  plan             JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- desglose del costo estimado
  cost_estimate    INTEGER     NOT NULL DEFAULT 0,
  leads_estimate   INTEGER     NOT NULL DEFAULT 0,
  cost_actual      INTEGER     NOT NULL DEFAULT 0,
  leads_actual     INTEGER     NOT NULL DEFAULT 0,
  sends            BOOLEAN     NOT NULL DEFAULT FALSE,
  auto_started     BOOLEAN     NOT NULL DEFAULT FALSE,           -- corrió sin aprobación (cuenta para los topes)
  error            TEXT,
  decision_note    TEXT        CHECK (decision_note IS NULL OR char_length(decision_note) <= 500),
  decided_at       TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  next_run_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at       TIMESTAMPTZ,
  attempts         INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automation_runs_rule_subject_key UNIQUE (rule_id, subject_key)
);

CREATE INDEX IF NOT EXISTS automation_runs_queue_idx
  ON public.automation_runs (next_run_at)
  WHERE status IN ('queued', 'approved', 'running');
CREATE INDEX IF NOT EXISTS automation_runs_user_idx
  ON public.automation_runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS automation_runs_pending_idx
  ON public.automation_runs (user_id) WHERE status = 'pending_approval';
CREATE INDEX IF NOT EXISTS automation_runs_rule_day_idx
  ON public.automation_runs (rule_id, started_at) WHERE auto_started;

DROP TRIGGER IF EXISTS automation_runs_updated_at ON public.automation_runs;
CREATE TRIGGER automation_runs_updated_at
  BEFORE UPDATE ON public.automation_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- El usuario solo LEE sus ejecuciones; decide con la RPC de abajo. Solo los
-- triggers (SECURITY DEFINER) y el motor (service role) escriben.
ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.automation_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.automation_runs TO authenticated;
DROP POLICY IF EXISTS "Users can view own automation runs" ON public.automation_runs;
CREATE POLICY "Users can view own automation runs" ON public.automation_runs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- ── 3. Tareas ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sales_tasks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  member_id   UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  rule_id     UUID        REFERENCES public.automation_rules(id) ON DELETE SET NULL,
  run_id      UUID        REFERENCES public.automation_runs(id) ON DELETE SET NULL,
  title       TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  notes       TEXT        CHECK (notes IS NULL OR char_length(notes) <= 2000),
  due_at      TIMESTAMPTZ,
  done_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sales_tasks_open_idx ON public.sales_tasks (user_id, due_at) WHERE done_at IS NULL;
-- Una tarea por (ejecución, lead): reintentar un paso no duplica tareas.
CREATE UNIQUE INDEX IF NOT EXISTS sales_tasks_run_member_key
  ON public.sales_tasks (run_id, COALESCE(member_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE run_id IS NOT NULL;

DROP TRIGGER IF EXISTS sales_tasks_updated_at ON public.sales_tasks;
CREATE TRIGGER sales_tasks_updated_at
  BEFORE UPDATE ON public.sales_tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.sales_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_tasks FROM anon;
DROP POLICY IF EXISTS "Users manage own sales tasks" ON public.sales_tasks;
CREATE POLICY "Users manage own sales tasks" ON public.sales_tasks
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── 4. Decidir (aprobar / rechazar / cancelar) ─────────────────────────────
-- approve: pending_approval → approved (el motor la toma en la próxima pasada)
-- reject:  pending_approval → rejected (con motivo opcional; learning-loop lo agrega)
-- cancel:  queued / approved / running → canceled (lo ya hecho no se deshace)
CREATE OR REPLACE FUNCTION public.decide_automation_runs(p_ids UUID[], p_decision TEXT, p_note TEXT DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_count INTEGER := 0;
  v_note  TEXT := NULLIF(left(btrim(COALESCE(p_note, '')), 500), '');
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN 0; END IF;
  IF cardinality(p_ids) > 500 THEN RAISE EXCEPTION 'too many runs'; END IF;

  IF p_decision = 'approve' THEN
    UPDATE public.automation_runs
       SET status = 'approved', decided_at = NOW(), decision_note = v_note, next_run_at = NOW(), claimed_at = NULL
     WHERE id = ANY (p_ids) AND user_id = v_uid AND status = 'pending_approval';
  ELSIF p_decision = 'reject' THEN
    UPDATE public.automation_runs
       SET status = 'rejected', decided_at = NOW(), decision_note = v_note, finished_at = NOW()
     WHERE id = ANY (p_ids) AND user_id = v_uid AND status = 'pending_approval';
  ELSIF p_decision = 'cancel' THEN
    UPDATE public.automation_runs
       SET status = 'canceled', decided_at = NOW(), decision_note = v_note, finished_at = NOW()
     WHERE id = ANY (p_ids) AND user_id = v_uid AND status IN ('queued', 'approved', 'running');
  ELSE
    RAISE EXCEPTION 'unknown decision %', p_decision;
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.decide_automation_runs(UUID[], TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_automation_runs(UUID[], TEXT, TEXT) TO authenticated;

-- ── 5. Cola del motor ──────────────────────────────────────────────────────
-- Reclamo atómico (FOR UPDATE SKIP LOCKED): el cron y el disparo del
-- navegador pueden correr a la vez sin procesar dos veces la misma ejecución.
CREATE OR REPLACE FUNCTION public.claim_automation_runs(
  p_user_id       UUID,
  p_limit         INTEGER,
  p_lease_seconds INTEGER DEFAULT 240
)
RETURNS SETOF public.automation_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT r.id
      FROM public.automation_runs r
     WHERE r.status IN ('queued', 'approved', 'running')
       AND r.next_run_at <= NOW()
       AND (r.claimed_at IS NULL
            OR r.claimed_at < NOW() - make_interval(secs => GREATEST(p_lease_seconds, 60)))
       AND (p_user_id IS NULL OR r.user_id = p_user_id)
     ORDER BY r.next_run_at, r.id
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 10), 50))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.automation_runs r
     SET claimed_at = NOW(),
         attempts   = r.attempts + 1
    FROM picked
   WHERE r.id = picked.id
  RETURNING r.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_automation_runs(UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_automation_runs(UUID, INTEGER, INTEGER) TO service_role;

-- ── 6. Disparadores ────────────────────────────────────────────────────────
-- Filtro por ids en trigger_config: vacío o ausente = todos.
CREATE OR REPLACE FUNCTION public.automation_id_filter(p_cfg JSONB, p_key TEXT, p_val TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_cfg -> p_key) = 'array' AND jsonb_array_length(p_cfg -> p_key) > 0
      THEN COALESCE(p_val IS NOT NULL AND (p_cfg -> p_key) ? lower(p_val), FALSE)
    ELSE TRUE
  END;
$$;

-- Encola una ejecución por cada regla encendida del usuario que pasa el
-- pre-filtro barato. ON CONFLICT DO NOTHING = idempotencia. Nunca rompe la
-- escritura que la disparó.
CREATE OR REPLACE FUNCTION public.enqueue_automation_runs(
  p_user_id     UUID,
  p_kind        TEXT,
  p_subject_key TEXT,
  p_subject     JSONB,
  p_list_id     UUID    DEFAULT NULL,
  p_detector_id UUID    DEFAULT NULL,
  p_score       INTEGER DEFAULT NULL,
  p_campaign_id UUID    DEFAULT NULL,
  p_skip_rule   UUID    DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;
  INSERT INTO public.automation_runs (user_id, rule_id, trigger_kind, subject_key, subject)
  SELECT r.user_id, r.id, p_kind, p_subject_key, COALESCE(p_subject, '{}'::jsonb)
    FROM public.automation_rules r
   WHERE r.user_id = p_user_id
     AND r.enabled
     AND r.trigger_kind = p_kind
     AND (p_skip_rule IS NULL OR r.id <> p_skip_rule)
     AND public.automation_id_filter(r.trigger_config, 'list_ids', p_list_id::text)
     AND public.automation_id_filter(r.trigger_config, 'detector_ids', p_detector_id::text)
     AND public.automation_id_filter(r.trigger_config, 'campaign_ids', p_campaign_id::text)
     AND (p_score IS NULL
          OR p_score >= COALESCE(CASE WHEN jsonb_typeof(r.trigger_config -> 'min_score') = 'number'
                                      THEN (r.trigger_config ->> 'min_score')::numeric END, 0))
  ON CONFLICT (rule_id, subject_key) DO NOTHING;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'enqueue_automation_runs(%): %', p_kind, SQLERRM;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_automation_runs(UUID, TEXT, TEXT, JSONB, UUID, UUID, INTEGER, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_id_filter(JSONB, TEXT, TEXT) FROM PUBLIC, anon;

-- Señal del Radar: cuando el Radar la ENTREGA (lote diario, surfaced_at), no
-- cuando la guarda en reserva — igual que el evento signal.created de la API.
CREATE OR REPLACE FUNCTION public.automation_on_signal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.surfaced_at IS NOT NULL AND NEW.status <> 'dismissed'
     AND (TG_OP = 'INSERT' OR OLD.surfaced_at IS NULL) THEN
    PERFORM public.enqueue_automation_runs(
      NEW.user_id, 'radar_signal', 'signal:' || NEW.id,
      jsonb_build_object('signal_id', NEW.id, 'detector_id', NEW.detector_id, 'detector_name', NEW.detector_name,
                         'company_name', NEW.company_name, 'company_domain', NEW.company_domain,
                         'headline', left(NEW.headline, 300), 'score', NEW.score),
      NULL, NEW.detector_id, NEW.score, NULL, NULL);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'automation_on_signal: %', SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS automation_signal_ins ON public.radar_signals;
CREATE TRIGGER automation_signal_ins
  AFTER INSERT ON public.radar_signals
  FOR EACH ROW EXECUTE FUNCTION public.automation_on_signal();
DROP TRIGGER IF EXISTS automation_signal_surfaced ON public.radar_signals;
CREATE TRIGGER automation_signal_surfaced
  AFTER UPDATE OF surfaced_at ON public.radar_signals
  FOR EACH ROW EXECUTE FUNCTION public.automation_on_signal();

-- Leads: alta en una lista, «Reunión conseguida», «Reunión tomada».
-- Un lead que creó una automatización no vuelve a disparar ESA regla, y la
-- cadena se corta a los MAX_DEPTH (3) saltos (_shared/automations.ts).
CREATE OR REPLACE FUNCTION public.automation_on_member()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auto  JSONB := CASE WHEN jsonb_typeof(NEW.source -> 'automation') = 'object' THEN NEW.source -> 'automation' END;
  v_depth INTEGER := 0;
  v_rule  UUID;
  v_subj  JSONB;
BEGIN
  v_subj := jsonb_build_object('member_id', NEW.id, 'list_id', NEW.list_id, 'name', NEW.name, 'company', NEW.company);
  IF TG_OP = 'INSERT' THEN
    IF v_auto IS NOT NULL THEN
      IF (v_auto ->> 'depth') ~ '^\d{1,3}$' THEN v_depth := (v_auto ->> 'depth')::int; END IF;
      IF (v_auto ->> 'rule_id') ~* '^[0-9a-f-]{36}$' THEN v_rule := (v_auto ->> 'rule_id')::uuid; END IF;
    END IF;
    IF v_depth < 3 THEN
      PERFORM public.enqueue_automation_runs(NEW.user_id, 'list_lead', 'member:' || NEW.id,
        v_subj || jsonb_build_object('depth', v_depth), NEW.list_id, NULL, NULL, NULL, v_rule);
    END IF;
  ELSIF NEW.contact_status IS DISTINCT FROM OLD.contact_status THEN
    IF NEW.contact_status = 'reunion_agendada' THEN
      PERFORM public.enqueue_automation_runs(NEW.user_id, 'meeting_booked', 'booked:' || NEW.id, v_subj, NEW.list_id);
    ELSIF NEW.contact_status = 'reunion_tomada' THEN
      PERFORM public.enqueue_automation_runs(NEW.user_id, 'meeting_closed', 'closed:' || NEW.id, v_subj, NEW.list_id);
    END IF;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'automation_on_member: %', SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS automation_member_ins ON public.prospect_list_members;
CREATE TRIGGER automation_member_ins
  AFTER INSERT ON public.prospect_list_members
  FOR EACH ROW EXECUTE FUNCTION public.automation_on_member();
DROP TRIGGER IF EXISTS automation_member_status ON public.prospect_list_members;
CREATE TRIGGER automation_member_status
  AFTER UPDATE OF contact_status ON public.prospect_list_members
  FOR EACH ROW EXECUTE FUNCTION public.automation_on_member();

-- Respuestas de la Bandeja: solo entrantes nuevas de un lead guardado (no lo
-- viejo que trae la sincronización de WATI, ni reacciones). Si es positiva o
-- negativa lo decide el motor (classifyReply), no SQL.
CREATE OR REPLACE FUNCTION public.automation_on_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.direction = 'in'
     AND NEW.member_id IS NOT NULL
     AND COALESCE(NEW.sent_at, NOW()) >= NOW() - INTERVAL '10 minutes'
     AND COALESCE(NEW.payload ->> 'type', '') <> 'reaction'
     AND COALESCE(btrim(NEW.body), '') <> '' THEN
    PERFORM public.enqueue_automation_runs(NEW.user_id, 'inbox_reply', 'msg:' || NEW.id,
      jsonb_build_object('message_id', NEW.id, 'member_id', NEW.member_id, 'channel', NEW.channel,
                         'body', left(NEW.body, 2000)));
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'automation_on_message: %', SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS automation_message_ins ON public.inbox_messages;
CREATE TRIGGER automation_message_ins
  AFTER INSERT ON public.inbox_messages
  FOR EACH ROW EXECUTE FUNCTION public.automation_on_message();

-- Campaña terminada sin respuesta.
CREATE OR REPLACE FUNCTION public.automation_on_enrollment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' AND NEW.replied_at IS NULL THEN
    PERFORM public.enqueue_automation_runs(NEW.user_id, 'campaign_no_reply', 'enrollment:' || NEW.id,
      jsonb_build_object('enrollment_id', NEW.id, 'campaign_id', NEW.campaign_id, 'member_id', NEW.member_id),
      NULL, NULL, NULL, NEW.campaign_id);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'automation_on_enrollment: %', SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS automation_enrollment_upd ON public.campaign_enrollments;
CREATE TRIGGER automation_enrollment_upd
  AFTER UPDATE OF status ON public.campaign_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.automation_on_enrollment();

REVOKE ALL ON FUNCTION public.automation_on_signal()     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_on_member()     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_on_message()    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_on_enrollment() FROM PUBLIC, anon, authenticated;

-- ── 7. Cron del motor (ejecutar a mano en el SQL editor DESPUÉS de desplegar
--    automation-run; lleva la service role, por eso no va en la migración) ──
-- SELECT cron.schedule('automation-run', '* * * * *', $cron$
--   SELECT net.http_post(
--     url     := 'https://<project-ref>.supabase.co/functions/v1/automation-run',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'),
--     body    := '{"action":"tick"}'::jsonb,
--     timeout_milliseconds := 150000);
-- $cron$);
