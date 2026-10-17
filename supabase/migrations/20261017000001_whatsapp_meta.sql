-- WhatsApp directo con Meta (Cloud API) por Embedded Signup v4 (2026-10-17).
--
-- Decisión del dueño (2026-10-17, docs/DECISIONS.md): Predictable se vuelve
-- Tech Provider de Meta. El cliente conecta su número (también el que ya usa
-- en la app de WhatsApp Business, por coexistencia) desde un popup de Meta,
-- sin pasar por WATI. WATI sigue funcionando igual para quien ya lo tiene.
--
-- No resucita nada de lo borrado el 2026-09-02 (tablas whatsapp_*): la cuenta
-- es otra fila de channel_accounts (provider = 'meta') y los mensajes van a
-- inbox_messages con provider = 'meta', igual que los de WATI.
--
--   • channel_accounts.provider admite 'meta'. `secret` guarda el token de
--     negocio (JSON {access_token, pin}); sigue oculto al cliente por los
--     grants de columna de 20260902000001.
--   • inbox_messages.provider admite 'meta'.
--   • Meta llama a UNA sola URL para toda la app (meta-whatsapp-webhook) y en
--     cada evento dice el phone_number_id / WABA: índices para encontrar la
--     cuenta por esos ids. Un número conectado solo puede estar en UNA cuenta
--     de Predictable a la vez (si no, la respuesta del lead no sabría a quién
--     ir): índice único parcial sobre las conectadas.
--
-- Idempotente.

ALTER TABLE public.channel_accounts DROP CONSTRAINT IF EXISTS channel_accounts_provider_check;
ALTER TABLE public.channel_accounts
  ADD CONSTRAINT channel_accounts_provider_check
  CHECK (provider IN ('wati', 'dripify', 'apollo', 'meta'));

ALTER TABLE public.inbox_messages DROP CONSTRAINT IF EXISTS inbox_messages_provider_check;
ALTER TABLE public.inbox_messages
  ADD CONSTRAINT inbox_messages_provider_check
  CHECK (provider IN ('wati', 'apollo', 'gmail', 'dripify', 'meta'));

CREATE UNIQUE INDEX IF NOT EXISTS channel_accounts_meta_phone_uniq
  ON public.channel_accounts ((config->>'phone_number_id'))
  WHERE provider = 'meta' AND status = 'connected';

CREATE INDEX IF NOT EXISTS channel_accounts_meta_waba_idx
  ON public.channel_accounts ((config->>'waba_id'))
  WHERE provider = 'meta';
