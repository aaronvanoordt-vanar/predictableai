-- ═══════════════════════════════════════════════════════════════════════════
-- LinkedIn vía Dripify (PR 2 de campañas omnicanal) — 2026-09-02
--
-- • campaign_steps.settings: configuración propia del canal. Para LinkedIn
--   guarda {"dripify_campaign_id": 123, "dripify_campaign_name": "…"}: la
--   Open API de Dripify solo permite subir leads a una campaña ya creada en
--   su UI (conexión + mensajes viven allá), así que el paso "LinkedIn" es
--   "enrolar en esa campaña".
-- • campaign_enrollments.provider_refs: ids que devuelve el proveedor
--   ({"dripify_lead_list_id", "dripify_lead_id", "dripify_campaign_id",
--   "dripify_last_action"}) para enlazar el estado que Dripify reporta.
--
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.campaign_steps
  ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}';

ALTER TABLE public.campaign_enrollments
  ADD COLUMN IF NOT EXISTS provider_refs JSONB NOT NULL DEFAULT '{}';

-- Búsqueda del enrolamiento por el id de lead de Dripify (webhook / sync).
CREATE INDEX IF NOT EXISTS campaign_enrollments_dripify_lead_idx
  ON public.campaign_enrollments ((provider_refs->>'dripify_lead_id'))
  WHERE provider_refs ? 'dripify_lead_id';
