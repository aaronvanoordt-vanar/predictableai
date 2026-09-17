-- ═══════════════════════════════════════════════════════════════════════════
-- Radar: tope de empresas por run (investigación completa vs. demo rápida)
-- (2026-09-17)
--
-- Una investigación completa es legítimamente lenta: cada consulta de la
-- estrategia es una búsqueda web + una llamada al modelo, y el run sigue
-- hasta llenar su cupo de empresas. Para VER qué hace el Radar eso es
-- demasiado, así que el composer ofrece además una "demo rápida" que corre
-- el mismo pipeline pero se detiene en 5 empresas.
--
--   max_companies  cuántas empresas entrega ESTE run: 20 (completa) o 5
--                  (demo). Viaja en la fila por la misma razón que
--                  news_window_days: cada etapa del run (estrategia,
--                  investigación, decision makers) debe leer el número con
--                  el que el usuario lo arrancó, no el que tenga el
--                  composer cuando la etapa corre. También es lo que fija el
--                  precio en generate-radar (RADAR_DEMO_COST vs.
--                  RADAR_RUN_COST).
--
-- El CHECK es deliberadamente más ancho que la lista que ofrece la UI (hoy
-- 5 y 20): la edge function ya normaliza contra su propia allowlist, y un
-- CHECK cerrado obligaría a una migración nueva cada vez que se ofrezca otro
-- tamaño.
--
-- Idempotente y no destructivo (seguro de re-aplicar). Las filas existentes
-- quedan con el DEFAULT 20, que es exactamente lo que fueron.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.radar_runs
  ADD COLUMN IF NOT EXISTS max_companies INTEGER NOT NULL DEFAULT 20;

DO $$
BEGIN
  ALTER TABLE public.radar_runs
    ADD CONSTRAINT radar_runs_max_companies_check
    CHECK (max_companies BETWEEN 1 AND 50);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
