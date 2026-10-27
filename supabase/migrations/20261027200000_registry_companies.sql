-- Registros públicos de toda Latam (2026-10-27, pedido del dueño).
--
-- Brasil, México y Colombia se consultan en vivo por API (20261017000031).
-- El resto de los países publica su registro de empresas solo como archivo
-- descargable (o no lo publica): esos archivos se importan a una tabla propia
-- con el workflow manual «Import Company Registry»
-- (.github/workflows/import-registry.yml + scripts/registry-import/), y la
-- edge function company-registry busca ahí. Fuentes, columnas y licencias
-- por país en docs/REGISTROS.md.
--
--   1. registry_companies — una fila por empresa (persona jurídica) de un
--      registro importado. Nunca personas naturales. Solo la service role lee
--      y escribe (la edge function filtra y devuelve; el navegador nunca la
--      consulta directo).
--   2. registry_imports — registro de cada importación (fuente, archivo,
--      filas, fecha de los datos) para mostrar al usuario qué tan frescos son.
--   3. registry_import_batch(rows jsonb) — upsert por lotes que usa el
--      importador con la service role.
--   4. registry_observations.registry admite los registros nuevos.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1 ── empresas de los registros importados ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.registry_companies (
  registry             TEXT        NOT NULL,
  registry_id          TEXT        NOT NULL,
  country              TEXT        NOT NULL,
  tax_id               TEXT        NOT NULL DEFAULT '',
  legal_name           TEXT        NOT NULL,
  trade_name           TEXT        NOT NULL DEFAULT '',
  name_norm            TEXT        NOT NULL DEFAULT '',
  activity_system      TEXT        NOT NULL DEFAULT 'isic4',
  activity_code        TEXT        NOT NULL DEFAULT '',
  activity_description TEXT        NOT NULL DEFAULT '',
  size_bucket          TEXT        NOT NULL DEFAULT '' CHECK (size_bucket IN ('', 'micro', 'small', 'medium', 'large')),
  size_label           TEXT        NOT NULL DEFAULT '',
  founded_on           DATE,
  founded_label        TEXT        NOT NULL DEFAULT '',
  status               TEXT        NOT NULL DEFAULT 'unknown' CHECK (status IN ('active', 'inactive', 'unknown')),
  status_detail        TEXT        NOT NULL DEFAULT '',
  address_line         TEXT        NOT NULL DEFAULT '',
  city                 TEXT        NOT NULL DEFAULT '',
  region               TEXT        NOT NULL DEFAULT '',
  postal_code          TEXT        NOT NULL DEFAULT '',
  phone                TEXT        NOT NULL DEFAULT '',
  email                TEXT        NOT NULL DEFAULT '',
  website              TEXT        NOT NULL DEFAULT '',
  source_url           TEXT        NOT NULL DEFAULT '',
  source_updated_on    DATE,
  imported_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (registry, registry_id)
);

COMMENT ON TABLE public.registry_companies IS
  'Empresas (personas jurídicas) de los registros públicos que solo se publican como archivo, importadas por scripts/registry-import. Solo service role: la lee company-registry.';

