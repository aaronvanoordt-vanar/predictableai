-- ═══════════════════════════════════════════════════════════════════════════
-- CFDI 4.0 por Facturapi — Fase B en modo prueba (2026-10-18)
--
-- Diseño en docs/BILLING_LATAM.md §6.2. Resumen:
--   · billing_fiscal_profiles: los datos fiscales que el cliente mexicano
--     escribe en «Plan y créditos» (RFC, razón social, régimen, CP, uso).
--     Los escribe el propio usuario (RLS por dueño); la edge function `cfdi`
--     valida el formato antes de guardar y el SAT lo valida al timbrar.
--   · cfdi_documents: cola y registro de cada CFDI. Una fila por cobro de
--     Stripe (source_id = in_… o cs_…, ÚNICO: un cobro nunca se factura dos
--     veces). La inserta `stripe-webhook` DESPUÉS de dar los créditos y la
--     procesa `cfdi` (cron con la service role). El cliente solo la lee.
--
-- Nada de esto da créditos ni condiciona darlos: si Facturapi falla, el
-- cliente ya tiene sus créditos y la factura sale en el reintento.
--
-- Con CFDI_MODE sin definir en las edge functions no se encola nada: aplicar
-- esta migración no cambia el comportamiento de producción.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.billing_fiscal_profiles (
  user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  rfc         TEXT NOT NULL CHECK (rfc ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$'),
  legal_name  TEXT NOT NULL CHECK (char_length(legal_name) BETWEEN 2 AND 254),
  tax_regime  TEXT NOT NULL CHECK (tax_regime ~ '^[0-9]{3}$'),
  zip         TEXT NOT NULL CHECK (zip ~ '^[0-9]{5}$'),
  cfdi_use    TEXT NOT NULL DEFAULT 'G03' CHECK (cfdi_use ~ '^[A-Z][0-9]{2}$'),
  email       TEXT CHECK (email IS NULL OR char_length(email) <= 254),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.billing_fiscal_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fiscal_profiles_owner_select ON public.billing_fiscal_profiles;
CREATE POLICY fiscal_profiles_owner_select ON public.billing_fiscal_profiles
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS fiscal_profiles_owner_delete ON public.billing_fiscal_profiles;
CREATE POLICY fiscal_profiles_owner_delete ON public.billing_fiscal_profiles
  FOR DELETE TO authenticated USING (user_id = auth.uid());
-- Insertar y actualizar pasa por la edge function `cfdi` (valida el régimen
-- contra el tipo de RFC, que un CHECK no alcanza a expresar).
REVOKE ALL ON public.billing_fiscal_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.billing_fiscal_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_fiscal_profiles TO service_role;

CREATE TABLE IF NOT EXISTS public.cfdi_documents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_kind      TEXT NOT NULL CHECK (source_kind IN ('invoice', 'checkout_session')),
  source_id        TEXT NOT NULL UNIQUE,
  description      TEXT NOT NULL,
  amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),
  currency         TEXT NOT NULL,
  livemode         BOOLEAN NOT NULL DEFAULT false,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'issued', 'failed')),
  attempts         INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT,
  facturapi_id     TEXT,
  sat_uuid         TEXT,
  series           TEXT,
  folio_number     TEXT,
  -- Copia de los datos fiscales con que se timbró (el perfil puede cambiar).
  receiver         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS cfdi_documents_user_idx ON public.cfdi_documents (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cfdi_documents_due_idx ON public.cfdi_documents (next_attempt_at) WHERE status = 'pending';

ALTER TABLE public.cfdi_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cfdi_documents_owner_select ON public.cfdi_documents;
CREATE POLICY cfdi_documents_owner_select ON public.cfdi_documents
  FOR SELECT TO authenticated USING (user_id = auth.uid());
REVOKE ALL ON public.cfdi_documents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cfdi_documents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cfdi_documents TO service_role;

-- Cron (se programa a mano en el SQL editor, igual que enrich-list, porque
-- necesita la URL del proyecto y la service role; solo cuando CFDI_MODE esté
-- puesto):
-- SELECT cron.schedule('cfdi-issue', '*/5 * * * *', $cron$
--   SELECT net.http_post(
--     url     := 'https://<project-ref>.supabase.co/functions/v1/cfdi',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'),
--     body    := '{"action":"process"}'::jsonb,
--     timeout_milliseconds := 60000);
-- $cron$);
