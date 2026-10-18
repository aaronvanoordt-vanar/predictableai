-- Portugués de Brasil como idioma de la interfaz y de la IA (2026-10-17).
-- js/i18n.js ahora escribe 'pt-BR' en profiles.ui_language; engineForUser()
-- (_shared/llm.ts) lo lee y callLLM pide al modelo responder en portugués de
-- Brasil. Solo se amplía el CHECK de la migración 20260920000001.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_ui_language_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_ui_language_check CHECK (ui_language IN ('es', 'en', 'pt-BR'));

COMMENT ON COLUMN public.profiles.ui_language IS
  'Idioma de la interfaz y de los resultados de IA: es | en | pt-BR. Lo escribe js/i18n.js.';
