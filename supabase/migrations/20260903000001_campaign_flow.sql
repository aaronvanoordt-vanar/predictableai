-- ═══════════════════════════════════════════════════════════════════════════
-- Campañas v2: la cadencia como grafo (`campaigns.flow`) — 2026-09-03
--
-- Ver docs/CAMPAIGN_BUILDER_PLAN.md. Resumen:
--   • campaigns.flow          — el grafo {v:1, nodes:[…]} (acciones y
--     condiciones con ramas Sí/No). Esquema y validación en
--     supabase/functions/_shared/campaign-flow.ts ↔ js/campaign-flow.js.
--   • campaigns.review_required — los mensajes IA esperan aprobación humana.
--   • campaigns.origin        — de dónde salió la cadencia (ai / template:x /
--     clone / scratch / legacy).
--   • campaign_enrollments.next_node_id / last_action_at / branch_path —
--     dónde está cada lead en el grafo (next_position se sigue manteniendo
--     como ordinal de la acción, por compatibilidad y como respaldo).
--   • campaign_events.node_id + tipos nuevos `opened` (email abierto, lo lee
--     el motor desde Apollo), `generated` (mensaje IA listo) y `branched`
--     (qué rama tomó el lead en una condición).
--   • campaign_messages       — el mensaje IA de cada paso para cada lead.
--     Lo escribe el motor (service role); el cliente lo lee y solo puede
--     editar texto y aprobar (draft → approved).
--   • Backfill: cada campaña existente recibe su `flow` derivado de
--     campaign_steps (offset absoluto → espera relativa; mismo offset →
--     with_prev; `if_connected` consecutivos → una condición con esos pasos
--     en la rama Sí; `if_no_reply` desaparece porque la regla de parada ya
--     lo cubre). Los enrolamientos activos reciben next_node_id.
--   • campaign_steps se conserva (el editor actual lo sigue escribiendo
--     junto con flow). Se elimina cuando entre el builder nuevo.
--
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Columnas nuevas ──────────────────────────────────────────────────────
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS flow            JSONB   NOT NULL DEFAULT '{"v":1,"nodes":[]}',
  ADD COLUMN IF NOT EXISTS review_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS origin          TEXT;

ALTER TABLE public.campaign_enrollments
  ADD COLUMN IF NOT EXISTS next_node_id   TEXT,
  ADD COLUMN IF NOT EXISTS last_action_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS branch_path    JSONB NOT NULL DEFAULT '[]';

ALTER TABLE public.campaign_events
  ADD COLUMN IF NOT EXISTS node_id TEXT;

ALTER TABLE public.campaign_events DROP CONSTRAINT IF EXISTS campaign_events_type_check;
ALTER TABLE public.campaign_events
  ADD CONSTRAINT campaign_events_type_check
  CHECK (type IN ('queued', 'sent', 'delivered', 'read', 'replied', 'failed', 'skipped',
                  'opted_out', 'connection_sent', 'connection_accepted', 'stopped', 'completed',
                  'opened', 'generated', 'branched'));

CREATE INDEX IF NOT EXISTS campaign_events_enrollment_type_idx
  ON public.campaign_events (enrollment_id, type);

-- ── 2. Mensajes IA por paso ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.campaign_messages (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID        NOT NULL REFERENCES public.campaign_enrollments(id) ON DELETE CASCADE,
  campaign_id   UUID        NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  member_id     UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  node_id       TEXT        NOT NULL,
  channel       TEXT        NOT NULL CHECK (channel IN ('whatsapp', 'email', 'linkedin')),
  angle         TEXT,
  subject       TEXT,
  body          TEXT,
  -- draft    → generado, espera aprobación (campaigns.review_required)
  -- approved → listo para que el motor lo envíe
  -- sent     → enviado
  -- skipped  → el paso se omitió (sin sesión de WhatsApp, etc.)
  -- error    → la generación falló (error_detail); el paso se omite con ese motivo
  status        TEXT        NOT NULL DEFAULT 'approved'
                CHECK (status IN ('draft', 'approved', 'sent', 'skipped', 'error')),
  error_detail  TEXT,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at   TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_messages_enrollment_node_key UNIQUE (enrollment_id, node_id)
);

