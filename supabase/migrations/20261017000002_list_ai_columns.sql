-- Columnas de IA en Listas (2026-10-17, hoja de ruta GTM OS §1 ítem 5).
--
-- El usuario agrega a una lista una columna con una pregunta en lenguaje
-- natural («¿vende en Mercado Libre?», «¿cuántas sucursales tiene?») y un tipo
-- de respuesta (sí/no, número, texto corto, categoría de una lista). La edge
-- function ai-columns la responde fila por fila en el servidor, con búsqueda
-- web si la columna lo pide, y guarda la evidencia y la fuente de cada
-- respuesta. Si no encuentra el dato, la celda queda «No encontrado»: nunca se
-- inventa.
--
--   list_ai_columns → la definición (pregunta, tipo, opciones, motor, web)
--   list_ai_cells   → una fila por (columna, contacto): la cola y la respuesta
--
-- La cola vive en las celdas (status 'queued'/'running' + lease), igual que
-- el enriquecimiento de listas (20260923000003): pg_cron llama a ai-columns
-- cada minuto con la service role y el navegador la dispara al encolar.
-- `claim_ai_cells_batch` reclama con FOR UPDATE SKIP LOCKED para que el cron
-- y el disparo del navegador no respondan (ni cobren) dos veces la misma celda.
--
-- Escritura: SOLO la edge function (service role). El cliente lee las dos
-- tablas con RLS por dueño y las ve cambiar por realtime; crear, renombrar,
-- borrar y encolar pasan por ai-columns, que valida la definición
-- (`_shared/ai-columns.ts`) y cobra con reserva y liquidación.

-- ── Definición de columnas ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.list_ai_columns (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  list_id      UUID        NOT NULL REFERENCES public.prospect_lists(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  question     TEXT        NOT NULL CHECK (char_length(question) BETWEEN 5 AND 500),
  answer_type  TEXT        NOT NULL CHECK (answer_type IN ('boolean', 'number', 'text', 'category')),
  options      TEXT[]      NOT NULL DEFAULT '{}',
  use_web      BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Motor elegido para esta columna (NULL = la preferencia del usuario para
  -- `ai_columns`). La edge function lo revalida contra su allowlist.
  engine       TEXT        CHECK (engine IS NULL OR engine IN ('claude', 'openai', 'perplexity')),
  template_key TEXT,
  position     INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT list_ai_columns_category_options CHECK (
    (answer_type = 'category' AND cardinality(options) BETWEEN 2 AND 12)
    OR (answer_type <> 'category' AND cardinality(options) = 0)
  )
);

CREATE INDEX IF NOT EXISTS list_ai_columns_list_idx
  ON public.list_ai_columns (list_id, position, created_at);
CREATE INDEX IF NOT EXISTS list_ai_columns_user_idx
  ON public.list_ai_columns (user_id);

DROP TRIGGER IF EXISTS list_ai_columns_updated_at ON public.list_ai_columns;
CREATE TRIGGER list_ai_columns_updated_at
  BEFORE UPDATE ON public.list_ai_columns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Celdas: cola + respuesta ────────────────────────────────────────────────
--
--   status      queued (en cola) · running (reclamada) · done (respondida)
--               · not_found («No encontrado») · error (motivo en error)
--   value_*     la respuesta normalizada según answer_type (solo en 'done');
--               columnas tipadas para poder filtrar y ordenar en SQL más adelante
--   evidence    qué vio el modelo (≤ 300) · source_url la fuente, si la hay
--   credits     lo que se cobró por esta celda (0 si no se encontró)

CREATE TABLE IF NOT EXISTS public.list_ai_cells (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  column_id    UUID        NOT NULL REFERENCES public.list_ai_columns(id) ON DELETE CASCADE,
  member_id    UUID        NOT NULL REFERENCES public.prospect_list_members(id) ON DELETE CASCADE,
  status       TEXT        NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'done', 'not_found', 'error')),
  value_bool   BOOLEAN,
  value_num    NUMERIC,
  value_text   TEXT        CHECK (value_text IS NULL OR char_length(value_text) <= 200),
  evidence     TEXT        CHECK (evidence IS NULL OR char_length(evidence) <= 300),
  source_url   TEXT        CHECK (source_url IS NULL OR char_length(source_url) <= 500),
  engine       TEXT,
  credits      INTEGER     NOT NULL DEFAULT 0,
  error        TEXT        CHECK (error IS NULL OR char_length(error) <= 300),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at   TIMESTAMPTZ,
  attempts     SMALLINT    NOT NULL DEFAULT 0,
  answered_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT list_ai_cells_column_member_key UNIQUE (column_id, member_id)
);

