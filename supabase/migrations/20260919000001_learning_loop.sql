-- ═══════════════════════════════════════════════════════════════════════════
-- Bucle de aprendizaje (2026-09-19)
--
-- Cierra el ciclo "resultado → aprendizaje → acción" que antes no existía en
-- ningún módulo (auditoría 2026-09-18): el Radar solo movía un peso desde el
-- navegador, las campañas no calculaban ninguna tasa, el coach guardaba el
-- resultado de la reunión sin que nada lo leyera y la prospección no sabía qué
-- búsqueda o señal había producido cada lead.
--
--   learning_insights   una fila por (usuario, ámbito, clave) con las métricas
--                       calculadas, el veredicto (funciona / neutro / falla /
--                       insuficiente) y la acción automática que aplicó el
--                       bucle. Solo la escribe la edge function `learning-loop`
--                       (service role); el usuario la lee.
--   prospect_list_members.source
--                       procedencia del lead ({kind: search|radar|manual|import,
--                       detector_id?, signal_id?, saved_search_id?}) para poder
--                       atribuir respuestas y reuniones a lo que lo encontró.
--
-- Qué hace el bucle con cada ámbito (detalle en docs/REVENUE_OS_REVIEW.md):
--   radar_detector  peso = f(útil / guardada vs. descartada / no útil, respuestas
--                   y reuniones de los leads que salieron de ahí); un detector
--                   que falla se apaga solo (radar_detectors.enabled = false,
--                   stats.auto_paused) y se puede volver a encender a mano.
--   campaign_node   tasa de respuesta por paso; un paso sin respuestas cuando
--                   el resto de la campaña sí responde se pausa
--                   (campaigns.flow → settings.learning.paused) y el motor lo
--                   omite; el usuario lo reactiva desde el detalle.
--   channel / angle tasa de respuesta por canal y por ángulo de mensaje IA.
--   winning_message los mensajes que sí obtuvieron respuesta, por canal:
--                   generate-outreach los recibe como ejemplos a imitar.
--   objection       objeciones reales de las reuniones con la respuesta que
--                   funcionó en las ganadas: el coach en vivo y el reporte las
--                   reciben como playbook.
--   icp_attribute   cargo / país / industria / tamaño con su tasa de respuesta
--                   frente al promedio: se muestran en el Contexto como
--                   sugerencia, nunca pisan el ICP declarado.
--   summary         titulares para el dashboard.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.learning_insights (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope        TEXT        NOT NULL
               CHECK (scope IN ('radar_detector', 'campaign_node', 'campaign', 'channel', 'angle',
                                'winning_message', 'objection', 'icp_attribute', 'summary')),
  key          TEXT        NOT NULL,
  label        TEXT,
  metrics      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  verdict      TEXT        NOT NULL DEFAULT 'insufficient'
               CHECK (verdict IN ('works', 'neutral', 'fails', 'insufficient')),
  action       TEXT,                 -- qué aplicó el bucle solo (texto para la UI)
  action_at    TIMESTAMPTZ,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT learning_insights_user_scope_key UNIQUE (user_id, scope, key)
);

CREATE INDEX IF NOT EXISTS learning_insights_user_scope_idx
  ON public.learning_insights (user_id, scope, verdict);

DROP TRIGGER IF EXISTS learning_insights_updated_at ON public.learning_insights;
CREATE TRIGGER learning_insights_updated_at
  BEFORE UPDATE ON public.learning_insights
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.learning_insights ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.learning_insights FROM anon, PUBLIC;

DROP POLICY IF EXISTS "learning_insights_select_own" ON public.learning_insights;
CREATE POLICY "learning_insights_select_own" ON public.learning_insights
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Solo la service role escribe (learning-loop). Sin políticas de escritura y
-- sin grants: el cliente no puede fabricar veredictos.
REVOKE INSERT, UPDATE, DELETE ON public.learning_insights FROM authenticated;
GRANT SELECT ON public.learning_insights TO authenticated;

-- ── Procedencia del lead ────────────────────────────────────────────────────
ALTER TABLE public.prospect_list_members
  ADD COLUMN IF NOT EXISTS source JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.prospect_list_members.source IS
  'Qué encontró al lead: {kind: search|radar|manual|import|inbox, detector_id?, signal_id?, saved_search_id?}. Lo usa learning-loop para atribuir respuestas y reuniones.';

-- ── Última corrida del bucle (para la tarjeta del dashboard) ────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS learning_last_run_at TIMESTAMPTZ;

-- ── Cron diario (ejecutar a mano en el SQL editor, con la URL del proyecto y
--    la service role; igual que radar-monitor) ─────────────────────────────
-- SELECT cron.schedule('learning-loop', '15 6 * * *', $cron$
--   SELECT net.http_post(
--     url := 'https://<project-ref>.supabase.co/functions/v1/learning-loop',
--     headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <SUPABASE_SERVICE_ROLE_KEY>'),
--     body := '{"action":"recompute_all"}'::jsonb,
--     timeout_milliseconds := 150000);
-- $cron$);
