-- ═══════════════════════════════════════════════════════════════════════════
-- Canales dentro de Campañas: Apollo por OAuth (opción B) + bandeja
-- unificada con respuestas — 2026-09-03
--
-- • channel_accounts.provider admite 'apollo': cada cliente conecta SU
--   cuenta de Apollo por OAuth (channel-connect → apollo_auth_url /
--   apollo_connect). `secret` guarda el JSON de tokens
--   ({access_token, refresh_token, expires_at}) como texto; sigue oculto al
--   cliente por los grants de columna de 20260902000001. Sin fila, las edge
--   functions caen a la key compartida de la plataforma (APOLLO_API_KEY),
--   que queda como fallback de la beta.
-- • inbox_messages gana campaign_id / enrollment_id (para filtrar la
--   bandeja por campaña sin recorrer payload) y read_at (contador de
--   "sin leer": lo pone inbox-send con la acción mark_read).
-- • campaigns.daily_caps: LinkedIn ya no tiene tope (el ritmo lo decide
--   Dripify), el default queda en {"whatsapp": 50, "email": 80}. Las filas
--   existentes con "linkedin" no se tocan: el motor ignora esa clave.
--
-- RLS: sin cambios. inbox_messages sigue siendo solo lectura para el
-- cliente (read_at lo escribe la edge function con service role). Sin
-- grants nuevos a anon.
--
-- Idempotente (seguro de re-aplicar).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. channel_accounts: proveedor apollo ───────────────────────────────────

ALTER TABLE public.channel_accounts
  DROP CONSTRAINT IF EXISTS channel_accounts_provider_check;

ALTER TABLE public.channel_accounts
  ADD CONSTRAINT channel_accounts_provider_check
  CHECK (provider IN ('wati', 'dripify', 'apollo'));

-- ── 2. inbox_messages: campaña, enrolamiento y lectura ──────────────────────

ALTER TABLE public.inbox_messages
  ADD COLUMN IF NOT EXISTS campaign_id UUID
    REFERENCES public.campaigns(id) ON DELETE SET NULL;

ALTER TABLE public.inbox_messages
  ADD COLUMN IF NOT EXISTS enrollment_id UUID
    REFERENCES public.campaign_enrollments(id) ON DELETE SET NULL;

ALTER TABLE public.inbox_messages
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

-- Hilo por lead (la bandeja agrupa por member_id y ordena por fecha).
CREATE INDEX IF NOT EXISTS inbox_messages_user_member_idx
  ON public.inbox_messages (user_id, member_id, sent_at DESC);

-- Contador de "sin leer": solo entrantes sin read_at.
CREATE INDEX IF NOT EXISTS inbox_messages_unread_idx
  ON public.inbox_messages (user_id, direction, read_at)
  WHERE direction = 'in' AND read_at IS NULL;

CREATE INDEX IF NOT EXISTS inbox_messages_campaign_idx
  ON public.inbox_messages (campaign_id, sent_at DESC)
  WHERE campaign_id IS NOT NULL;

-- ── 3. campaigns.daily_caps: sin tope de LinkedIn ───────────────────────────

ALTER TABLE public.campaigns
  ALTER COLUMN daily_caps SET DEFAULT '{"whatsapp": 50, "email": 80}';
