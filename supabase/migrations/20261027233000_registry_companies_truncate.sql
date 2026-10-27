-- Emergencia (2026-10-27): la carga de los registros importados llenó el disco
-- de la base de producción ("could not extend file … No space left on device").
-- Se vacía registry_companies (solo datos importados hoy, se pueden volver a
-- cargar) para liberar el espacio de inmediato: TRUNCATE devuelve los archivos
-- de la tabla y de sus índices al disco, DELETE no.
--
-- Con el disco lleno Supabase puede poner la base en solo lectura; esta sesión
-- vuelve a lectura y escritura solo para poder vaciar la tabla.
SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE;

TRUNCATE TABLE public.registry_companies;

-- Las cargas que quedaron a medias se marcan para que company-registry no
-- presente ese conteo como la cobertura del registro.
UPDATE public.registry_imports
SET status = 'failed', finished_at = COALESCE(finished_at, NOW()),
    detail = CASE WHEN detail = '' THEN 'Vaciado por falta de disco (2026-10-27)' ELSE detail || ' · vaciado por falta de disco (2026-10-27)' END
WHERE status <> 'failed' OR detail NOT LIKE '%falta de disco%';
