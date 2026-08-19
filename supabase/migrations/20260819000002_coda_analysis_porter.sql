-- coda_analysis: add the "5 fuerzas de Porter" block (AI-generated, same
-- pattern as PESTEL) alongside the existing PESTEL and FODA→CAME blocks.
-- The feature user-facing name changed from "CODA AI" to "Contexto
-- estratégico IA" (index.html), but the table/edge-function names stay as
-- coda_analysis / generate-coda — renaming those is out of scope here.
--
-- porter block: Rivalidad entre competidores / Amenaza de nuevos entrantes /
-- Amenaza de sustitutos / Poder de negociación de clientes / Poder de
-- negociación de proveedores — each translated into a concrete sales impact,
-- same shape as pestel's per-factor objects.

alter table public.coda_analysis
  add column if not exists porter              jsonb       not null default '{}'::jsonb,
  add column if not exists porter_status        text        not null default 'idle'
                                                 check (porter_status in ('idle','generating','ready','error')),
  add column if not exists porter_error         text,
  add column if not exists porter_generated_at  timestamptz;