CREATE INDEX IF NOT EXISTS registry_companies_country_activity ON public.registry_companies (country, activity_code text_pattern_ops);
CREATE INDEX IF NOT EXISTS registry_companies_country_founded ON public.registry_companies (country, founded_on DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS registry_companies_tax_id ON public.registry_companies (country, tax_id) WHERE tax_id <> '';
CREATE INDEX IF NOT EXISTS registry_companies_name_trgm ON public.registry_companies USING gin (name_norm gin_trgm_ops);

ALTER TABLE public.registry_companies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.registry_companies FROM anon, authenticated, PUBLIC;

-- 2 ── importaciones ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.registry_imports (
  id                BIGSERIAL   PRIMARY KEY,
  registry          TEXT        NOT NULL,
  source_file       TEXT        NOT NULL DEFAULT '',
  rows_read         INTEGER     NOT NULL DEFAULT 0,
  rows_upserted     INTEGER     NOT NULL DEFAULT 0,
  rows_skipped      INTEGER     NOT NULL DEFAULT 0,
  source_updated_on DATE,
  status            TEXT        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  detail            TEXT        NOT NULL DEFAULT '',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS registry_imports_registry ON public.registry_imports (registry, finished_at DESC);

ALTER TABLE public.registry_imports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.registry_imports FROM anon, authenticated, PUBLIC;

-- 3 ── upsert por lotes (solo service role) ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.registry_import_batch(rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INTEGER;
BEGIN
  INSERT INTO public.registry_companies AS t (
    registry, registry_id, country, tax_id, legal_name, trade_name, name_norm,
    activity_system, activity_code, activity_description, size_bucket, size_label,
    founded_on, founded_label, status, status_detail, address_line, city, region,
    postal_code, phone, email, website, source_url, source_updated_on, imported_at
  )
  SELECT
    r->>'registry', r->>'registry_id', r->>'country', COALESCE(r->>'tax_id', ''),
    r->>'legal_name', COALESCE(r->>'trade_name', ''), COALESCE(r->>'name_norm', ''),
    COALESCE(NULLIF(r->>'activity_system', ''), 'isic4'), COALESCE(r->>'activity_code', ''), COALESCE(r->>'activity_description', ''),
    COALESCE(r->>'size_bucket', ''), COALESCE(r->>'size_label', ''),
    NULLIF(r->>'founded_on', '')::date, COALESCE(r->>'founded_label', ''),
    COALESCE(NULLIF(r->>'status', ''), 'unknown'), COALESCE(r->>'status_detail', ''),
    COALESCE(r->>'address_line', ''), COALESCE(r->>'city', ''), COALESCE(r->>'region', ''), COALESCE(r->>'postal_code', ''),
    COALESCE(r->>'phone', ''), COALESCE(r->>'email', ''), COALESCE(r->>'website', ''), COALESCE(r->>'source_url', ''),
    NULLIF(r->>'source_updated_on', '')::date, NOW()
  FROM jsonb_array_elements(rows) AS r
  WHERE COALESCE(r->>'registry', '') <> '' AND COALESCE(r->>'registry_id', '') <> '' AND COALESCE(r->>'legal_name', '') <> ''
  ON CONFLICT (registry, registry_id) DO UPDATE SET
    country = EXCLUDED.country, tax_id = EXCLUDED.tax_id,
    -- Un archivo parcial (p. ej. el de solo contactos) no borra lo que ya estaba.
    legal_name = EXCLUDED.legal_name,
    trade_name = COALESCE(NULLIF(EXCLUDED.trade_name, ''), t.trade_name),
    name_norm = EXCLUDED.name_norm,
    activity_system = EXCLUDED.activity_system,
    activity_code = COALESCE(NULLIF(EXCLUDED.activity_code, ''), t.activity_code),
    activity_description = COALESCE(NULLIF(EXCLUDED.activity_description, ''), t.activity_description),
    size_bucket = COALESCE(NULLIF(EXCLUDED.size_bucket, ''), t.size_bucket),
    size_label = COALESCE(NULLIF(EXCLUDED.size_label, ''), t.size_label),
    founded_on = COALESCE(EXCLUDED.founded_on, t.founded_on),
    founded_label = COALESCE(NULLIF(EXCLUDED.founded_label, ''), t.founded_label),
    status = CASE WHEN EXCLUDED.status = 'unknown' THEN t.status ELSE EXCLUDED.status END,
    status_detail = COALESCE(NULLIF(EXCLUDED.status_detail, ''), t.status_detail),
    address_line = COALESCE(NULLIF(EXCLUDED.address_line, ''), t.address_line),
    city = COALESCE(NULLIF(EXCLUDED.city, ''), t.city),
    region = COALESCE(NULLIF(EXCLUDED.region, ''), t.region),
    postal_code = COALESCE(NULLIF(EXCLUDED.postal_code, ''), t.postal_code),
    phone = COALESCE(NULLIF(EXCLUDED.phone, ''), t.phone),
    email = COALESCE(NULLIF(EXCLUDED.email, ''), t.email),
    website = COALESCE(NULLIF(EXCLUDED.website, ''), t.website),
    source_url = COALESCE(NULLIF(EXCLUDED.source_url, ''), t.source_url),
    source_updated_on = COALESCE(EXCLUDED.source_updated_on, t.source_updated_on),
    imported_at = NOW();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.registry_import_batch(JSONB) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.registry_import_batch(JSONB) TO service_role;

-- 4 ── el detector del Radar recuerda empresas de cualquier registro ─────────
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.registry_observations'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%registry%'
  LOOP
    EXECUTE format('ALTER TABLE public.registry_observations DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.registry_observations
  ADD CONSTRAINT registry_observations_registry_check CHECK (registry ~ '^[a-z0-9_]{2,24}$');
