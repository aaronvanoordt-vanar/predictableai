-- Mapa de TAM (2026-10-17, docs/ROADMAP_GTM_OS.md §1 ítem 11).
--
--   • tam_maps      — una fila por usuario: países y segmentos del mapa, las
--                     reglas de tiers A/B/C (_shared/tam.ts ↔ js/tam-rules.js)
--                     y las celdas medidas en Apollo: por país × segmento, el
--                     total de empresas y de personas del ICP según
--                     pagination.total_entries, con los filtros usados y la
--                     fecha. Nunca un número estimado.
--   • tam_accounts  — empresas que el usuario cargó de Apollo para una celda
--                     (dominio, nombre, país, segmento y rango de tamaño por
--                     el que se filtró). Es una FOTO DEL MERCADO, no el CRM:
--                     el objeto Cuenta del CRM nativo (otra sesión) se enlaza
--                     por (user_id, domain) cuando exista, sin copiar filas.
--
-- Solo la edge function `tam-map` (service role) escribe: los totales tienen
-- que ser los que devolvió Apollo y las reglas pasan por normalizeRules. El
-- usuario solo lee lo suyo.

CREATE TABLE IF NOT EXISTS public.tam_maps (
  user_id     UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  countries   TEXT[]      NOT NULL DEFAULT '{}',
  segments    JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- [{key,name,industries,employee_ranges,keywords}]
  rules       JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- TamRules
  cells       JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- [{country,segment_key,accounts_total,people_total,filters,fetched_at,error}]
  measured_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.tam_accounts (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  domain         TEXT        NOT NULL,
  name           TEXT,
  apollo_org_id  TEXT,
  website        TEXT,
  linkedin_url   TEXT,
  country        TEXT,
  segment_key    TEXT,
  industries     TEXT[]      NOT NULL DEFAULT '{}',
  employee_range TEXT,
  source         TEXT        NOT NULL DEFAULT 'apollo',
  loaded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tam_accounts_user_domain_key UNIQUE (user_id, domain)
);

CREATE INDEX IF NOT EXISTS tam_accounts_user_cell_idx ON public.tam_accounts (user_id, country, segment_key);

DROP TRIGGER IF EXISTS tam_maps_updated_at ON public.tam_maps;
CREATE TRIGGER tam_maps_updated_at
  BEFORE UPDATE ON public.tam_maps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.tam_maps     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tam_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own tam map" ON public.tam_maps;
CREATE POLICY "Users read own tam map"
  ON public.tam_maps FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users read own tam accounts" ON public.tam_accounts;
CREATE POLICY "Users read own tam accounts"
  ON public.tam_accounts FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Sin políticas de escritura: solo la service role (edge function tam-map).
REVOKE ALL ON public.tam_maps, public.tam_accounts FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.tam_maps, public.tam_accounts FROM authenticated;
GRANT SELECT ON public.tam_maps, public.tam_accounts TO authenticated;

COMMENT ON TABLE public.tam_maps IS
  'Mapa de TAM por usuario: países, segmentos, reglas de tiers y celdas medidas en Apollo (total_entries + fecha). Escribe solo la edge function tam-map.';
COMMENT ON TABLE public.tam_accounts IS
  'Empresas cargadas de Apollo para una celda del Mapa de TAM (foto del mercado, no el CRM). Se enlaza al objeto Cuenta del CRM por (user_id, domain).';
