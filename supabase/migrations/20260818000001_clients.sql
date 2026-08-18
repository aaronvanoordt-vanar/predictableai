-- ═══════════════════════════════════════════════════════════════════════════
-- Clients section (2026-08-18)
--
-- Notion-style client workspace: a grid of client cards, each opening a
-- dashboard (status, links, CRM metrics, support material, notes, ICP,
-- target countries…). Each client row carries an unguessable share_token;
-- the standalone portal page (client.html?token=…) lets the end client sign
-- up and claim READ-ONLY access to that one dashboard via the
-- claim_client_access RPC.
--
-- Access model:
--   • Creator (any team role) has full CRUD on their own clients.
--   • Admins/directors of the creator's company also have full CRUD
--     (same company_name convention as profiles_admin_select_company).
--   • Portal viewers (rows in client_access) can only SELECT.
--   • client_access has NO client-facing INSERT policy — the only way in is
--     the SECURITY DEFINER RPC, which requires knowing the share_token.
--
-- Files (client photo + support PDFs) live in the private storage bucket
-- `client-assets` under <client_id>/…; storage policies delegate to the same
-- helper functions, and the frontend reads via signed URLs.
--
-- All statements are idempotent and non-destructive (safe to re-apply).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.clients (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by            UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name                  TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  photo_path            TEXT,       -- storage path in client-assets (signed URLs at read time)
  status                TEXT        NOT NULL DEFAULT 'onboarding'
                        CHECK (status IN ('onboarding','activo','pausado','finalizado')),
  prospecting_brief_url TEXT,
  crm_sheet_url         TEXT,       -- Google Sheets con la base de datos (embed + botón)
  campaigns_url         TEXT,
  matriz_url            TEXT,
  kickoff_url           TEXT,
  country               TEXT,
  start_date            DATE,
  meta                  TEXT,       -- objetivo mensual (desplegable en UI)
  linkedin_status       TEXT,       -- desplegable en UI (activo / pausado / no_incluido)
  historical_notes      TEXT,
  icp                   TEXT,
  industries            TEXT,
  target_countries      TEXT[]      NOT NULL DEFAULT '{}',
  -- Métricas críticas del CRM, editadas por el equipo:
  -- { contacted, opened, replied, meetings_scheduled, meetings_held,
  --   no_shows, disqualified } — los ratios se calculan en el frontend.
  crm_metrics           JSONB       NOT NULL DEFAULT '{}',
  share_token           UUID        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.client_materials (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  uploaded_by UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name   TEXT        NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  file_path   TEXT        NOT NULL, -- path in client-assets bucket
  file_size   BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.client_access (
  client_id  UUID        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, user_id)
);

-- ── updated_at trigger (reuses public.set_updated_at from client_icp) ───────

DROP TRIGGER IF EXISTS clients_updated_at ON public.clients;
CREATE TRIGGER clients_updated_at
  BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Access helper functions ─────────────────────────────────────────────────
-- SECURITY DEFINER so policy checks never recurse through RLS. They are used
-- both by table policies and by storage.objects policies (path convention:
-- first folder segment = client id).

CREATE OR REPLACE FUNCTION public.can_manage_client(p_client_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.clients c
    JOIN public.profiles me ON me.id = auth.uid()
    LEFT JOIN public.profiles owner ON owner.id = c.created_by
    WHERE c.id = p_client_id
      AND (
        c.created_by = auth.uid()
        OR (
          lower(coalesce(me.role, '')) IN ('admin', 'director')
          AND me.company_name IS NOT NULL
          AND owner.company_name = me.company_name
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.can_view_client(p_client_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.can_manage_client(p_client_id)
      OR EXISTS (
        SELECT 1 FROM public.client_access ca
        WHERE ca.client_id = p_client_id AND ca.user_id = auth.uid()
      );
$$;

-- Default-deny: solo usuarios autenticados pueden ejecutar los helpers.
REVOKE ALL ON FUNCTION public.can_manage_client(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_view_client(uuid)   FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_client(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_view_client(uuid)   TO authenticated, service_role;

-- ── claim_client_access RPC ─────────────────────────────────────────────────
-- The portal calls this after signup/login with the share_token from the URL.
-- Knowing the token IS the authorization; the RPC binds the caller to the
-- client so subsequent SELECTs pass RLS.

CREATE OR REPLACE FUNCTION public.claim_client_access(p_token uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_client_id FROM public.clients WHERE share_token = p_token;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Link inválido o revocado' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.client_access (client_id, user_id)
  VALUES (v_client_id, auth.uid())
  ON CONFLICT (client_id, user_id) DO NOTHING;

  RETURN v_client_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_client_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_client_access(uuid) TO authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.clients          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_access    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "clients_select" ON public.clients;
CREATE POLICY "clients_select"
  ON public.clients FOR SELECT
  TO authenticated
  USING (public.can_view_client(id));

DROP POLICY IF EXISTS "clients_insert" ON public.clients;
CREATE POLICY "clients_insert"
  ON public.clients FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS "clients_update" ON public.clients;
CREATE POLICY "clients_update"
  ON public.clients FOR UPDATE
  TO authenticated
  USING (public.can_manage_client(id))
  WITH CHECK (public.can_manage_client(id) AND created_by IS NOT NULL);

DROP POLICY IF EXISTS "clients_delete" ON public.clients;
CREATE POLICY "clients_delete"
  ON public.clients FOR DELETE
  TO authenticated
  USING (public.can_manage_client(id));

DROP POLICY IF EXISTS "client_materials_select" ON public.client_materials;
CREATE POLICY "client_materials_select"
  ON public.client_materials FOR SELECT
  TO authenticated
  USING (public.can_view_client(client_id));

DROP POLICY IF EXISTS "client_materials_insert" ON public.client_materials;
CREATE POLICY "client_materials_insert"
  ON public.client_materials FOR INSERT
  TO authenticated
  WITH CHECK (public.can_manage_client(client_id) AND uploaded_by = auth.uid());

DROP POLICY IF EXISTS "client_materials_delete" ON public.client_materials;
CREATE POLICY "client_materials_delete"
  ON public.client_materials FOR DELETE
  TO authenticated
  USING (public.can_manage_client(client_id));

-- client_access: viewers see their own grant; managers see/revoke grants of
-- their clients. NO INSERT policy — only the RPC (SECURITY DEFINER) inserts.
DROP POLICY IF EXISTS "client_access_select" ON public.client_access;
CREATE POLICY "client_access_select"
  ON public.client_access FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.can_manage_client(client_id));

DROP POLICY IF EXISTS "client_access_delete" ON public.client_access;
CREATE POLICY "client_access_delete"
  ON public.client_access FOR DELETE
  TO authenticated
  USING (public.can_manage_client(client_id));

-- ── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS clients_created_by_idx          ON public.clients (created_by);
CREATE INDEX IF NOT EXISTS client_materials_client_id_idx  ON public.client_materials (client_id);
CREATE INDEX IF NOT EXISTS client_access_user_id_idx       ON public.client_access (user_id);

-- ── Storage: private bucket client-assets ───────────────────────────────────
-- Path convention: <client_id>/<file>. Frontend uploads photos as
-- <client_id>/photo-* and PDFs as <client_id>/material-*, and reads
-- everything through signed URLs.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'client-assets', 'client-assets', false,
  20971520, -- 20 MB
  ARRAY['application/pdf','image/png','image/jpeg','image/webp','image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- Safe uuid extraction from the first path segment (returns NULL instead of
-- raising on malformed paths, so policy evaluation never errors out).
CREATE OR REPLACE FUNCTION public.client_id_from_storage_path(p_name text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN split_part(p_name, '/', 1)
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN split_part(p_name, '/', 1)::uuid
    ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION public.client_id_from_storage_path(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_id_from_storage_path(text) TO authenticated, service_role;

DROP POLICY IF EXISTS "client_assets_select" ON storage.objects;
CREATE POLICY "client_assets_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'client-assets'
    AND public.can_view_client(public.client_id_from_storage_path(name))
  );

DROP POLICY IF EXISTS "client_assets_insert" ON storage.objects;
CREATE POLICY "client_assets_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'client-assets'
    AND public.can_manage_client(public.client_id_from_storage_path(name))
  );

DROP POLICY IF EXISTS "client_assets_update" ON storage.objects;
CREATE POLICY "client_assets_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'client-assets'
    AND public.can_manage_client(public.client_id_from_storage_path(name))
  );

DROP POLICY IF EXISTS "client_assets_delete" ON storage.objects;
CREATE POLICY "client_assets_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'client-assets'
    AND public.can_manage_client(public.client_id_from_storage_path(name))
  );
