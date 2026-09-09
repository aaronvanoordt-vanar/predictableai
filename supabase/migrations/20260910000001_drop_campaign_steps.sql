-- ============================================================================
-- Campañas v2 · Entrega 2: se retira campaign_steps — 2026-09-10
-- ----------------------------------------------------------------------------
-- Desde la Entrega 1 el motor ejecuta el grafo `campaigns.flow`; la tabla
-- campaign_steps solo la escribía el editor viejo (y la migración
-- 20260903000001 ya convirtió cada fila en `flow`). Con el builder gráfico
-- (js/campaign-builder.js) nadie la lee ni la escribe, así que se elimina
-- junto con la función de backfill que dependía de ella.
--
-- Antes de aplicar en producción: comprobar que ninguna campaña quedó sin
-- grafo (la consulta de abajo debe devolver 0). Si devolviera filas, volver a
-- correr `UPDATE campaigns SET flow = campaign_flow_from_steps(id)` sobre
-- ellas ANTES de esta migración.
--
--   SELECT count(*) FROM public.campaigns c
--    WHERE jsonb_array_length(COALESCE(c.flow->'nodes', '[]'::jsonb)) = 0
--      AND EXISTS (SELECT 1 FROM public.campaign_steps s WHERE s.campaign_id = c.id);
-- ============================================================================

DROP FUNCTION IF EXISTS public.campaign_flow_from_steps(UUID);
DROP TABLE IF EXISTS public.campaign_steps;

-- `campaign_enrollments.next_position` se conserva: el motor la sigue
-- escribiendo como ordinal del paso (útil para ordenar y para eventos viejos).
