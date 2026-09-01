-- Sobrante de la integración con la Cloud API de Meta
-- (20260715000002_whatsapp_notes.sql): las notas colgaban de
-- whatsapp_conversations, que 20260902000001 ya eliminó. Aplicada en
-- producción el 2026-09-01 junto con la migración principal.
DROP TABLE IF EXISTS public.whatsapp_notes CASCADE;
