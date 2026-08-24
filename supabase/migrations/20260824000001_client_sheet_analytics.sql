-- ═══════════════════════════════════════════════════════════════════════════
-- Client sheet analytics (2026-08-24)
--
-- El portal del cliente (client.html?token=…) deja de depender de métricas
-- tecleadas a mano: ahora lee el Google Sheets que ya tenía embebido.
--
--   • Pestaña "Métricas"  → los totales acumulados (enviados / leídos /
--     respondidos / agendadas / tomadas / no shows / descalificadas) y las
--     metas de pipeline por mes.
--   • Pestaña "CRM"       → una fila por prospecto, con columna "Date" y
--     "Status". Es la única fuente con fecha, así que es la que permite
--     filtrar por período.
--
-- Los totales de la pestaña Métricas NO tienen fecha por fila, así que para
-- poder filtrarlos guardamos una FOTO DIARIA (client_metric_snapshots) y el
-- volumen de un período se calcula como la diferencia entre la foto del
-- inicio y la del final. Con una sola foto todavía no hay delta: la UI lo
-- dice explícitamente en vez de inventar un número.
--
-- PII: de la pestaña CRM se guardan SOLO las dimensiones que alimentan los
-- gráficos (empresa, cargo, código de país, canal, status, fecha, feedback).
-- Nombre, email y teléfono del prospecto NO se copian a Postgres — se quedan
-- en el sheet. Menos superficie que proteger y el portal no los necesita.
--
-- Todas las sentencias son idempotentes y no destructivas.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Columnas nuevas en clients ─────────────────────────────────────────────

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS crm_sheet_tab      TEXT,     -- nombre de la pestaña CRM (NULL = autodetectar)
  ADD COLUMN IF NOT EXISTS metrics_sheet_tab  TEXT,     -- nombre de la pestaña de métricas (NULL = autodetectar)
  ADD COLUMN IF NOT EXISTS sheet_sync_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS review_next_steps  TEXT;     -- acuerdos / próximos pasos de la última reunión

COMMENT ON COLUMN public.clients.crm_sheet_tab IS
  'Nombre exacto de la pestaña con la base de prospectos. NULL = se autodetecta probando CRM, Base de datos, Prospectos…';
COMMENT ON COLUMN public.clients.metrics_sheet_tab IS
  'Nombre exacto de la pestaña con los totales de campaña. NULL = se autodetecta probando Métricas, Metricas, Dashboard…';
COMMENT ON COLUMN public.clients.review_next_steps IS
  'Acuerdos y próximos pasos de la revisión. Editable por el equipo y por el cliente desde el portal.';

-- ── Estado del último sync (una fila por cliente) ──────────────────────────

CREATE TABLE IF NOT EXISTS public.client_sheet_state (
  client_id       UUID        PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
  synced_at       TIMESTAMPTZ,
  ok              BOOLEAN     NOT NULL DEFAULT FALSE,
  error           TEXT,
  crm_tab         TEXT,
  metrics_tab     TEXT,
  -- { contacted, opened, replied, meetings_scheduled, meetings_held,
  --   no_shows, disqualified } tal como se leyeron de la pestaña Métricas.
  headline        JSONB       NOT NULL DEFAULT '{}',
  -- { goals: [{ period, pipeline, meetings, accumulated }], achieved: [...],
  --   currency } leído del bloque PIPELINE de la pestaña Métricas.
  pipeline        JSONB       NOT NULL DEFAULT '{}',
  row_count       INT         NOT NULL DEFAULT 0,
  dated_row_count INT         NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS client_sheet_state_updated_at ON public.client_sheet_state;
CREATE TRIGGER client_sheet_state_updated_at
  BEFORE UPDATE ON public.client_sheet_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Filas normalizadas de la pestaña CRM ───────────────────────────────────
-- Se reemplazan por completo en cada sync (delete + insert): el sheet manda.

CREATE TABLE IF NOT EXISTS public.client_crm_rows (
  id           BIGSERIAL   PRIMARY KEY,
  client_id    UUID        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  row_index    INT         NOT NULL,
  company      TEXT,
  title        TEXT,
  country_code TEXT,       -- código telefónico tal cual viene ("52", "57"…)
  country      TEXT,       -- nombre resuelto a partir del código
  channel      TEXT,       -- WhatsApp / LinkedIn / Email / Llamada / Otro
  status       TEXT,       -- texto original del sheet
  status_key   TEXT,       -- normalizado: reunion_tomada, no_show, follow_up…
  event_date   DATE,       -- columna "Date"/"Fecha" del sheet
  feedback     TEXT
);

CREATE INDEX IF NOT EXISTS client_crm_rows_client_idx ON public.client_crm_rows (client_id);
CREATE INDEX IF NOT EXISTS client_crm_rows_client_date_idx ON public.client_crm_rows (client_id, event_date);

-- ── Foto diaria de los totales (para deltas por período) ───────────────────

CREATE TABLE IF NOT EXISTS public.client_metric_snapshots (
  client_id     UUID        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  snapshot_date DATE        NOT NULL,
  headline      JSONB       NOT NULL DEFAULT '{}',
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, snapshot_date)
);

