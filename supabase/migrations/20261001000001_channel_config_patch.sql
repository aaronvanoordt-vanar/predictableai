-- Parche atómico de channel_accounts.config (2026-10-01).
--
-- Varios procesos reescribían el JSONB entero a partir de una copia leída
-- antes ({...acc.config, x}): wati-webhook al sellar webhook.last_received_at,
-- la sincronización del historial de campaign-run, inbox-send… Con decenas de
-- recibos de WATI llegando a la vez, uno de ellos pisaba config.send_block
-- (el bloqueo 131037 que sella el mismo webhook) con su copia vieja, el motor
-- dejaba de ver el bloqueo y reintentaba TODOS los WhatsApp retenidos en la
-- misma corrida en vez de UN lead de prueba: 273 intentos para 100 leads.
--
-- Esta función mezcla solo las claves de primer nivel que se le pasan y quita
-- las de p_unset en una sola sentencia: lo que otro proceso escribió en las
-- demás claves se conserva.
CREATE OR REPLACE FUNCTION public.patch_channel_config(
  p_id    UUID,
  p_set   JSONB  DEFAULT '{}'::jsonb,
  p_unset TEXT[] DEFAULT '{}'::text[]
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.channel_accounts
     SET config = (COALESCE(config, '{}'::jsonb) || COALESCE(p_set, '{}'::jsonb)) - COALESCE(p_unset, '{}'::text[])
   WHERE id = p_id
  RETURNING config;
$$;

-- Default-deny: solo las edge functions (service role).
REVOKE ALL ON FUNCTION public.patch_channel_config(UUID, JSONB, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.patch_channel_config(UUID, JSONB, TEXT[]) TO service_role;
