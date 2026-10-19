-- Se elimina el Mapa de TAM (decisión del dueño, 2026-10-19): funcionalidad
-- demasiado compleja. Quita las tablas que creó 20261018000002_tam_map.sql.
-- Idempotente: si no existen, no hace nada.

DROP TABLE IF EXISTS public.tam_accounts;
DROP TABLE IF EXISTS public.tam_maps;
