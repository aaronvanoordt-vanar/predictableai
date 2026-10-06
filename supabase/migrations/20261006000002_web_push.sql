-- ═══════════════════════════════════════════════════════════════════════════
-- Notificaciones push (iPhone, Android, escritorio) de la Bandeja — 2026-10-06
--
-- Cuando entra un mensaje (WhatsApp, email o LinkedIn) el usuario recibe una
-- notificación en su teléfono aunque la app esté cerrada. Web Push estándar:
-- en iPhone funciona desde iOS 16.4 con Predictable agregado a la pantalla de
-- inicio (manifest.webmanifest + sw.js en la raíz del sitio).
--
--   • push_subscriptions — un dispositivo/navegador por fila. El navegador la
--     da de alta con register_push_subscription() (si el mismo dispositivo ya
--     estaba suscrito con otra cuenta, pasa a la cuenta actual: nunca recibe
--     los mensajes de dos personas). El dueño la lee y la borra.
--   • push_outbox — la cola. La llena SOLO el trigger de inbox_messages (un
--     entrante nuevo de un usuario con al menos un dispositivo) y la vacía la
--     edge function push-send (claim_push_batch, FOR UPDATE SKIP LOCKED).
--   • push_settings — una fila con la URL de push-send. Si está, el trigger
--     despierta a push-send por pg_net al instante; si no, la vacía el cron
--     cada minuto. Sin grants: solo el SQL editor la escribe.
--
-- No avisa de lo viejo (sincronizar el historial de WATI inserta mensajes
-- antiguos), de lo ya leído ni de lo saliente. El trigger nunca rompe la
-- escritura del mensaje: cualquier error baja a WARNING.
--
-- Idempotente (seguro de re-aplicar).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Dispositivos ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint        TEXT        NOT NULL UNIQUE CHECK (endpoint ~ '^https://' AND char_length(endpoint) <= 1000),
  p256dh          TEXT        NOT NULL CHECK (char_length(p256dh) BETWEEN 80 AND 100),
  auth            TEXT        NOT NULL CHECK (char_length(auth) BETWEEN 16 AND 40),
  user_agent      TEXT        CHECK (char_length(user_agent) <= 400),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at TIMESTAMPTZ,
  last_error      TEXT,
  failures        INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_subscriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.push_subscriptions TO authenticated;

DROP POLICY IF EXISTS "Users can view own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users can view own push subscriptions"
  ON public.push_subscriptions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users can delete own push subscriptions"
  ON public.push_subscriptions FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.register_push_subscription(
  p_endpoint   TEXT,
  p_p256dh     TEXT,
  p_auth       TEXT,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id  UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  -- Tope por cuenta: un teléfono, una tablet y algunos navegadores.
  IF (SELECT count(*) FROM public.push_subscriptions WHERE user_id = v_uid AND endpoint <> p_endpoint) >= 10 THEN
    DELETE FROM public.push_subscriptions
     WHERE id IN (SELECT id FROM public.push_subscriptions
                   WHERE user_id = v_uid AND endpoint <> p_endpoint
                   ORDER BY updated_at ASC LIMIT 1);
  END IF;
  INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  VALUES (v_uid, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 400))
  ON CONFLICT (endpoint) DO UPDATE
     SET user_id    = EXCLUDED.user_id,
         p256dh     = EXCLUDED.p256dh,
         auth       = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent,
         updated_at = NOW(),
         failures   = 0,
         last_error = NULL
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.register_push_subscription(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_push_subscription(TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- ── 2. Cola ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.push_outbox (
  id          BIGSERIAL   PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message_id  UUID        NOT NULL UNIQUE REFERENCES public.inbox_messages(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at  TIMESTAMPTZ,
  attempts    INTEGER     NOT NULL DEFAULT 0,
  sent_at     TIMESTAMPTZ,
  last_error  TEXT
);

CREATE INDEX IF NOT EXISTS push_outbox_pending_idx
  ON public.push_outbox (created_at)
  WHERE sent_at IS NULL;

ALTER TABLE public.push_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_outbox FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.push_outbox_id_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_push_batch(p_limit INTEGER DEFAULT 50)
RETURNS SETOF public.push_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT o.id
      FROM public.push_outbox o
     WHERE o.sent_at IS NULL
       AND o.attempts < 3
       AND o.created_at > NOW() - INTERVAL '1 day'
       AND (o.claimed_at IS NULL OR o.claimed_at < NOW() - INTERVAL '2 minutes')
     ORDER BY o.created_at
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.push_outbox o
     SET claimed_at = NOW(),
         attempts   = o.attempts + 1
    FROM picked
   WHERE o.id = picked.id
  RETURNING o.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_push_batch(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_push_batch(INTEGER) TO service_role;

-- ── 3. Despertador inmediato (opcional) ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.push_settings (
  id           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  dispatch_url TEXT    CHECK (dispatch_url ~ '^https://')
);

ALTER TABLE public.push_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_settings FROM PUBLIC, anon, authenticated;

-- ── 4. Trigger: entrante nuevo → cola ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.push_on_inbox_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url TEXT;
BEGIN
  IF NEW.direction <> 'in'
     OR NEW.read_at IS NOT NULL
     OR NEW.sent_at < NOW() - INTERVAL '10 minutes'
     OR NOT EXISTS (SELECT 1 FROM public.push_subscriptions s WHERE s.user_id = NEW.user_id) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.push_outbox (user_id, message_id)
  VALUES (NEW.user_id, NEW.id)
  ON CONFLICT (message_id) DO NOTHING;

  -- pg_net encola el POST y lo manda después del COMMIT: no frena al webhook
  -- y push-send ya ve la fila de la cola.
  SELECT dispatch_url INTO v_url FROM public.push_settings WHERE id;
  IF v_url IS NOT NULL AND to_regnamespace('net') IS NOT NULL THEN
    PERFORM net.http_post(
      url     := v_url,
      body    := jsonb_build_object('action', 'dispatch'),
      headers := jsonb_build_object('Content-Type', 'application/json'),
      timeout_milliseconds := 10000);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'push_on_inbox_message: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.push_on_inbox_message() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS push_on_inbox_message_ins ON public.inbox_messages;
CREATE TRIGGER push_on_inbox_message_ins
  AFTER INSERT ON public.inbox_messages
  FOR EACH ROW EXECUTE FUNCTION public.push_on_inbox_message();

-- ── 5. Puesta en marcha (SQL editor, DESPUÉS de desplegar push-send) ────────
--
-- Despertador inmediato (sin él, el aviso llega con el cron, hasta 1 min tarde):
--
-- INSERT INTO public.push_settings (id, dispatch_url)
-- VALUES (TRUE, 'https://<project-ref>.supabase.co/functions/v1/push-send')
-- ON CONFLICT (id) DO UPDATE SET dispatch_url = EXCLUDED.dispatch_url;
--
-- Red de seguridad (reintentos y lo que el despertador no alcanzó):
--
-- SELECT cron.schedule('push-send', '* * * * *', $cron$
--   SELECT net.http_post(
--     url     := 'https://<project-ref>.supabase.co/functions/v1/push-send',
--     headers := jsonb_build_object('Content-Type', 'application/json'),
--     body    := '{"action":"dispatch"}'::jsonb,
--     timeout_milliseconds := 30000);
-- $cron$);
