-- ═══════════════════════════════════════════════════════════════════════════
-- CRM de Latam + HubSpot en dos sentidos (2026-10-17, docs/INTEGRACIONES.md).
--
--   • integration_connections.provider acepta Pipedrive, Kommo, Zoho CRM,
--     Bitrix24 y RD Station CRM.
--   • prospect_list_members guarda lo que el CRM dice del lead:
--       crm_state             — un objeto por plataforma: los ids que el lead
--                                 tiene allá (persona, organización, deal) y,
--                                 para HubSpot, lo que se trajo de vuelta
--                                 (lifecycle, deal, etapa, dueño, synced_at)
--       crm_suppressed_at     — «no contactar»: en el CRM ya es cliente o tiene
--                                 una oportunidad abierta. Enrolar en una campaña
--                                 lo omite y la sincronización pausa los
--                                 enrolamientos activos.
--       crm_suppression_reason— el motivo legible ("Cliente en HubSpot").
--     Los escribe SOLO la edge function `integrations` (service role): el
--     trigger guard_member_crm_columns ignora lo que mande el navegador en estas columnas, así una supresión no se
--     levanta a mano desde el navegador; se levanta cuando cambia en el CRM.
--   • pg_cron (comentado abajo, el dueño lo aplica con su service role):
--     `integrations` acción `cron` cada 15 min — trae los cambios de HubSpot
--     y empuja a cada CRM los leads nuevos de las listas con envío automático.
--
-- Idempotente y no destructiva.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.integration_connections
  DROP CONSTRAINT IF EXISTS integration_connections_provider_check;
ALTER TABLE public.integration_connections
  ADD CONSTRAINT integration_connections_provider_check CHECK (provider IN (
    'hubspot', 'salesforce', 'amplemarket', 'google_sheets',
    'google_calendar', 'notion', 'clickup',
    'pipedrive', 'kommo', 'zoho', 'bitrix24', 'rdstation'));

ALTER TABLE public.prospect_list_members
  ADD COLUMN IF NOT EXISTS crm_state              JSONB,
  ADD COLUMN IF NOT EXISTS crm_suppressed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS crm_suppression_reason TEXT;

-- prospect_list_members es escribible por su dueño (RLS por user_id). En vez
-- de pasar la tabla a GRANTs por columna (cada columna nueva quedaría sin
-- permiso de UPDATE para el navegador), un trigger conserva estas tres
-- columnas cuando quien escribe no es la service role.
CREATE OR REPLACE FUNCTION public.guard_member_crm_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Mismo criterio que protect_enrich_waterfall (20261017000001): solo se
  -- corrige lo que escribe el navegador; la service role (y la RPC de abajo,
  -- SECURITY DEFINER) pasan.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.crm_state := NULL;
    NEW.crm_suppressed_at := NULL;
    NEW.crm_suppression_reason := NULL;
  ELSE
    NEW.crm_state := OLD.crm_state;
    NEW.crm_suppressed_at := OLD.crm_suppressed_at;
    NEW.crm_suppression_reason := OLD.crm_suppression_reason;
  END IF;
  RETURN NEW;
END $$;

REVOKE EXECUTE ON FUNCTION public.guard_member_crm_columns() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS prospect_list_members_guard_crm ON public.prospect_list_members;
CREATE TRIGGER prospect_list_members_guard_crm
  BEFORE INSERT OR UPDATE ON public.prospect_list_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_member_crm_columns();

-- Los que hay que omitir al enrolar (el filtro de la campaña y el de Listas).
CREATE INDEX IF NOT EXISTS prospect_list_members_crm_suppressed_idx
  ON public.prospect_list_members (user_id)
  WHERE crm_suppressed_at IS NOT NULL;

-- Cruce por email con lo que trae el CRM (la sincronización busca por aquí).
CREATE INDEX IF NOT EXISTS prospect_list_members_user_email_idx
  ON public.prospect_list_members (user_id, lower(email))
  WHERE email IS NOT NULL;

-- ── Escritura en lote del estado del CRM ───────────────────────────────────
-- crm_state es un objeto por plataforma: { "hubspot": {…}, "pipedrive":
-- { person_id, org_id, deal_id, url, pushed_at }, … }. Esta función mezcla la
-- clave de UNA plataforma en muchas filas a la vez (sin pisar las de las
-- otras) y, si viene, fija o levanta la supresión. p_rows =
-- [{ "id": <member uuid>, "state": {…}, "suppress": "motivo" | null | ausente }]
-- (ausente = no tocar la supresión). Solo la service role.
CREATE OR REPLACE FUNCTION public.merge_member_crm_state(p_user UUID, p_provider TEXT, p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INTEGER;
BEGIN
  UPDATE public.prospect_list_members m
     SET crm_state = coalesce(m.crm_state, '{}'::jsonb)
                     || jsonb_build_object(p_provider,
                          coalesce(m.crm_state -> p_provider, '{}'::jsonb) || coalesce(r.value -> 'state', '{}'::jsonb)),
         crm_suppressed_at = CASE
           WHEN NOT (r.value ? 'suppress') THEN m.crm_suppressed_at
           WHEN jsonb_typeof(r.value -> 'suppress') = 'string' THEN coalesce(m.crm_suppressed_at, NOW())
           ELSE NULL END,
         crm_suppression_reason = CASE
           WHEN NOT (r.value ? 'suppress') THEN m.crm_suppression_reason
           WHEN jsonb_typeof(r.value -> 'suppress') = 'string' THEN left(r.value ->> 'suppress', 200)
           ELSE NULL END
    FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) AS r(value)
   WHERE m.user_id = p_user
     AND m.id = (r.value ->> 'id')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE EXECUTE ON FUNCTION public.merge_member_crm_state(UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_member_crm_state(UUID, TEXT, JSONB) TO service_role;

-- ── Cron (aplicar a mano con la URL del proyecto y la service role) ────────
-- SELECT cron.schedule('integrations-sync', '*/15 * * * *', $cron$
--   SELECT net.http_post(
--     url     := 'https://<project-ref>.supabase.co/functions/v1/integrations',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'),
--     body    := '{"action":"cron"}'::jsonb,
--     timeout_milliseconds := 150000);
-- $cron$);
