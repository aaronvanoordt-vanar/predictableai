-- Investigación previa por lead (Listas, 2026-10-08).
--
--   • research_notes  — notas libres del vendedor sobre el lead (las escribe
--                        el usuario desde Listas; entran como contexto en la
--                        investigación IA, en los pasos de campaña y en el coach).
--   • research        — resultado de la edge function lead-research: verificación
--                        del puesto actual (Apollo + búsqueda web), resumen de la
--                        empresa, señales y el ángulo de abordaje sugerido.
--   • research_status — idle | running | ready | error. 'running' evita que dos
--                        clics cobren dos veces (la función reclama la fila).
--
-- Son columnas del propio lead: heredan la RLS por dueño de
-- prospect_list_members, sin políticas nuevas.

ALTER TABLE public.prospect_list_members
  ADD COLUMN IF NOT EXISTS research_notes  TEXT,
  ADD COLUMN IF NOT EXISTS research        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS research_status TEXT  NOT NULL DEFAULT 'idle';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prospect_list_members_research_notes_len') THEN
    ALTER TABLE public.prospect_list_members
      ADD CONSTRAINT prospect_list_members_research_notes_len
      CHECK (research_notes IS NULL OR char_length(research_notes) <= 5000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prospect_list_members_research_status_chk') THEN
    ALTER TABLE public.prospect_list_members
      ADD CONSTRAINT prospect_list_members_research_status_chk
      CHECK (research_status IN ('idle', 'running', 'ready', 'error'));
  END IF;
END $$;

COMMENT ON COLUMN public.prospect_list_members.research_notes IS
  'Notas del vendedor para la investigación previa del lead (Listas).';
COMMENT ON COLUMN public.prospect_list_members.research IS
  'Investigación IA del lead (edge function lead-research): employment {status: current|outdated|unconfirmed|unknown, …}, company, person, angle, sources.';
