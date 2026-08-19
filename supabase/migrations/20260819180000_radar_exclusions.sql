-- ═══════════════════════════════════════════════════════════════════════════
-- Radar: memoria de empresas ya conocidas (2026-08-19)
--
-- Cada investigación del Radar gastaba búsquedas web (y tokens) volviendo a
-- descubrir las mismas empresas que el vendedor ya tenía guardadas en sus
-- listas de Prospección o que un Radar anterior ya le había entregado.
--
-- Ahora el usuario elige, antes de lanzar la investigación, qué listas
-- guardadas (y los radares anteriores) cuentan como "ya conocidas".
-- generate-radar resuelve esas listas a nombres de empresa con el service
-- role (scoped al dueño), los guarda aquí y los inyecta en el prompt de
-- research como exclusiones — además de filtrarlos del resultado.
--
--   exclude_list_ids    : las prospect_lists que el usuario marcó (auditoría)
--   excluded_companies  : nombres de empresa resueltos en el momento de crear
--                         el run (snapshot; las listas cambian con el tiempo)
--
-- Idempotente y no destructivo (seguro de re-aplicar).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.radar_runs
  ADD COLUMN IF NOT EXISTS exclude_list_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS excluded_companies JSONB NOT NULL DEFAULT '[]'::jsonb;
