-- Waterfall enrichment + verificación de email + teléfonos en E.164 (2026-10-17).
-- Diseño: docs/ENRICHMENT_WATERFALL.md.
--
-- Si Apollo no encuentra el email o el teléfono, enrich-list sigue con otros
-- proveedores en cascada (Prospeo, BetterContact, FullEnrich…; solo los que
-- tienen su secret en Supabase) y guarda quién encontró cada dato.
--
--   source_provider    → quién encontró cada dato: {"email": "prospeo",
--                        "email_via": "<fuente de fondo del agregador>",
--                        "email_verifier": "millionverifier",
--                        "phone": "fullenrich", "phone_via": …}
--   email_verification → veredicto del verificador o del proveedor:
--                        valid | invalid | catch_all | risky | unknown
--                        (email_status sigue siendo el de Apollo)
--   email_verified_at  → cuándo
--   phone_type         → mobile | landline | switchboard | unknown
--                        (_shared/phone-latam.ts; `phone` queda en E.164)
--   enrich_waterfall   → estado de la cascada mientras corre (proveedores
--                        consultados, trabajo asíncrono, créditos
--                        reservados). Solo lo escribe la edge function.
--
-- La tabla ya es client-writable con RLS por dueño y está en realtime.

ALTER TABLE public.prospect_list_members
  ADD COLUMN IF NOT EXISTS source_provider    JSONB,
  ADD COLUMN IF NOT EXISTS email_verification TEXT
    CHECK (email_verification IS NULL OR email_verification IN ('valid', 'invalid', 'catch_all', 'risky', 'unknown')),
  ADD COLUMN IF NOT EXISTS email_verified_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS phone_type         TEXT
    CHECK (phone_type IS NULL OR phone_type IN ('mobile', 'landline', 'switchboard', 'unknown')),
  ADD COLUMN IF NOT EXISTS enrich_waterfall   JSONB;

-- La cascada pospone filas (un proveedor asíncrono que todavía no termina,
-- el teléfono de Apollo que llega por webhook): enrich_requested_at en el
-- futuro = «todavía no». Mismo reclamo que 20260923000003, solo que ahora
-- ignora las filas cuyo turno no llegó.
CREATE OR REPLACE FUNCTION public.claim_enrichment_batch(
  p_user_id       UUID,
  p_limit         INTEGER,
  p_lease_seconds INTEGER DEFAULT 180
)
RETURNS SETOF public.prospect_list_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT m.id
      FROM public.prospect_list_members m
     WHERE m.enrich_requested_at IS NOT NULL
       AND m.enrich_requested_at <= NOW()
       AND (m.enrich_claimed_at IS NULL
            OR m.enrich_claimed_at < NOW() - make_interval(secs => GREATEST(p_lease_seconds, 30)))
       AND (p_user_id IS NULL OR m.user_id = p_user_id)
     ORDER BY m.enrich_requested_at, m.id
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 10), 50))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.prospect_list_members m
     SET enrich_claimed_at = NOW(),
         enrich_attempts   = m.enrich_attempts + 1
    FROM picked
   WHERE m.id = picked.id
  RETURNING m.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_enrichment_batch(UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_enrichment_batch(UUID, INTEGER, INTEGER) TO service_role;

-- enrich_waterfall lleva los créditos reservados de la cascada: si el cliente
-- pudiera escribirlo, inflaría `reserved` y la función le «devolvería»
-- créditos que nunca pagó. Solo la service role (enrich-list) lo cambia; para
-- el resto (authenticated, anon) el valor se conserva tal cual. El cliente sí
-- puede sacar la fila de la cola (enrich_requested_at = NULL) como antes.
CREATE OR REPLACE FUNCTION public.protect_enrich_waterfall()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.enrich_waterfall := NULL;
    ELSE
      NEW.enrich_waterfall := OLD.enrich_waterfall;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_enrich_waterfall() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS prospect_list_members_protect_waterfall ON public.prospect_list_members;
CREATE TRIGGER prospect_list_members_protect_waterfall
  BEFORE INSERT OR UPDATE ON public.prospect_list_members
  FOR EACH ROW EXECUTE FUNCTION public.protect_enrich_waterfall();
