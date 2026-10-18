-- Registros públicos de empresas (2026-10-17, ROADMAP_GTM_OS §4).
--
-- Fuentes: CNPJ de Brasil (CNPJá para buscar, BrasilAPI para la ficha),
-- DENUE del INEGI (México) y el registro mercantil de Confecámaras publicado
-- en datos.gov.co (Colombia). Diseño, licencias y lo que quedó fuera (Perú,
-- Chile) en docs/REGISTROS.md. Nada se importa a Postgres: se consulta en
-- vivo (el CNPJ completo son ~222 M filas; ver el costo en el doc).
--
--   1. prospect_list_members.registry — ficha del registro de la EMPRESA del
--      lead (identificador fiscal, actividad, fecha de constitución, socios,
--      estado). La escribe la edge function company-registry (enriquecimiento
--      de cuenta) o el guardado desde Buscar → Empresas. Hereda la RLS por
--      dueño de prospect_list_members.
--   2. registry_observations — memoria del detector `public_registry` del
--      Radar para notar cambios de actividad o de tamaño entre dos corridas.
--      Solo la service role (radar-monitor) lee y escribe.
--   3. radar_detectors.kind admite 'public_registry'.

-- 1 ── ficha del registro en el lead ─────────────────────────────────────────
ALTER TABLE public.prospect_list_members
  ADD COLUMN IF NOT EXISTS registry JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.prospect_list_members.registry IS
  'Ficha del registro público de la empresa (company-registry): {registry: cnpj|denue|rues, tax_id, activity, founded_on, status, partners[{name, role, since}], source_url, fetched_at}. Socios: solo nombre, cargo y fecha (sin CPF ni edad).';

-- 2 ── observaciones del detector de registros ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.registry_observations (
  detector_id   UUID        NOT NULL REFERENCES public.radar_detectors(id) ON DELETE CASCADE,
  registry      TEXT        NOT NULL CHECK (registry IN ('cnpj', 'denue', 'rues')),
  registry_id   TEXT        NOT NULL,
  activity_code TEXT,
  size_bucket   TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (detector_id, registry, registry_id)
);

COMMENT ON TABLE public.registry_observations IS
  'Lo último que el detector public_registry vio de cada empresa (actividad y tramo de tamaño) para detectar cambios entre corridas. Solo service role.';

ALTER TABLE public.registry_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.registry_observations FROM anon, authenticated, PUBLIC;

-- 3 ── nuevo tipo de detector ────────────────────────────────────────────────
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.radar_detectors'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%kind%website_visitors%'
  LOOP
    EXECUTE format('ALTER TABLE public.radar_detectors DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.radar_detectors
  ADD CONSTRAINT radar_detectors_kind_check
  CHECK (kind IN ('news', 'hiring', 'technographics', 'site_probe', 'funding',
                  'leadership', 'growth', 'tenders', 'presence', 'website_visitors',
                  'web_footprint', 'public_registry'));
