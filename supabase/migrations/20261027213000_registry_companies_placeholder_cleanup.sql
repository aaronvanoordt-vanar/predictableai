-- Limpia los marcadores de «sin dato» que la primera carga del Directorio de
-- Empresas Industriales de Uruguay (dei) guardó como valor ("S/D" en nombre
-- comercial, departamento…). El importador ya los trata como vacío
-- (NULLISH en scripts/registry-import/map.mjs), pero registry_import_batch
-- no pisa un valor con uno vacío, así que lo ya cargado se limpia aquí.
-- Idempotente.
UPDATE public.registry_companies
SET trade_name    = CASE WHEN trade_name    ~* '^s/?d$' THEN '' ELSE trade_name END,
    region        = CASE WHEN region        ~* '^s/?d$' THEN '' ELSE region END,
    city          = CASE WHEN city          ~* '^s/?d$' THEN '' ELSE city END,
    address_line  = CASE WHEN address_line  ~* '^s/?d$' THEN '' ELSE address_line END,
    status_detail = CASE WHEN status_detail ~* '^s/?d$' THEN '' ELSE status_detail END,
    activity_description = CASE WHEN activity_description ~* '^s/?d$' THEN '' ELSE activity_description END,
    name_norm     = btrim(regexp_replace(regexp_replace(name_norm, '(^| )s d( |$)', ' ', 'g'), ' +', ' ', 'g'))
WHERE trade_name ~* '^s/?d$' OR region ~* '^s/?d$' OR city ~* '^s/?d$' OR address_line ~* '^s/?d$'
   OR status_detail ~* '^s/?d$' OR activity_description ~* '^s/?d$' OR name_norm ~ '(^| )s d( |$)';