DROP TRIGGER IF EXISTS campaign_messages_updated_at ON public.campaign_messages;
CREATE TRIGGER campaign_messages_updated_at
  BEFORE UPDATE ON public.campaign_messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.campaign_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own campaign messages" ON public.campaign_messages;
CREATE POLICY "Users can view own campaign messages"
  ON public.campaign_messages FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- El cliente solo edita texto y aprueba: nunca cambia dueño, enrolamiento ni
-- marca como enviado (eso es del motor).
DROP POLICY IF EXISTS "Users can review own campaign messages" ON public.campaign_messages;
CREATE POLICY "Users can review own campaign messages"
  ON public.campaign_messages FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id AND status IN ('draft', 'approved'))
  WITH CHECK (auth.uid() = user_id AND status IN ('draft', 'approved', 'skipped'));

REVOKE ALL ON public.campaign_messages FROM anon, PUBLIC;
GRANT SELECT ON public.campaign_messages TO authenticated;
GRANT UPDATE (subject, body, status, approved_at) ON public.campaign_messages TO authenticated;

CREATE INDEX IF NOT EXISTS campaign_messages_campaign_status_idx
  ON public.campaign_messages (campaign_id, status);

-- Realtime: la bandeja de revisión se actualiza en vivo.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'campaign_messages'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.campaign_messages;
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'realtime publication: %', SQLERRM;
END $$;

