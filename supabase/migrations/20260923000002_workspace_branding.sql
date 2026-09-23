-- ═══════════════════════════════════════════════════════════════════════════
-- Workspace branding + claim_branding_bonus_credits (2026-09-23)
--
-- Cada cliente personaliza SU Predictable: nombre de la empresa, logo, color
-- de marca y cómo lo saludamos. La app entera (barra lateral, pestaña del
-- navegador, favicon, color de acento, saludo del dashboard) se pinta con eso
-- — js/branding.js. Se ofrece como paso 2 del onboarding y, para las cuentas
-- que ya pasaron por él, desde el menú del usuario.
--
-- Columnas propias (brand_*) en vez de reutilizar profiles.company_name: esa
-- columna agrupa equipos en las políticas de admin/director
-- (profiles_admin_select_company / profiles_admin_update_company_role), así
-- que dejar que el onboarding la escriba libremente abriría la lectura de
-- perfiles de otra empresa. brand_name es solo presentación.
--
-- El bono (25 créditos, una sola vez) lo concede un RPC que valida en el
-- servidor que la personalización está completa, igual que
-- claim_miforms_bonus_credits: el cliente no puede fijar el monto ni cobrarlo
-- dos veces (índice único parcial sobre credit_transactions).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS brand_name        TEXT,
  ADD COLUMN IF NOT EXISTS brand_logo_path   TEXT,
  ADD COLUMN IF NOT EXISTS brand_color       TEXT,
  ADD COLUMN IF NOT EXISTS brand_updated_at  TIMESTAMPTZ;

-- Formato estricto: el color se inyecta como variable CSS en el cliente.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_brand_color_hex;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_brand_color_hex
  CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9A-Fa-f]{6}$');

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_brand_name_len;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_brand_name_len
  CHECK (brand_name IS NULL OR char_length(brand_name) <= 60);

-- El logo solo puede apuntar a la carpeta del propio usuario.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_brand_logo_path_own;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_brand_logo_path_own
  CHECK (brand_logo_path IS NULL OR brand_logo_path LIKE (id::text || '/%'));

-- ── Storage: bucket privado brand-assets ───────────────────────────────────
-- Ruta: <user_id>/logo-<ts>.<ext>. Solo imágenes rasterizadas (sin SVG: un
-- SVG servido desde el dominio de Supabase puede llevar scripts). El
-- navegador reduce el logo a ≤ 512 px antes de subirlo; 2 MB es el techo.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'brand-assets', 'brand-assets', false,
  2097152, -- 2 MB
  ARRAY['image/png','image/jpeg','image/webp']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "brand_assets_select_own" ON storage.objects;
CREATE POLICY "brand_assets_select_own"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'brand-assets' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "brand_assets_insert_own" ON storage.objects;
CREATE POLICY "brand_assets_insert_own"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'brand-assets' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "brand_assets_update_own" ON storage.objects;
CREATE POLICY "brand_assets_update_own"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'brand-assets' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "brand_assets_delete_own" ON storage.objects;
CREATE POLICY "brand_assets_delete_own"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'brand-assets' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ── Bono por personalizar ──────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS ct_user_branding_bonus_uidx
  ON public.credit_transactions (user_id)
  WHERE reason = 'branding_bonus';

CREATE OR REPLACE FUNCTION public.claim_branding_bonus_credits()
RETURNS TABLE(balance INT, granted BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_amount  INT  := 25;
  v_p       public.profiles%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_p FROM public.profiles WHERE id = v_user_id;

  IF v_p.id IS NULL
     OR coalesce(btrim(v_p.brand_name), '') = ''
     OR coalesce(btrim(v_p.full_name), '') = ''
     OR v_p.brand_color IS NULL
     OR v_p.brand_logo_path IS NULL THEN
    RAISE EXCEPTION 'Completa el nombre de tu empresa, tu nombre, el logo y el color.' USING ERRCODE = '22023';
  END IF;

  -- El logo tiene que existir de verdad en el bucket, no solo la ruta.
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'brand-assets' AND o.name = v_p.brand_logo_path
  ) THEN
    RAISE EXCEPTION 'Sube el logo de tu empresa.' USING ERRCODE = '22023';
  END IF;

  BEGIN
    INSERT INTO public.credit_transactions (user_id, delta, reason)
    VALUES (v_user_id, v_amount, 'branding_bonus');
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT uc.balance, FALSE FROM public.user_credits uc WHERE uc.user_id = v_user_id;
    RETURN;
  END;

  INSERT INTO public.user_credits (user_id, balance)
  VALUES (v_user_id, v_amount)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = public.user_credits.balance + v_amount;

  RETURN QUERY SELECT uc.balance, TRUE FROM public.user_credits uc WHERE uc.user_id = v_user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_branding_bonus_credits() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_branding_bonus_credits() TO authenticated;

-- ¿Ya lo cobró? (para no volver a ofrecer el bono). Solo lee lo propio.
CREATE OR REPLACE FUNCTION public.branding_bonus_claimed()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.credit_transactions
    WHERE user_id = auth.uid() AND reason = 'branding_bonus'
  );
$$;

REVOKE EXECUTE ON FUNCTION public.branding_bonus_claimed() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.branding_bonus_claimed() TO authenticated;
