-- ¿El número está en WhatsApp? — lo aprendido de los envíos (2026-10-17).
--
-- Una fila por número y por usuario (clave = phone_key, la misma de
-- _shared/phone-lines.ts `reachKey`: 52 1 / 54 9 se guardan como 52 / 54):
--
--   • no_whatsapp  — Meta respondió #131026 «mensaje no entregable» (no está
--                    en WhatsApp, bloqueó al negocio o no aceptó los términos)
--                    o WATI rechazó el número al enviar. campaign-run ya no le
--                    manda plantillas en NINGUNA campaña: el paso se omite.
--   • has_whatsapp — un envío se entregó / se leyó o el número escribió por
--                    WhatsApp. Manda sobre la heurística (un fijo con WhatsApp
--                    Business deja de omitirse) y levanta un no_whatsapp viejo.
--
-- Va por número y no por fila de lista: la misma persona puede estar en
-- varias listas y la marca tiene que valer en todas. Es por usuario a
-- propósito: compartirla entre cuentas revelaría a quién le escribió otro
-- cliente.
--
-- Solo la service role escribe (campaign-run, wati-webhook). El usuario lee
-- las suyas (indicador de Listas y del enrolamiento) y puede borrar una
-- («Volver a intentar») si sabe que el número ya tiene WhatsApp.

CREATE TABLE IF NOT EXISTS public.whatsapp_reachability (
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_key   TEXT        NOT NULL CHECK (phone_key ~ '^[0-9]{6,20}$'),
  status      TEXT        NOT NULL CHECK (status IN ('has_whatsapp', 'no_whatsapp')),
  code        TEXT,
  detail      TEXT        CHECK (detail IS NULL OR char_length(detail) <= 500),
  source      TEXT,
  member_id   UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, phone_key)
);

COMMENT ON TABLE public.whatsapp_reachability IS
  'Lo aprendido de los envíos de WhatsApp por número: no_whatsapp (#131026, el motor no vuelve a intentarlo) o has_whatsapp (entregado o escribió). Escribe solo la service role.';

ALTER TABLE public.whatsapp_reachability ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_reachability_select_own ON public.whatsapp_reachability;
CREATE POLICY whatsapp_reachability_select_own ON public.whatsapp_reachability
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS whatsapp_reachability_delete_own ON public.whatsapp_reachability;
CREATE POLICY whatsapp_reachability_delete_own ON public.whatsapp_reachability
  FOR DELETE TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON public.whatsapp_reachability FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.whatsapp_reachability TO authenticated;
GRANT ALL ON public.whatsapp_reachability TO service_role;