-- ── 3. Backfill: campaign_steps → flow ──────────────────────────────────────
-- Misma lógica que fromLegacySteps() en campaign-flow.ts. Ids deterministas
-- a partir del id de la fila (n + 8 hex de md5) para que un re-run dé lo mismo.
CREATE OR REPLACE FUNCTION public.campaign_flow_from_steps(p_campaign_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  s            RECORD;
  nodes        JSONB := '[]'::jsonb;
  open_cond    JSONB := NULL;
  prev_offset  INTEGER := 0;
  idx          INTEGER := 0;
  ai_seen      TEXT[] := '{}';
  ch_key       TEXT;
  kind         TEXT;
  angle        TEXT;
  content      JSONB;
  node         JSONB;
  delay        JSONB;
  delta        INTEGER;
  is_cond      BOOLEAN;
  with_prev    BOOLEAN;
BEGIN
  FOR s IN
    SELECT * FROM public.campaign_steps
    WHERE campaign_id = p_campaign_id
    ORDER BY position, offset_hours
  LOOP
    kind := CASE WHEN s.content_kind = 'ai_personalized' THEN 'ai'
                 WHEN s.content_kind IN ('template_a','template_b','template_c','custom') THEN s.content_kind
                 ELSE 'ai' END;
    content := jsonb_build_object('kind', kind);
    IF kind = 'ai' THEN
      ch_key := CASE WHEN s.channel LIKE 'linkedin%' THEN 'linkedin' ELSE s.channel END;
      angle := CASE WHEN ch_key = ANY(ai_seen) THEN 'valor' ELSE 'apertura' END;
      ai_seen := array_append(ai_seen, ch_key);
      content := content || jsonb_build_object('angle', angle);
    ELSIF kind = 'custom' THEN
      content := content || jsonb_build_object('subject', COALESCE(btrim(s.subject), ''), 'body', COALESCE(btrim(s.body), ''));
    END IF;

    is_cond := (s.condition = 'if_connected');
    with_prev := idx > 0
             AND GREATEST(0, s.offset_hours) = prev_offset
             AND NOT (is_cond AND open_cond IS NULL)
             AND NOT (open_cond IS NOT NULL AND NOT is_cond);
    delta := GREATEST(0, GREATEST(0, s.offset_hours) - prev_offset);
    delay := CASE WHEN with_prev
                  THEN jsonb_build_object('mode', 'with_prev', 'days', 0, 'hours', 0)
                  ELSE jsonb_build_object('mode', 'after_prev', 'days', delta / 24, 'hours', delta % 24) END;

    node := jsonb_build_object(
      'id', 'n' || substr(md5(s.id::text), 1, 8),
      'type', 'action',
      'channel', s.channel,
      'delay', delay,
      'content', content
    );
    IF s.settings IS NOT NULL AND s.settings <> '{}'::jsonb THEN
      node := node || jsonb_build_object('settings', s.settings);
    END IF;

    IF is_cond THEN
      IF open_cond IS NULL THEN
        open_cond := jsonb_build_object(
          'id', 'c' || substr(md5(s.id::text), 1, 8),
          'type', 'condition',
          'check', 'linkedin_connected',
          'delay', jsonb_build_object('mode', 'after_prev', 'days', 0, 'hours', 0),
          'yes', '[]'::jsonb,
          'no', '[]'::jsonb
        );
        nodes := nodes || jsonb_build_array(open_cond);
      END IF;
      open_cond := jsonb_set(open_cond, '{yes}', (open_cond->'yes') || jsonb_build_array(node));
      nodes := jsonb_set(nodes, ARRAY[(jsonb_array_length(nodes) - 1)::text], open_cond);
    ELSE
      open_cond := NULL;
      nodes := nodes || jsonb_build_array(node);
    END IF;

    prev_offset := GREATEST(0, s.offset_hours);
    idx := idx + 1;
  END LOOP;
  RETURN jsonb_build_object('v', 1, 'nodes', nodes);
END;
$$;

REVOKE ALL ON FUNCTION public.campaign_flow_from_steps(UUID) FROM PUBLIC, anon, authenticated;

-- Solo campañas que aún no tienen grafo (idempotente).
UPDATE public.campaigns c
SET flow = public.campaign_flow_from_steps(c.id),
    origin = COALESCE(c.origin, 'legacy')
WHERE jsonb_array_length(COALESCE(c.flow->'nodes', '[]'::jsonb)) = 0
  AND EXISTS (SELECT 1 FROM public.campaign_steps s WHERE s.campaign_id = c.id);

-- Enrolamientos en curso: apuntan al nodo equivalente a su paso pendiente.
-- Si ese paso estaba condicionado (if_connected), apuntan a la condición para
-- que el motor la evalúe igual que antes.
UPDATE public.campaign_enrollments e
SET next_node_id = CASE WHEN s.condition = 'if_connected'
                        THEN 'c' || substr(md5(s.id::text), 1, 8)
                        ELSE 'n' || substr(md5(s.id::text), 1, 8) END
FROM public.campaign_steps s
WHERE e.next_node_id IS NULL
  AND s.campaign_id = e.campaign_id
  AND s.position = e.next_position
  AND e.status IN ('active', 'paused', 'processing', 'error');

-- Un paso if_connected en medio de una condición ya abierta comparte el id de
-- la condición del PRIMER paso del grupo: corregirlo para esos casos.
UPDATE public.campaign_enrollments e
SET next_node_id = sub.cond_id
FROM (
  SELECT e2.id AS enrollment_id,
         (SELECT n->>'id' FROM jsonb_array_elements(c.flow->'nodes') n
           WHERE n->>'type' = 'condition'
             AND EXISTS (SELECT 1 FROM jsonb_array_elements(n->'yes') y
                          WHERE y->>'id' = 'n' || substr(md5(s.id::text), 1, 8))
           LIMIT 1) AS cond_id
  FROM public.campaign_enrollments e2
  JOIN public.campaigns c ON c.id = e2.campaign_id
  JOIN public.campaign_steps s ON s.campaign_id = e2.campaign_id AND s.position = e2.next_position
  WHERE s.condition = 'if_connected'
) sub
WHERE e.id = sub.enrollment_id AND sub.cond_id IS NOT NULL AND e.next_node_id <> sub.cond_id;
