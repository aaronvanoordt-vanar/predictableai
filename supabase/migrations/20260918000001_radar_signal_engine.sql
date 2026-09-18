-- ═══════════════════════════════════════════════════════════════════════════
-- Radar de señales de compra: motor siempre encendido (2026-09-18)
--
-- Hasta hoy el Radar era UNA investigación puntual por noticias (radar_runs:
-- se queda tal cual como "Investigación puntual"). Esta migración le da lo
-- que lo convierte en un producto por el que se paga todos los meses: un
-- PLAN DE SEÑALES con varios DETECTORES (metodologías distintas: noticias,
-- vacantes, tecnografía, financiamiento, cambios de liderazgo, crecimiento,
-- licitaciones, presencia digital, visitantes web) que corren solos por
-- pg_cron y dejan caer empresas con puntaje en un FEED de señales.
--
--   radar_plans      uno por usuario. La hipótesis general, los países
--                    objetivo resueltos desde el contexto de la empresa
--                    (icp_countries, salvo que el prompt diga otra cosa) y
--                    cuándo se sincronizó por última vez con el Hub.
--   radar_detectors  cada metodología concreta, con su config (validada por
--                    _shared/radar-plan.ts), su peso en el puntaje, su
--                    cadencia y su cursor de ejecución. El motor
--                    (radar-monitor) escribe status/cursor/stats; el usuario
--                    solo puede tocar nombre, peso, cadencia, enabled y
--                    config (grants de columna más abajo).
--   radar_signals    una empresa con una señal concreta. fingerprint =
--                    detector + dominio/nombre + titular normalizado, único
--                    por usuario: la misma señal vista dos veces no se
--                    duplica, se marca last_seen_at / times_seen. El usuario
--                    solo cambia status / feedback / list_id.
--
-- Cobro: RADAR_DETECTOR_MONTH créditos por detector activo cada 30 días
-- (billed_until), cobrado por radar-monitor en el primer tick del período;
-- sin saldo el detector queda en status 'no_credits' y no corre.
--
-- Avisos: WhatsApp al teléfono del usuario (profiles.radar_whatsapp_phone)
-- por el tenant de WATI de la PLATAFORMA (secrets RADAR_WATI_*), agrupando
-- las señales nuevas con puntaje ≥ radar_notify_min_score cada
-- radar_notify_every_hours horas.
--
-- Contexto actualizado: intel_hub_intake.radar_suggested_triggers guarda
-- las señales que el plan decidió cazar, para que la tarjeta "Dolores y
-- señales de compra" del contexto las ofrezca con un clic. Nunca pisa
-- icp_buying_triggers si el usuario ya escribió algo.
--
-- Idempotente y no destructivo (seguro de re-aplicar).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── radar_plans ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.radar_plans (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  status              TEXT        NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'active', 'paused')),
  hypothesis          TEXT,
  custom_prompt       TEXT,
  -- Países objetivo resueltos (nombres tal como los usa Apollo, p. ej.
  -- 'Mexico'). Vacío = sin restricción (solo si el contexto no declara).
  countries           TEXT[]      NOT NULL DEFAULT '{}',
  -- Qué versión del contexto y del Hub vio el generador del plan.
  context_hash        TEXT,
  hub_synced_at       TIMESTAMPTZ,
  hub_report_keys     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  generated_at        TIMESTAMPTZ,
  approved_at         TIMESTAMPTZ,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS radar_plans_updated_at ON public.radar_plans;
CREATE TRIGGER radar_plans_updated_at
  BEFORE UPDATE ON public.radar_plans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.radar_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.radar_plans FROM anon, PUBLIC;

DROP POLICY IF EXISTS "radar_plans_select_own" ON public.radar_plans;
CREATE POLICY "radar_plans_select_own" ON public.radar_plans
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- El plan se crea y cambia de estado por la edge function radar-plan
-- (service role): activar/pausar valida créditos y sincroniza el contexto.
-- Los grants por defecto de Supabase darían INSERT/UPDATE/DELETE a
-- authenticated; RLS ya los bloquea (sin políticas), pero se quitan explícitos.
REVOKE INSERT, UPDATE, DELETE ON public.radar_plans FROM authenticated;
GRANT SELECT ON public.radar_plans TO authenticated;

