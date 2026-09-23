-- El enriquecimiento (enrich-list y el respaldo del navegador) guardaba la
-- persona de Apollo solo en `snapshot` y nunca copiaba LinkedIn, país ni
-- ciudad a las columnas: la búsqueda ya no los trae, así que la columna
-- LinkedIn de Listas salía vacía y el paso de LinkedIn de las campañas
-- omitía al lead. El código ya los copia (_shared/person-fill.ts); esto
-- rellena las filas enriquecidas antes. Solo huecos: nunca pisa un valor.
update public.prospect_list_members m
set
  linkedin_url = coalesce(nullif(btrim(m.linkedin_url), ''), nullif(btrim(m.snapshot->>'linkedin_url'), '')),
  country      = coalesce(nullif(btrim(m.country), ''),      nullif(btrim(m.snapshot->>'country'), '')),
  city         = coalesce(nullif(btrim(m.city), ''),         nullif(btrim(m.snapshot->>'city'), '')),
  state        = coalesce(nullif(btrim(m.state), ''),        nullif(btrim(m.snapshot->>'state'), ''))
where jsonb_typeof(m.snapshot) = 'object'
  and (
    (nullif(btrim(m.linkedin_url), '') is null and nullif(btrim(m.snapshot->>'linkedin_url'), '') is not null)
    or (nullif(btrim(m.country), '') is null and nullif(btrim(m.snapshot->>'country'), '') is not null)
    or (nullif(btrim(m.city), '') is null and nullif(btrim(m.snapshot->>'city'), '') is not null)
    or (nullif(btrim(m.state), '') is null and nullif(btrim(m.snapshot->>'state'), '') is not null)
  );
