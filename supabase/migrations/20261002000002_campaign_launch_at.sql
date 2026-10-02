-- Campañas programadas: fecha y hora de inicio.
--
-- campaigns.launch_at (UTC) en el futuro = la campaña está programada. El
-- status sigue siendo el de siempre ('active' cuando el usuario la programó):
-- campaign-run no ejecuta ningún paso de una campaña cuyo launch_at no llegó
-- y suelta el enrolamiento con next_run_at = launch_at. NULL o una fecha
-- pasada = arranca en cuanto está activa (comportamiento de siempre).
-- El cliente ya puede actualizar campaigns (RLS del dueño): no hace falta
-- ningún grant nuevo.

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS launch_at TIMESTAMPTZ;

COMMENT ON COLUMN public.campaigns.launch_at IS
  'Inicio programado (UTC). Mientras sea futuro, campaign-run no envía nada de esta campaña.';