CREATE INDEX IF NOT EXISTS list_ai_cells_queue_idx
  ON public.list_ai_cells (requested_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS list_ai_cells_member_idx
  ON public.list_ai_cells (member_id);
CREATE INDEX IF NOT EXISTS list_ai_cells_user_idx
  ON public.list_ai_cells (user_id, status);

DROP TRIGGER IF EXISTS list_ai_cells_updated_at ON public.list_ai_cells;
CREATE TRIGGER list_ai_cells_updated_at
  BEFORE UPDATE ON public.list_ai_cells
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS: el dueño lee; solo la service role escribe ─────────────────────────

ALTER TABLE public.list_ai_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.list_ai_cells   ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.list_ai_columns FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.list_ai_cells   FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.list_ai_columns TO authenticated;
GRANT SELECT ON public.list_ai_cells   TO authenticated;
GRANT ALL ON public.list_ai_columns TO service_role;
GRANT ALL ON public.list_ai_cells   TO service_role;

DROP POLICY IF EXISTS "Users can view own AI columns" ON public.list_ai_columns;
CREATE POLICY "Users can view own AI columns"
  ON public.list_ai_columns FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own AI cells" ON public.list_ai_cells;
CREATE POLICY "Users can view own AI cells"
  ON public.list_ai_cells FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ── Realtime: cada celda que termina aparece sola en la tabla ───────────────
-- postgres_changes respeta la RLS: cada suscriptor solo ve sus filas. Las
-- filas son chicas (textos acotados por CHECK), pero la UI igual relee de
-- Postgres en vez de adoptar el payload (regla de CLAUDE.md).

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.list_ai_cells;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.list_ai_columns;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Reclamo atómico de la cola ──────────────────────────────────────────────
-- p_user_id NULL = cualquier usuario (cron). Una celda 'running' cuyo lease
-- venció (la invocación murió) se vuelve a reclamar; attempts cuenta los
-- reclamos para cerrarla con error en vez de reintentarla para siempre.

CREATE OR REPLACE FUNCTION public.claim_ai_cells_batch(
  p_user_id       UUID,
  p_limit         INTEGER,
  p_lease_seconds INTEGER DEFAULT 180
)
RETURNS SETOF public.list_ai_cells
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT c.id
      FROM public.list_ai_cells c
     WHERE (c.status = 'queued'
            OR (c.status = 'running'
                AND c.claimed_at < NOW() - make_interval(secs => GREATEST(p_lease_seconds, 30))))
       AND (p_user_id IS NULL OR c.user_id = p_user_id)
     ORDER BY c.requested_at, c.id
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 6), 30))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.list_ai_cells c
     SET status     = 'running',
         claimed_at = NOW(),
         attempts   = c.attempts + 1
    FROM picked
   WHERE c.id = picked.id
  RETURNING c.*;
END;
$$;

-- Default-deny: solo la edge function (service role) reclama celdas.
REVOKE ALL ON FUNCTION public.claim_ai_cells_batch(UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_cells_batch(UUID, INTEGER, INTEGER) TO service_role;

COMMENT ON TABLE public.list_ai_columns IS
  'Columnas de IA de una lista (Listas → «+ Columna IA»). Escribe solo la edge function ai-columns.';
COMMENT ON TABLE public.list_ai_cells IS
  'Respuesta de una columna de IA para un contacto: cola (queued/running) y resultado (done/not_found/error) con evidencia y fuente.';

-- pg_cron (ejecutar en el SQL editor DESPUÉS de desplegar ai-columns; lleva
-- la service role, por eso no va en la migración):
--
-- SELECT cron.schedule('ai-columns', '* * * * *', $cron$
--   SELECT net.http_post(
--     url     := 'https://<project-ref>.supabase.co/functions/v1/ai-columns',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'),
--     body    := '{"action":"process"}'::jsonb,
--     timeout_milliseconds := 150000);
-- $cron$);
