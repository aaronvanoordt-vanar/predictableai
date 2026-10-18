-- ═══════════════════════════════════════════════════════════════════════════
-- Integraciones (2026-09-23): HubSpot, Salesforce, Amplemarket, Google Sheets,
-- Google Calendar, Notion y ClickUp.
--
--   • integration_connections — una fila por usuario y plataforma. La escribe
--     SOLO la edge function `integrations` (service role), después de que la
--     plataforma validó el token o el código de OAuth: una fila escribible por
--     el cliente dejaría a cualquiera declarar una cuenta que no es suya.
--     Los tokens (access_token / refresh_token) se ocultan con grants de
--     columna, igual que gmail_accounts.refresh_token y channel_accounts.
--   • integration_sync_log — qué se envió, a dónde y con qué resultado (lo
--     escribe la edge function; el usuario solo lee lo suyo).
--
-- Idempotente y no destructiva.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.integration_connections (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider         TEXT        NOT NULL CHECK (provider IN (
                     'hubspot', 'salesforce', 'amplemarket', 'google_sheets',
                     'google_calendar', 'notion', 'clickup')),
  auth_type        TEXT        NOT NULL DEFAULT 'oauth' CHECK (auth_type IN ('oauth', 'token')),
  -- Lo que la UI muestra: "Portal 1234 · acme.hubspot.com", el email de Google…
  account_label    TEXT,
  account_id       TEXT,
  -- No secreto: instance_url de Salesforce, destinos elegidos, hojas creadas…
  config           JSONB       NOT NULL DEFAULT '{}',
  scopes           TEXT[]      NOT NULL DEFAULT '{}',
  status           TEXT        NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error')),
  last_error       TEXT,
  last_used_at     TIMESTAMPTZ,
  -- Secretos: solo los lee la edge function (grants de columna abajo).
  access_token     TEXT,
  refresh_token    TEXT,
  token_expires_at TIMESTAMPTZ,
  connected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integration_connections_user_provider_key UNIQUE (user_id, provider)
);

ALTER TABLE public.integration_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own integrations" ON public.integration_connections;
CREATE POLICY "Users read own integrations"
  ON public.integration_connections FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users disconnect own integrations" ON public.integration_connections;
CREATE POLICY "Users disconnect own integrations"
  ON public.integration_connections FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Los privilegios de columna solo cuentan si NO hay SELECT a nivel de tabla.
REVOKE ALL ON public.integration_connections FROM anon;
REVOKE ALL ON public.integration_connections FROM PUBLIC;
REVOKE SELECT, INSERT, UPDATE ON public.integration_connections FROM authenticated;
GRANT  SELECT (id, user_id, provider, auth_type, account_label, account_id, config,
               scopes, status, last_error, last_used_at, token_expires_at,
               connected_at, updated_at)
       ON public.integration_connections TO authenticated;
GRANT  DELETE ON public.integration_connections TO authenticated;

CREATE INDEX IF NOT EXISTS integration_connections_user_idx
  ON public.integration_connections (user_id);

-- ── Registro de envíos ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.integration_sync_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider    TEXT        NOT NULL,
  action      TEXT        NOT NULL,
  source_kind TEXT,
  source_id   TEXT,
  status      TEXT        NOT NULL CHECK (status IN ('ok', 'partial', 'error')),
  counts      JSONB       NOT NULL DEFAULT '{}',
  detail      TEXT,
  target_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.integration_sync_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own integration log" ON public.integration_sync_log;
CREATE POLICY "Users read own integration log"
  ON public.integration_sync_log FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.integration_sync_log FROM anon;
REVOKE ALL ON public.integration_sync_log FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.integration_sync_log FROM authenticated;
GRANT  SELECT ON public.integration_sync_log TO authenticated;

CREATE INDEX IF NOT EXISTS integration_sync_log_user_idx
  ON public.integration_sync_log (user_id, created_at DESC);
