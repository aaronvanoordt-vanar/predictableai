-- Instrucciones personalizadas para la investigación con IA.
--
-- El usuario puede acotar a qué parte de su web debe mirar enrich-company (p. ej.
-- "enfócate solo en la línea de valuación de activos"). Se guarda en la fila para
-- que sobreviva al refresh, para que la vuelva a usar la siguiente corrida sin
-- volver a escribirla, y para que generate-client-brief redacte el brief con el
-- mismo foco que la investigación.
--
-- Columna nullable y aditiva: la ausencia de este campo hacía fallar el
-- select completo de intel_hub_intake en el cliente (js/company-context.js
-- INTAKE_COLUMNS), lo que dejaba el contexto vacío y el gate bloqueando la
-- plataforma entera.
alter table public.intel_hub_intake
  add column if not exists company_enrichment_prompt text;

comment on column public.intel_hub_intake.company_enrichment_prompt is
  'Instrucción opcional del usuario para acotar el foco de la investigación con IA (enrich-company y generate-client-brief).';