-- ── radar_detectors ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.radar_detectors (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id             UUID        NOT NULL REFERENCES public.radar_plans(id) ON DELETE CASCADE,
  -- Metodología. La allowlist real vive en _shared/radar-plan.ts (espejo
  -- en js/radar-live.js); el CHECK solo evita basura.
  kind                TEXT        NOT NULL
                      CHECK (kind IN ('news', 'hiring', 'technographics', 'site_probe', 'funding',
                                      'leadership', 'growth', 'tenders', 'presence', 'website_visitors')),
  name                TEXT        NOT NULL,
  rationale           TEXT,
  -- Quién lo puso: la IA al generar el plan, el Hub al sincronizar, o el
  -- usuario a mano. Regenerar el plan reemplaza 'ai' y 'hub', nunca 'user'.
  origin              TEXT        NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai', 'hub', 'user')),
  config              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  weight              INTEGER     NOT NULL DEFAULT 60 CHECK (weight BETWEEN 0 AND 100),
  cadence_hours       INTEGER     NOT NULL DEFAULT 24 CHECK (cadence_hours BETWEEN 1 AND 720),
  enabled             BOOLEAN     NOT NULL DEFAULT TRUE,
  status              TEXT        NOT NULL DEFAULT 'idle'
                      CHECK (status IN ('idle', 'running', 'error', 'no_credits', 'unavailable')),
  next_run_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_at         TIMESTAMPTZ,
  last_success_at     TIMESTAMPTZ,
  -- Estado de avance dentro de un ciclo (índice de consulta, página de
  -- Apollo, dominios pendientes de sondear…). Lo escribe solo el motor.
  cursor              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  stats               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  last_error          TEXT,
  billed_until        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS radar_detectors_updated_at ON public.radar_detectors;
CREATE TRIGGER radar_detectors_updated_at
  BEFORE UPDATE ON public.radar_detectors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS radar_detectors_user_idx ON public.radar_detectors (user_id);
CREATE INDEX IF NOT EXISTS radar_detectors_due_idx
  ON public.radar_detectors (next_run_at) WHERE enabled;

ALTER TABLE public.radar_detectors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.radar_detectors FROM anon, PUBLIC;

DROP POLICY IF EXISTS "radar_detectors_select_own" ON public.radar_detectors;
CREATE POLICY "radar_detectors_select_own" ON public.radar_detectors
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "radar_detectors_update_own" ON public.radar_detectors;
CREATE POLICY "radar_detectors_update_own" ON public.radar_detectors
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "radar_detectors_delete_own" ON public.radar_detectors;
CREATE POLICY "radar_detectors_delete_own" ON public.radar_detectors
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Grants de columna: el usuario ajusta SU detector, pero no puede
-- reprogramarlo (next_run_at), "pagarlo" (billed_until) ni tocar el cursor.
REVOKE INSERT, UPDATE ON public.radar_detectors FROM authenticated;
GRANT SELECT, DELETE ON public.radar_detectors TO authenticated;
GRANT UPDATE (name, rationale, config, weight, cadence_hours, enabled)
  ON public.radar_detectors TO authenticated;

-- ── radar_signals ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.radar_signals (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  detector_id         UUID        REFERENCES public.radar_detectors(id) ON DELETE SET NULL,
  detector_kind       TEXT        NOT NULL,
  detector_name       TEXT,

  company_name        TEXT        NOT NULL,
  company_domain      TEXT,
  website             TEXT,
  apollo_org_id       TEXT,
  country             TEXT,
  industry            TEXT,
  employee_count      TEXT,

  headline            TEXT        NOT NULL,
  why_fit             TEXT,
  strength            TEXT        NOT NULL DEFAULT 'media' CHECK (strength IN ('alta', 'media', 'baja')),
  signal_date         DATE,
  evidence            JSONB       NOT NULL DEFAULT '[]'::jsonb, -- [{url, summary, published_at}]
  -- Datos crudos del detector (vacantes, tecnologías, rating…) para la tarjeta.
  facts               JSONB       NOT NULL DEFAULT '{}'::jsonb,

  score               INTEGER     NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  score_breakdown     JSONB       NOT NULL DEFAULT '{}'::jsonb,

  decision_makers     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  decision_maker_titles TEXT[]    NOT NULL DEFAULT '{}',
  dm_status           TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (dm_status IN ('pending', 'ready', 'none', 'skipped')),

  status              TEXT        NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new', 'saved', 'dismissed')),
  feedback            TEXT        CHECK (feedback IN ('useful', 'not_useful')),
  list_id             UUID        REFERENCES public.prospect_lists(id) ON DELETE SET NULL,

  fingerprint         TEXT        NOT NULL,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  times_seen          INTEGER     NOT NULL DEFAULT 1,
  notified_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, fingerprint)
);