-- ── Revisiones generadas (narrativa IA + métricas congeladas) ──────────────

CREATE TABLE IF NOT EXISTS public.client_reviews (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  range_from DATE,
  range_to   DATE,
  preset     TEXT,
  engine     TEXT,
  metrics    JSONB       NOT NULL DEFAULT '{}',
  -- { summary, business_case, highlights[], alerts[], hypotheses[],
  --   solutions[], next_steps[] }
  narrative  JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS client_reviews_client_idx
  ON public.client_reviews (client_id, created_at DESC);

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Default-deny. El portal del cliente NO entra por aquí: llega por la edge
-- function client-portal con service role, que valida el share_token. `anon`
-- no gana ningún permiso nuevo sobre la base.

ALTER TABLE public.client_sheet_state      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_crm_rows         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_metric_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_reviews          ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "client_sheet_state_select" ON public.client_sheet_state;
CREATE POLICY "client_sheet_state_select"
  ON public.client_sheet_state FOR SELECT
  TO authenticated
  USING (public.can_view_client(client_id));

DROP POLICY IF EXISTS "client_crm_rows_select" ON public.client_crm_rows;
CREATE POLICY "client_crm_rows_select"
  ON public.client_crm_rows FOR SELECT
  TO authenticated
  USING (public.can_view_client(client_id));

DROP POLICY IF EXISTS "client_metric_snapshots_select" ON public.client_metric_snapshots;
CREATE POLICY "client_metric_snapshots_select"
  ON public.client_metric_snapshots FOR SELECT
  TO authenticated
  USING (public.can_view_client(client_id));

DROP POLICY IF EXISTS "client_reviews_select" ON public.client_reviews;
CREATE POLICY "client_reviews_select"
  ON public.client_reviews FOR SELECT
  TO authenticated
  USING (public.can_view_client(client_id));

DROP POLICY IF EXISTS "client_reviews_delete" ON public.client_reviews;
CREATE POLICY "client_reviews_delete"
  ON public.client_reviews FOR DELETE
  TO authenticated
  USING (public.can_manage_client(client_id));

-- Escritura: solo la service role (edge functions sheet-sync / client-portal).
-- Sin políticas de INSERT/UPDATE para `authenticated`, RLS las bloquea.

REVOKE ALL ON public.client_sheet_state      FROM anon, PUBLIC;
REVOKE ALL ON public.client_crm_rows         FROM anon, PUBLIC;
REVOKE ALL ON public.client_metric_snapshots FROM anon, PUBLIC;
REVOKE ALL ON public.client_reviews          FROM anon, PUBLIC;

GRANT SELECT ON public.client_sheet_state      TO authenticated;
GRANT SELECT ON public.client_crm_rows         TO authenticated;
GRANT SELECT ON public.client_metric_snapshots TO authenticated;
GRANT SELECT, DELETE ON public.client_reviews  TO authenticated;

REVOKE ALL ON SEQUENCE public.client_crm_rows_id_seq FROM anon, PUBLIC;
