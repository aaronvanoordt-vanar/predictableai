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
-- Dripify sigue igual. Nada se borra. Idempotente. Va después de
-- 20261018161500_whatsapp_meta.sql, que crea extend_provider_check.

-- Se SUMA 'unipile' a lo que cada CHECK ya permita, sin quitar nada (helper
-- extend_provider_check de 20261018161500_whatsapp_meta.sql): una lista
-- cerrada aquí borraría 'meta' y cualquier otro proveedor agregado en paralelo.
SELECT public.extend_provider_check('public.channel_accounts', 'channel_accounts_provider_check', ARRAY['unipile']);
SELECT public.extend_provider_check('public.inbox_messages', 'inbox_messages_provider_check', ARRAY['unipile']);

CREATE INDEX IF NOT EXISTS channel_accounts_unipile_account_idx
  ON public.channel_accounts (secret)
  WHERE provider = 'unipile';

CREATE INDEX IF NOT EXISTS campaign_enrollments_unipile_provider_idx
  ON public.campaign_enrollments (user_id, (provider_refs->>'unipile_provider_id'))
  WHERE provider_refs ? 'unipile_provider_id';

CREATE INDEX IF NOT EXISTS campaign_enrollments_unipile_chat_idx
  ON public.campaign_enrollments (user_id, (provider_refs->>'unipile_chat_id'))
  WHERE provider_refs ? 'unipile_chat_id';