DROP TRIGGER IF EXISTS radar_signals_updated_at ON public.radar_signals;
CREATE TRIGGER radar_signals_updated_at
  BEFORE UPDATE ON public.radar_signals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS radar_signals_user_score_idx
  ON public.radar_signals (user_id, status, score DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS radar_signals_dm_pending_idx
  ON public.radar_signals (user_id, first_seen_at) WHERE dm_status = 'pending';
CREATE INDEX IF NOT EXISTS radar_signals_unnotified_idx
  ON public.radar_signals (user_id, score DESC) WHERE notified_at IS NULL AND status = 'new';

ALTER TABLE public.radar_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.radar_signals FROM anon, PUBLIC;

DROP POLICY IF EXISTS "radar_signals_select_own" ON public.radar_signals;
CREATE POLICY "radar_signals_select_own" ON public.radar_signals
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "radar_signals_update_own" ON public.radar_signals;
CREATE POLICY "radar_signals_update_own" ON public.radar_signals
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE ON public.radar_signals FROM authenticated;
GRANT SELECT ON public.radar_signals TO authenticated;
GRANT UPDATE (status, feedback, list_id) ON public.radar_signals TO authenticated;

-- ── Ajustes del usuario ─────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS radar_whatsapp_phone     TEXT,
  ADD COLUMN IF NOT EXISTS radar_notify_min_score   INTEGER NOT NULL DEFAULT 70,
  ADD COLUMN IF NOT EXISTS radar_notify_every_hours INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS radar_notified_at        TIMESTAMPTZ;

DO $$
BEGIN
  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_radar_notify_min_score_check
    CHECK (radar_notify_min_score BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_radar_notify_every_hours_check
    CHECK (radar_notify_every_hours BETWEEN 1 AND 168);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Señales que el plan decidió cazar, ofrecidas en el contexto de la empresa.
ALTER TABLE public.intel_hub_intake
  ADD COLUMN IF NOT EXISTS radar_suggested_triggers TEXT[] NOT NULL DEFAULT '{}';

-- ── Realtime: el feed y el plan se pintan en vivo ───────────────────────────

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.radar_signals;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.radar_detectors;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── pg_cron (paso manual, igual que el Intelligence Hub y campaign-run) ─────
-- El motor corre cada 2 minutos con la service role. Cada invocación hace
-- pocas unidades de trabajo acotadas (una consulta / una página / un lote de
-- sondeos) y vuelve, porque el Edge Runtime mata cualquier invocación a los
-- ~150 s. Ejecutar en el SQL editor DESPUÉS de desplegar radar-monitor:
--
-- SELECT cron.schedule('radar-monitor', '*/2 * * * *', $cron$
--   SELECT net.http_post(
--     url     := 'https://<project-ref>.supabase.co/functions/v1/radar-monitor',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'),
--     body    := '{"mode":"cron"}'::jsonb,
--     timeout_milliseconds := 150000);
-- $cron$);
