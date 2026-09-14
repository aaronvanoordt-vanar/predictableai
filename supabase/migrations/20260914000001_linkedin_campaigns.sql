-- ═══════════════════════════════════════════════════════════════════════════
-- Campañas de LinkedIn diseñadas en Predictable — 2026-09-14
--
-- La Open API de Dripify (comprobada el 2026-09-14 en api.dripify.com) no
-- tiene endpoint para CREAR campañas ni para enviar mensajes: solo lista
-- campañas y sube leads a una que ya exista (POST /campaigns/{id}/leads).
-- Por eso la campaña de LinkedIn se diseña aquí (nombre, nota de conexión y
-- secuencia de mensajes con esperas) y se VINCULA a la campaña que el
-- usuario crea en Dripify con el mismo nombre: el vínculo lo cierra el
-- cliente ("Vincular") o el motor campaign-run solo, releyendo la lista de
-- campañas de Dripify cuando un paso de LinkedIn apunta a una campaña de
-- Predictable todavía sin vincular. A partir de ahí el enrolamiento de
-- leads sí es automático.
--
-- `campaigns.flow` → nodo linkedin_connect → settings.linkedin_campaign_id
-- (uuid de esta tabla) y/o settings.dripify_campaign_id (id numérico de
-- Dripify). La validación del grafo acepta cualquiera de los dos.
--
-- RLS: CRUD del dueño (igual que campaigns). Sin grants a anon.
-- Idempotente (seguro de re-aplicar).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.linkedin_campaigns (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name                  TEXT        NOT NULL,
  -- Nota que acompaña la solicitud de conexión (LinkedIn admite ≤ 300 caracteres).
  connection_note       TEXT        NOT NULL DEFAULT '',
  -- Secuencia: [{ "type": "visit"|"connect"|"message"|"follow", "delay_days": n, "text": "…" }]
  steps                 JSONB       NOT NULL DEFAULT '[]',
  -- draft            → recién diseñada
  -- pending_dripify  → publicada: falta crearla en Dripify con el mismo nombre
  -- linked           → vinculada a una campaña real de Dripify (dripify_campaign_id)
  status                TEXT        NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'pending_dripify', 'linked')),
  dripify_campaign_id   BIGINT,
  dripify_campaign_name TEXT,
  linked_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS linkedin_campaigns_user_idx
  ON public.linkedin_campaigns (user_id, created_at DESC);

ALTER TABLE public.linkedin_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own linkedin_campaigns" ON public.linkedin_campaigns;
CREATE POLICY "Users can view own linkedin_campaigns"
  ON public.linkedin_campaigns FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own linkedin_campaigns" ON public.linkedin_campaigns;
CREATE POLICY "Users can insert own linkedin_campaigns"
  ON public.linkedin_campaigns FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own linkedin_campaigns" ON public.linkedin_campaigns;
CREATE POLICY "Users can update own linkedin_campaigns"
  ON public.linkedin_campaigns FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own linkedin_campaigns" ON public.linkedin_campaigns;
CREATE POLICY "Users can delete own linkedin_campaigns"
  ON public.linkedin_campaigns FOR DELETE TO authenticated USING (auth.uid() = user_id);

REVOKE ALL ON public.linkedin_campaigns FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.linkedin_campaigns TO authenticated;
