-- ═══════════════════════════════════════════════════════════════════════════
-- CRM nativo ↔ CRM externo — 2026-10-19 (sigue a #356 y a #363)
--
-- #356 conecta Pipedrive, Kommo, Zoho CRM, Bitrix24, RD Station y HubSpot y
-- guarda en prospect_list_members.crm_state lo que el CRM externo dice del
-- lead. Esta migración deja que esa sincronización escriba en los objetos del
-- CRM nativo (migración 20261017100001) en vez de solo en el lead:
--
--   • crm_opportunities.external_data — lo que hace falta para hablar con el
--     deal externo sin volver a buscarlo: pipeline y etapa externos, la URL
--     del registro y la última etapa externa vista. Solo la escribe la
--     service role (vía las RPC de abajo).
--   • crm_apply_external_opportunities(user, rows) — inserta o actualiza
--     oportunidades por (user_id, external_source, external_id) con el actor
--     'integration' (stage_changed_by), así el historial dice que la movió la
--     integración y el empuje de vuelta no la reenvía. external_synced_at se
--     sella con clock_timestamp(), siempre después de stage_changed_at.
--     La decisión de QUÉ escribir (mapeo de etapas, conflictos) la toma
--     _shared/crm-native.ts (deno test); esta función solo aplica.
--   • crm_mark_opportunities_synced(user, rows) — sella external_synced_at y
--     external_data después de empujar un cambio al CRM externo.
--   • crm_link_external_companies(user, rows) — enlaza una cuenta nativa con
--     la organización / empresa externa (external_source + external_id).
--     Nunca pisa el enlace con otra fuente ni duplica un id externo.
--
-- Todas son service role only. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.crm_opportunities
  ADD COLUMN IF NOT EXISTS external_data JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.crm_opportunities.external_data IS
  'Datos del deal externo (pipeline_id, stage_id, stage_label, url, status). Solo lo escribe la integración (service role).';

-- El navegador no escribe external_data: lo conserva el trigger de validación
-- de abajo (las demás columnas siguen igual de editables por el dueño).
CREATE OR REPLACE FUNCTION public.crm_protect_external_data()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.external_data := '{}'::jsonb;
    ELSE
      NEW.external_data := OLD.external_data;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_protect_external_data() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_opportunities_protect_external ON public.crm_opportunities;
CREATE TRIGGER crm_opportunities_protect_external
  BEFORE INSERT OR UPDATE ON public.crm_opportunities
  FOR EACH ROW EXECUTE FUNCTION public.crm_protect_external_data();

CREATE INDEX IF NOT EXISTS crm_opportunities_external_push_idx
  ON public.crm_opportunities (user_id, external_source)
  WHERE external_id IS NOT NULL;

-- rows: [{ external_source, external_id, name, member_id, company_id,
--          stage_id, update_stage, amount, currency, close_date,
--          owner_name, lost_reason, lost_note, external_data }]
CREATE OR REPLACE FUNCTION public.crm_apply_external_opportunities(p_user UUID, p_rows JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r          JSONB;
  v_src      TEXT;
  v_ext      TEXT;
  v_id       UUID;
  v_member   UUID;
  v_company  UUID;
  v_stage    UUID;
  v_created  INTEGER := 0;
  v_updated  INTEGER := 0;
  v_failed   INTEGER := 0;
  v_errors   JSONB := '[]'::jsonb;
BEGIN
  IF p_user IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN jsonb_build_object('created', 0, 'updated', 0, 'failed', 0);
  END IF;
  PERFORM set_config('crm.actor', 'integration', true);

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    BEGIN
      v_src := left(btrim(COALESCE(r ->> 'external_source', '')), 60);
      v_ext := left(btrim(COALESCE(r ->> 'external_id', '')), 200);
      IF v_src = '' OR v_ext = '' THEN RAISE EXCEPTION 'missing_external_id'; END IF;
      v_stage := NULLIF(r ->> 'stage_id', '')::UUID;
      -- Solo ids del mismo dueño (el trigger de validación también lo exige).
      v_member := (SELECT m.id FROM public.prospect_list_members m
                    WHERE m.id = NULLIF(r ->> 'member_id', '')::UUID AND m.user_id = p_user);
      v_company := (SELECT c.id FROM public.crm_companies c
                     WHERE c.id = NULLIF(r ->> 'company_id', '')::UUID AND c.user_id = p_user);

      SELECT o.id INTO v_id FROM public.crm_opportunities o
       WHERE o.user_id = p_user AND o.external_source = v_src AND o.external_id = v_ext;

      IF v_id IS NULL THEN
        IF v_stage IS NULL THEN RAISE EXCEPTION 'missing_stage'; END IF;
        INSERT INTO public.crm_opportunities
          (user_id, name, company_id, member_id, stage_id, amount, currency, close_date, owner_name,
           lost_reason, lost_note, source, external_id, external_source, external_data)
        VALUES
          (p_user, left(COALESCE(NULLIF(btrim(r ->> 'name'), ''), 'Oportunidad'), 200), v_company, v_member, v_stage,
           NULLIF(r ->> 'amount', '')::NUMERIC, COALESCE(NULLIF(upper(r ->> 'currency'), ''), 'USD'),
           NULLIF(r ->> 'close_date', '')::DATE, left(NULLIF(r ->> 'owner_name', ''), 120),
           NULLIF(r ->> 'lost_reason', ''), left(NULLIF(r ->> 'lost_note', ''), 1000),
           'integration', v_ext, v_src, COALESCE(r -> 'external_data', '{}'::jsonb))
        RETURNING id INTO v_id;
        v_created := v_created + 1;
      ELSE
        UPDATE public.crm_opportunities o SET
          name        = COALESCE(NULLIF(left(btrim(r ->> 'name'), 200), ''), o.name),
          member_id   = COALESCE(o.member_id, v_member),
          company_id  = COALESCE(o.company_id, v_company),
          stage_id    = CASE WHEN (r ->> 'update_stage')::BOOLEAN AND v_stage IS NOT NULL THEN v_stage ELSE o.stage_id END,
          lost_reason = CASE WHEN (r ->> 'update_stage')::BOOLEAN AND v_stage IS NOT NULL THEN NULLIF(r ->> 'lost_reason', '') ELSE o.lost_reason END,
          lost_note   = CASE WHEN (r ->> 'update_stage')::BOOLEAN AND v_stage IS NOT NULL THEN left(NULLIF(r ->> 'lost_note', ''), 1000) ELSE o.lost_note END,
          amount      = CASE WHEN r ? 'amount' THEN NULLIF(r ->> 'amount', '')::NUMERIC ELSE o.amount END,
          currency    = COALESCE(NULLIF(upper(r ->> 'currency'), ''), o.currency),
          close_date  = CASE WHEN r ? 'close_date' THEN NULLIF(r ->> 'close_date', '')::DATE ELSE o.close_date END,
          owner_name  = COALESCE(left(NULLIF(r ->> 'owner_name', ''), 120), o.owner_name),
          external_data = o.external_data || COALESCE(r -> 'external_data', '{}'::jsonb)
        WHERE o.id = v_id;
        v_updated := v_updated + 1;
      END IF;

      UPDATE public.crm_opportunities SET external_synced_at = clock_timestamp() WHERE id = v_id;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      IF jsonb_array_length(v_errors) < 20 THEN
        v_errors := v_errors || jsonb_build_object('external_id', v_ext, 'error', SQLERRM);
      END IF;
    END;
  END LOOP;

  PERFORM set_config('crm.actor', '', true);
  RETURN jsonb_build_object('created', v_created, 'updated', v_updated, 'failed', v_failed, 'errors', v_errors);
END;
$$;

-- rows: [{ id, external_data }] → sella external_synced_at después de empujar.
CREATE OR REPLACE FUNCTION public.crm_mark_opportunities_synced(p_user UUID, p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r JSONB;
  n INTEGER := 0;
BEGIN
  IF p_user IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN RETURN 0; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    UPDATE public.crm_opportunities o
       SET external_synced_at = clock_timestamp(),
           external_data = o.external_data || COALESCE(r -> 'external_data', '{}'::jsonb)
     WHERE o.id = NULLIF(r ->> 'id', '')::UUID AND o.user_id = p_user;
    IF FOUND THEN n := n + 1; END IF;
  END LOOP;
  RETURN n;
END;
$$;

-- rows: [{ company_id, external_source, external_id }]
CREATE OR REPLACE FUNCTION public.crm_link_external_companies(p_user UUID, p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r JSONB;
  n INTEGER := 0;
BEGIN
  IF p_user IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN RETURN 0; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    BEGIN
      UPDATE public.crm_companies c
         SET external_source = left(r ->> 'external_source', 60),
             external_id = left(r ->> 'external_id', 200),
             external_synced_at = clock_timestamp()
       WHERE c.id = NULLIF(r ->> 'company_id', '')::UUID
         AND c.user_id = p_user
         AND NULLIF(r ->> 'external_id', '') IS NOT NULL
         -- Una cuenta tiene UN enlace externo: no se pisa el de otra fuente.
         AND (c.external_id IS NULL OR c.external_source = r ->> 'external_source');
      IF FOUND THEN n := n + 1; END IF;
    EXCEPTION WHEN unique_violation THEN
      NULL; -- ese id externo ya está enlazado a otra cuenta del usuario
    END;
  END LOOP;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_apply_external_opportunities(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crm_mark_opportunities_synced(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crm_link_external_companies(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_apply_external_opportunities(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.crm_mark_opportunities_synced(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.crm_link_external_companies(UUID, JSONB) TO service_role;
