-- Varias cuentas de LinkedIn por usuario (2026-11-25, pedido del dueño: pruebas
-- A/B entre cuentas).
--
-- Hasta hoy `channel_accounts` admitía UNA fila por (usuario, proveedor). Las
-- cuentas de LinkedIn propias (provider = 'unipile') pasan a ser varias por
-- usuario; WATI, Meta, Dripify y Apollo siguen con una sola (índice parcial).
--
-- ORDEN DE DESPLIEGUE: primero las edge functions de este cambio
-- (channel-connect, unipile-webhook, campaign-run, inbox-send, channel-guard),
-- después esta migración. El channel-connect anterior guardaba las cuentas con
-- un upsert `ON CONFLICT (user_id, provider)`, que deja de existir aquí; el
-- nuevo no lo usa y funciona con la tabla de antes y con la de después.
--
-- Nada se borra. Idempotente.

ALTER TABLE public.channel_accounts
  DROP CONSTRAINT IF EXISTS channel_accounts_user_provider_key;

-- Los demás proveedores: una fila por usuario, como siempre.
CREATE UNIQUE INDEX IF NOT EXISTS channel_accounts_user_single_provider_uniq
  ON public.channel_accounts (user_id, provider)
  WHERE provider <> 'unipile';

-- Búsqueda de las cuentas de un usuario (antes la daba la restricción única).
CREATE INDEX IF NOT EXISTS channel_accounts_user_provider_idx
  ON public.channel_accounts (user_id, provider);

-- Una cuenta de LinkedIn (su id en el proveedor) vive en una sola fila: ni dos
-- veces en el mismo usuario ni en dos usuarios. Las desconectadas guardan ''.
-- Si ya hubiera un duplicado, se avisa y se sigue: la aplicación también lo evita.
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS channel_accounts_unipile_secret_uniq
    ON public.channel_accounts (secret)
    WHERE provider = 'unipile' AND secret <> '';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'channel_accounts_unipile_secret_uniq no se creó: hay cuentas de LinkedIn repetidas.';
END $$;

-- Los envíos de LinkedIn guardan de qué cuenta salieron (payload.account_id):
-- los topes se cuentan por cuenta.
CREATE INDEX IF NOT EXISTS campaign_events_linkedin_account_idx
  ON public.campaign_events (user_id, (payload->>'account_id'), created_at)
  WHERE channel = 'linkedin' AND payload ? 'account_id';
