-- ═══════════════════════════════════════════════════════════════════════════
-- Campañas de LinkedIn de un solo propósito — 2026-09-15
--
-- Hasta ahora un paso `linkedin_connect` subía el lead a una campaña de
-- Dripify que traía su PROPIA secuencia (invitación + mensajes + esperas).
-- Esa secuencia la ejecuta Dripify sola: seguía mandando mensajes aunque el
-- lead ya hubiera respondido por WhatsApp o por email, porque la regla de
-- parada de Predictable no puede detener lo que corre allá.
--
-- Arreglo: la Open API de Dripify solo sabe subir leads a una campaña, así
-- que cada campaña de Dripify hace UNA cosa y Predictable decide cuándo
-- entra el lead a cada una:
--   purpose = 'connect' → la campaña solo manda la solicitud de conexión.
--   purpose = 'message' → la campaña solo manda un mensaje (el lead ya
--                         aceptó la conexión; lo verifica el motor).
-- El grafo de la cadencia usa `linkedin_connect` para la primera y
-- `linkedin_message` para la segunda (_shared/campaign-flow.ts).
--
-- Las filas existentes son de conexión: ese es el default.
-- Idempotente (seguro de re-aplicar).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.linkedin_campaigns
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'connect';

ALTER TABLE public.linkedin_campaigns DROP CONSTRAINT IF EXISTS linkedin_campaigns_purpose_check;
ALTER TABLE public.linkedin_campaigns
  ADD CONSTRAINT linkedin_campaigns_purpose_check CHECK (purpose IN ('connect', 'message'));

COMMENT ON COLUMN public.linkedin_campaigns.purpose IS
  'connect = la campaña de Dripify solo manda la solicitud de conexión; message = solo manda un mensaje a un lead ya conectado. Una campaña de Dripify con varios pasos seguiría enviando aunque el lead responda por otro canal.';
