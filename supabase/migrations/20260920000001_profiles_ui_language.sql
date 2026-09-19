-- Idioma de la interfaz por usuario (2026-09-20).
-- js/i18n.js lo escribe al cambiar ES/EN; las edge functions con IA lo leen en
-- engineForUser() (_shared/llm.ts) y piden al modelo que responda en ese idioma,
-- así los reportes del Hub, las señales del Radar, los mensajes y el coach salen
-- en el idioma que el usuario eligió, no solo la interfaz.
-- El usuario ya puede actualizar su propia fila de profiles por RLS (nombre,
-- empresa, ai_engines); esta columna sigue la misma regla y no toca `role`.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ui_language TEXT NOT NULL DEFAULT 'es'
  CHECK (ui_language IN ('es', 'en'));

COMMENT ON COLUMN public.profiles.ui_language IS
  'Idioma de la interfaz y de los resultados de IA: es | en. Lo escribe js/i18n.js.';
