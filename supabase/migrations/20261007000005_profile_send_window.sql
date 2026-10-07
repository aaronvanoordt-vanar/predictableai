-- Horario de envío por defecto de las campañas (2026-10-07).
-- Se edita en Ajustes y solo siembra el borrador de las campañas NUEVAS en
-- js/campaign-builder.js; cada campaña guarda su propia ventana
-- (campaigns.timezone / send_start_hour / send_end_hour / send_days) y
-- campaign-run sigue leyendo solo esa. Las campañas existentes no cambian.
-- El usuario ya actualiza su propia fila de profiles por RLS; no toca `role`.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS send_window JSONB;

COMMENT ON COLUMN public.profiles.send_window IS
  'Horario de envío por defecto de campañas nuevas: {timezone, start_hour 0-23, end_hour 1-24, days [1-7]}. NULL = 9–18 L–V en la zona del navegador.';
