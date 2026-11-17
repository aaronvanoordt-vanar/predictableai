-- ─────────────────────────────────────────────────────────────────────────────
-- Guardián de envíos + red de calentamiento (2026-11-17, pedido del dueño).
-- Diseño en docs/CHANNEL_GUARD.md.
--
--   warmup_pool      Cuentas SEMILLA de la plataforma: buzones y números de
--                    WhatsApp dedicados con los que se escriben las cuentas de
--                    los clientes para calentarse. Las marca el equipo desde
--                    la página «Warm Up» (edge function channel-guard).
--   warmup_messages  Cada correo o WhatsApp de calentamiento (el que abre el
--                    hilo y sus respuestas): a dónde llegó (bandeja / spam),
--                    si se rescató de spam y si se respondió.
--
-- Las dos tablas son SOLO de la service role: llevan direcciones de otras
-- cuentas. El usuario ve sus conteos por la función `channel-guard` (status).
-- El estado por canal vive donde ya vivía: `channel_accounts.config.guard`
-- (patch_channel_config) y `email_mailboxes.warmup.network`.
--
-- Idempotente. El cron `channel-guard-tick` (cada 5 min) reutiliza la service
-- role de un cron existente, como 20261028120000_telephony_sync_cron.sql.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.warmup_pool (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel     text        NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  -- email → email_mailboxes.id · whatsapp → channel_accounts.id
  ref_id      uuid        NOT NULL,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- email en minúsculas · teléfono solo dígitos
  address     text        NOT NULL,
  label       text,
  active      boolean     NOT NULL DEFAULT true,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warmup_pool_address_unique UNIQUE (channel, address),
  CONSTRAINT warmup_pool_ref_unique UNIQUE (channel, ref_id)
);

ALTER TABLE public.warmup_pool ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.warmup_pool FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.warmup_messages (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel             text        NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  kind                text        NOT NULL CHECK (kind IN ('opener', 'reply')),
  from_user           uuid        NOT NULL,
  to_user             uuid        NOT NULL,
  from_ref            uuid        NOT NULL,
  to_ref              uuid        NOT NULL,
  from_address        text        NOT NULL,
  to_address          text        NOT NULL,
  parent_id           uuid        REFERENCES public.warmup_messages(id) ON DELETE SET NULL,
  depth               integer     NOT NULL DEFAULT 0,
  subject             text,
  message_id          text,
  provider_message_id text,
  status              text        NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'received', 'replied', 'failed')),
  placement           text        CHECK (placement IN ('inbox', 'spam', 'missing', 'unknown')),
  rescued             boolean     NOT NULL DEFAULT false,
  will_reply          boolean     NOT NULL DEFAULT false,
  -- Cuándo el destinatario «abre» el mensaje (ubicarlo, rescatarlo, responder).
  action_due_at       timestamptz,
  acted_at            timestamptz,
  attempts            integer     NOT NULL DEFAULT 0,
  error               text,
  sent_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS warmup_messages_from_idx ON public.warmup_messages (channel, from_ref, sent_at DESC);
CREATE INDEX IF NOT EXISTS warmup_messages_to_idx ON public.warmup_messages (channel, to_ref, sent_at DESC);
CREATE INDEX IF NOT EXISTS warmup_messages_due_idx ON public.warmup_messages (action_due_at) WHERE acted_at IS NULL AND action_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS warmup_messages_from_user_idx ON public.warmup_messages (from_user, sent_at DESC);

ALTER TABLE public.warmup_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.warmup_messages FROM PUBLIC, anon, authenticated;

-- ── Cron: channel-guard {"action":"tick"} cada 5 minutos ─────────────────────
DO $$
DECLARE
  v_cmd  TEXT;
  v_base TEXT;
  v_auth TEXT;
BEGIN
  IF to_regnamespace('cron') IS NULL OR to_regnamespace('net') IS NULL THEN
    RAISE NOTICE 'channel-guard-tick: pg_cron o pg_net no están instalados; no se programa.';
    RETURN;
  END IF;

  SELECT j.command INTO v_cmd
    FROM cron.job j
   WHERE j.command ~ 'https://[a-z0-9]+\.supabase\.co/functions/v1/(campaign-run|enrich-list|radar-monitor|api-webhooks|learning-loop|push-send|automation-run)'
     AND j.command ~ 'Bearer [A-Za-z0-9._-]{20,}'
   ORDER BY (j.command ~ '/functions/v1/campaign-run') DESC, j.jobid
   LIMIT 1;
  IF v_cmd IS NULL THEN
    RAISE EXCEPTION 'channel-guard-tick: no hay un cron de referencia con la service role (campaign-run, enrich-list…).';
  END IF;

  v_base := substring(v_cmd from '(https://[a-z0-9]+\.supabase\.co)/functions/v1/');
  v_auth := substring(v_cmd from '(Bearer [A-Za-z0-9._-]{20,})');

  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'channel-guard-tick';
  PERFORM cron.schedule(
    'channel-guard-tick',
    '*/5 * * * *',
    format(
      $f$SELECT net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L), body := '{"action":"tick"}'::jsonb, timeout_milliseconds := 150000);$f$,
      v_base || '/functions/v1/channel-guard',
      v_auth));
  RAISE NOTICE 'channel-guard-tick programado cada 5 minutos.';
END;
$$;
