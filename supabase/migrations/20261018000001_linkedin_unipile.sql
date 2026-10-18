-- LinkedIn nativo (Unipile, 2026-10-17; docs/LINKEDIN_NATIVO.md).
--
--   • channel_accounts.provider acepta 'unipile': la cuenta de LinkedIn del
--     usuario conectada por el link embebido de Unipile. `secret` guarda el
--     account_id de Unipile (oculto al cliente por los grants de columna que
--     ya existen); `config` lo que la UI muestra y los topes.
--   • inbox_messages.provider acepta 'unipile': mensajes de LinkedIn enviados
--     y recibidos por la cuenta propia.
--   • Índices para que unipile-webhook encuentre la cuenta por account_id y el
--     lead por el provider_id / chat_id que el motor guarda en provider_refs.
--
-- Dripify sigue igual. Nada se borra. Idempotente.

ALTER TABLE public.channel_accounts
  DROP CONSTRAINT IF EXISTS channel_accounts_provider_check;
ALTER TABLE public.channel_accounts
  ADD CONSTRAINT channel_accounts_provider_check
  CHECK (provider IN ('wati', 'dripify', 'apollo', 'unipile'));

ALTER TABLE public.inbox_messages
  DROP CONSTRAINT IF EXISTS inbox_messages_provider_check;
ALTER TABLE public.inbox_messages
  ADD CONSTRAINT inbox_messages_provider_check
  CHECK (provider IN ('wati', 'apollo', 'gmail', 'dripify', 'unipile'));

CREATE INDEX IF NOT EXISTS channel_accounts_unipile_account_idx
  ON public.channel_accounts (secret)
  WHERE provider = 'unipile';

CREATE INDEX IF NOT EXISTS campaign_enrollments_unipile_provider_idx
  ON public.campaign_enrollments (user_id, (provider_refs->>'unipile_provider_id'))
  WHERE provider_refs ? 'unipile_provider_id';

CREATE INDEX IF NOT EXISTS campaign_enrollments_unipile_chat_idx
  ON public.campaign_enrollments (user_id, (provider_refs->>'unipile_chat_id'))
  WHERE provider_refs ? 'unipile_chat_id';
