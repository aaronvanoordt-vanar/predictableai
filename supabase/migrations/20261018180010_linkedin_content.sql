-- ═══════════════════════════════════════════════════════════════════════════
-- Contenido en LinkedIn con aprobación (2026-10-17, docs/ROADMAP_GTM_OS.md §1
-- ítem 14). Motor de social selling: ideas → borradores → aprobado →
-- programado → publicado.
--
--   • linkedin_posts — el calendario editorial. El usuario crea ideas, edita
--     el texto, aprueba, programa y marca como publicado lo que publicó a
--     mano. La edge function `linkedin-content` (service role) escribe lo que
--     viene de la IA (fuentes, avisos de cifras) y de LinkedIn (URN del post,
--     métricas, errores). Reglas de fondo en el trigger de abajo:
--       – nada se programa ni se publica sin haber sido aprobado;
--       – editar el texto de un post aprobado o programado lo devuelve a
--         borrador (lo aprobado es exactamente lo que se publica);
--       – un post publicado no cambia de texto ni de estado.
--   • linkedin_publishers — la cuenta de LinkedIn conectada por OAuth para
--     publicar (una por usuario). La escribe SOLO la edge function; el token
--     se oculta con grants de columna, igual que integration_connections.
--     Tabla propia a propósito: no depende de ningún proveedor de mensajería
--     de LinkedIn (Dripify u otro).
--
-- Idempotente y no destructiva.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.linkedin_posts (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  status              TEXT        NOT NULL DEFAULT 'idea'
                        CHECK (status IN ('idea', 'draft', 'approved', 'scheduled', 'published')),
  title               TEXT        NOT NULL DEFAULT '' CHECK (char_length(title) <= 300),
  pillar              TEXT        NOT NULL DEFAULT 'opinion'
                        CHECK (pillar IN ('dolor', 'objecion', 'caso', 'senal', 'mercado', 'aprendizaje', 'opinion')),
  angle               TEXT        NOT NULL DEFAULT '' CHECK (char_length(angle) <= 1000),
  hook                TEXT        NOT NULL DEFAULT '' CHECK (char_length(hook) <= 600),
  body                TEXT        NOT NULL DEFAULT '' CHECK (char_length(body) <= 3000),
  notes               TEXT        NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
  -- En qué se basó la IA: [{kind, label}] + documentos de la base de conocimiento.
  based_on            JSONB       NOT NULL DEFAULT '[]',
  knowledge           JSONB       NOT NULL DEFAULT '[]',
  -- Cifras del texto que no aparecen en ninguna fuente que recibió el modelo.
  unsupported_figures TEXT[]      NOT NULL DEFAULT '{}',
  generated_engine    TEXT,
  generated_at        TIMESTAMPTZ,
  approved_at         TIMESTAMPTZ,
  scheduled_at        TIMESTAMPTZ,
  -- 'api' = lo publica Predictable a la hora programada; 'manual' = el
  -- vendedor lo copia y lo publica él (Copiar y abrir LinkedIn).
  publish_mode        TEXT        NOT NULL DEFAULT 'manual' CHECK (publish_mode IN ('api', 'manual')),
  publish_target      TEXT        NOT NULL DEFAULT 'member' CHECK (publish_target IN ('member', 'organization')),
  organization_urn    TEXT        CHECK (organization_urn IS NULL OR organization_urn ~ '^urn:li:organization:[0-9]+$'),
  publish_claimed_at  TIMESTAMPTZ,
  publish_error       TEXT,
  published_at        TIMESTAMPTZ,
  linkedin_post_urn   TEXT,
  linkedin_url        TEXT        CHECK (linkedin_url IS NULL OR linkedin_url ~ '^https://([a-z0-9-]+\.)*linkedin\.com/'),
  -- Solo lo que la API de LinkedIn devolvió (null = no vino). Nunca cálculos propios.
  metrics             JSONB,
  metrics_note        TEXT,
  metrics_updated_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS linkedin_posts_user_idx ON public.linkedin_posts (user_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS linkedin_posts_due_idx ON public.linkedin_posts (scheduled_at)
  WHERE status = 'scheduled' AND publish_mode = 'api';

-- ── Reglas del flujo de aprobación ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.linkedin_posts_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := NOW();

  IF TG_OP = 'INSERT' THEN
    -- Un post nace como idea o borrador: aprobar es un paso explícito.
    IF NEW.status NOT IN ('idea', 'draft') THEN
      RAISE EXCEPTION 'Un post nuevo empieza como idea o borrador.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.approved_at := NULL;
    NEW.published_at := NULL;
    RETURN NEW;
  END IF;

  IF OLD.status = 'published' THEN
    IF NEW.status <> 'published' OR NEW.body IS DISTINCT FROM OLD.body THEN
      RAISE EXCEPTION 'Un post publicado no se puede editar.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Editar lo aprobado lo devuelve a borrador.
  IF OLD.status IN ('approved', 'scheduled') AND NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.status := 'draft';
  END IF;

  -- Una idea o un borrador pueden tener fecha prevista (scheduled_at) para
  -- planificar el calendario; programar de verdad exige aprobar.
  IF NEW.status IN ('idea', 'draft') THEN
    NEW.approved_at := NULL;
    NEW.publish_claimed_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.status = 'approved' THEN
    IF char_length(btrim(NEW.body)) = 0 THEN
      RAISE EXCEPTION 'No se puede aprobar un post sin texto.' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status IN ('idea', 'draft') OR OLD.approved_at IS NULL THEN
      NEW.approved_at := NOW();
    ELSE
      NEW.approved_at := OLD.approved_at;
    END IF;
    -- «Publicar ahora» reclama la fila sin cambiar de estado: ese reclamo se
    -- respeta; un cambio de estado lo libera.
    IF OLD.status <> NEW.status THEN
      NEW.publish_claimed_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- scheduled / published: tiene que venir de algo aprobado y sin tocar.
  IF OLD.status NOT IN ('approved', 'scheduled') OR OLD.approved_at IS NULL THEN
    RAISE EXCEPTION 'Primero aprueba el post.' USING ERRCODE = 'check_violation';
  END IF;
  NEW.approved_at := OLD.approved_at;

  IF NEW.status = 'scheduled' THEN
    IF NEW.scheduled_at IS NULL THEN
      RAISE EXCEPTION 'Elige la fecha y la hora de publicación.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.publish_target = 'organization' AND NEW.organization_urn IS NULL THEN
      RAISE EXCEPTION 'Elige la página de empresa.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- published
  NEW.published_at := COALESCE(NEW.published_at, NOW());
  NEW.publish_claimed_at := NULL;
  IF NEW.linkedin_post_urn IS NULL THEN
    NEW.publish_mode := 'manual';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS linkedin_posts_guard ON public.linkedin_posts;
CREATE TRIGGER linkedin_posts_guard
  BEFORE INSERT OR UPDATE ON public.linkedin_posts
  FOR EACH ROW EXECUTE FUNCTION public.linkedin_posts_guard();

REVOKE ALL ON FUNCTION public.linkedin_posts_guard() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.linkedin_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own linkedin posts" ON public.linkedin_posts;
CREATE POLICY "Users read own linkedin posts"
  ON public.linkedin_posts FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users insert own linkedin posts" ON public.linkedin_posts;
CREATE POLICY "Users insert own linkedin posts"
  ON public.linkedin_posts FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own linkedin posts" ON public.linkedin_posts;
CREATE POLICY "Users update own linkedin posts"
  ON public.linkedin_posts FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users delete own linkedin posts" ON public.linkedin_posts;
CREATE POLICY "Users delete own linkedin posts"
  ON public.linkedin_posts FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- El cliente escribe solo lo editorial; lo que viene de la IA o de LinkedIn
-- (URN, métricas, errores, avisos) lo escribe la edge function.
REVOKE ALL ON public.linkedin_posts FROM anon;
REVOKE ALL ON public.linkedin_posts FROM PUBLIC;
REVOKE INSERT, UPDATE ON public.linkedin_posts FROM authenticated;
GRANT  SELECT, DELETE ON public.linkedin_posts TO authenticated;
GRANT  INSERT (user_id, status, title, pillar, angle, hook, body, notes)
       ON public.linkedin_posts TO authenticated;
GRANT  UPDATE (status, title, pillar, angle, hook, body, notes, scheduled_at,
               publish_mode, publish_target, organization_urn, linkedin_url, publish_error)
       ON public.linkedin_posts TO authenticated;

-- ── Cuenta de LinkedIn para publicar ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.linkedin_publishers (
  user_id           UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 'share' = Share on LinkedIn + OpenID (autoservicio, solo el perfil, sin
  -- métricas); 'community' = Community Management API (aprobada por LinkedIn:
  -- perfil + páginas + métricas).
  app               TEXT        NOT NULL CHECK (app IN ('share', 'community')),
  member_urn        TEXT        NOT NULL CHECK (member_urn ~ '^urn:li:person:[A-Za-z0-9_-]+$'),
  member_name       TEXT,
  member_picture    TEXT,
  -- Páginas que administra: [{urn, name}] (solo con 'community').
  organizations     JSONB       NOT NULL DEFAULT '[]',
  scopes            TEXT[]      NOT NULL DEFAULT '{}',
  status            TEXT        NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'expired', 'error')),
  last_error        TEXT,
  -- Secretos: solo los lee la edge function (grants de columna abajo).
  access_token      TEXT,
  refresh_token     TEXT,
  token_expires_at  TIMESTAMPTZ,
  refresh_expires_at TIMESTAMPTZ,
  connected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.linkedin_publishers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own linkedin publisher" ON public.linkedin_publishers;
CREATE POLICY "Users read own linkedin publisher"
  ON public.linkedin_publishers FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users disconnect own linkedin publisher" ON public.linkedin_publishers;
CREATE POLICY "Users disconnect own linkedin publisher"
  ON public.linkedin_publishers FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- Los privilegios de columna solo cuentan si NO hay SELECT a nivel de tabla.
REVOKE ALL ON public.linkedin_publishers FROM anon;
REVOKE ALL ON public.linkedin_publishers FROM PUBLIC;
REVOKE SELECT, INSERT, UPDATE ON public.linkedin_publishers FROM authenticated;
GRANT  SELECT (user_id, app, member_urn, member_name, member_picture, organizations,
               scopes, status, last_error, token_expires_at, connected_at, updated_at)
       ON public.linkedin_publishers TO authenticated;
GRANT  DELETE ON public.linkedin_publishers TO authenticated;

-- ── Cron (manual, como enrich-list) ────────────────────────────────────────
-- Publica los posts programados con publish_mode = 'api' y refresca métricas.
-- Requiere pg_cron + pg_net y el despliegue de `linkedin-content`:
--
-- SELECT cron.schedule('linkedin-content', '*/5 * * * *', $cron$
--   SELECT net.http_post(
--     url     := 'https://<project-ref>.supabase.co/functions/v1/linkedin-content',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'),
--     body    := '{"action":"run_due"}'::jsonb,
--     timeout_milliseconds := 120000);
-- $cron$);
