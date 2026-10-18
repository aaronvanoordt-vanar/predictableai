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

-- Los CHECK de `provider` los reescriben también otras migraciones paralelas
-- (LinkedIn nativo, buzones propios…), cada una con SU lista cerrada: la que
-- corriera última borraba los proveedores de las demás. Aquí se SUMA 'meta' a
-- lo que el CHECK ya permita, sin quitar nada (helper extend_provider_check,
-- para las próximas migraciones que agreguen un proveedor).
CREATE OR REPLACE FUNCTION public.extend_provider_check(p_table regclass, p_constraint text, p_values text[])
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_def  text;
  v_vals text[];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = p_table AND c.conname = p_constraint;
  -- Valores entre comillas simples del CHECK actual ('wati', 'dripify'…) + los nuevos.
  v_vals := ARRAY(
    SELECT DISTINCT v FROM (
      SELECT (regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g'))[1] AS v
      UNION SELECT unnest(p_values)
    ) s
    ORDER BY 1
  );
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', p_table, p_constraint);
  -- Se escribe como IN ('a', 'b', …): Postgres lo guarda como ARRAY['a'::text, …]
  -- y la próxima corrida lo vuelve a leer valor por valor (idempotente).
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (provider IN (%s))', p_table, p_constraint,
    (SELECT string_agg(quote_literal(x), ', ') FROM unnest(v_vals) AS x));
END;
$$;
REVOKE ALL ON FUNCTION public.extend_provider_check(regclass, text, text[]) FROM PUBLIC, anon, authenticated;

SELECT public.extend_provider_check('public.channel_accounts', 'channel_accounts_provider_check', ARRAY['wati', 'dripify', 'apollo', 'meta']);
SELECT public.extend_provider_check('public.inbox_messages', 'inbox_messages_provider_check', ARRAY['wati', 'apollo', 'gmail', 'dripify', 'meta']);

CREATE UNIQUE INDEX IF NOT EXISTS channel_accounts_meta_phone_uniq
  ON public.channel_accounts ((config->>'phone_number_id'))
  WHERE provider = 'meta' AND status = 'connected';

CREATE INDEX IF NOT EXISTS channel_accounts_meta_waba_idx
  ON public.channel_accounts ((config->>'waba_id'))
  WHERE provider = 'meta';
