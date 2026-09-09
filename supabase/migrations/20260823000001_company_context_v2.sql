-- Contexto de la empresa v2 — dos bloques: datos internos (tu empresa) y
-- datos externos (a quién le vendes).
--
-- Hasta ahora el ICP externo vivía en cuatro columnas de texto libre
-- (icp_industries / icp_roles / icp_geographies / icp_company_sizes) que
-- NADIE editaba: se llenaban solas desde js/prospecting-data.js con los
-- filtros que el usuario hubiera usado en Búsqueda. O sea, la búsqueda
-- definía el ICP en vez de al revés, y al ser texto libre generate-client-brief
-- tenía que re-adivinar con un LLM los filtros de Apollo.
--
-- Estas columnas invierten esa relación: el usuario declara su ICP con la
-- taxonomía de Apollo (valores exactos, no texto libre) en el primer paso del
-- journey, y de ahí salen los filtros de búsqueda, el research del radar y el
-- contexto de los mensajes. Las columnas de texto viejas se siguen escribiendo
-- como espejo (ver js/company-context.js → legacyMirror) para no romper a
-- generate-radar / generate-client-brief / generate-coda, que ya las leen.

ALTER TABLE public.intel_hub_intake
  -- ── Bloque B: a quién le vendes (taxonomía Apollo, valores exactos) ──
  ADD COLUMN IF NOT EXISTS icp_countries        TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS icp_industry_tags    TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS icp_employee_ranges  TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS icp_departments      TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS icp_seniorities      TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS icp_titles           TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS icp_buying_triggers  TEXT,
  ADD COLUMN IF NOT EXISTS icp_disqualifiers    TEXT,

  -- ── Bloque A: tu empresa (datos internos) ──
  -- competitors: [{ "name": "...", "domain": "..." }]
  ADD COLUMN IF NOT EXISTS competitors            JSONB  NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS excluded_companies     TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS commercial_deal_size   TEXT,
  ADD COLUMN IF NOT EXISTS commercial_sales_cycle TEXT,
  ADD COLUMN IF NOT EXISTS commercial_model       TEXT,
  ADD COLUMN IF NOT EXISTS commercial_primary_cta TEXT,
  ADD COLUMN IF NOT EXISTS outreach_signature     TEXT,
  ADD COLUMN IF NOT EXISTS outreach_tone          TEXT,
  ADD COLUMN IF NOT EXISTS outreach_channels      TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS outreach_language      TEXT,
  -- social_proof:      [{ "client": "...", "industry": "...", "result": "..." }]
  -- common_objections: [{ "objection": "...", "neutralizer": "..." }]
  ADD COLUMN IF NOT EXISTS social_proof           JSONB  NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS common_objections      JSONB  NOT NULL DEFAULT '[]'::jsonb,
  -- Prueba social y objeciones son obligatorias, pero un vendedor que arranca
  -- puede no tener todavía un caso publicable o una objeción real escuchada.
  -- Forzarlo a llenar el campo sería pedirle que invente datos (regla dura del
  -- producto), así que la salida honesta es declararlo explícitamente: la
  -- tarjeta queda completa marcando esto, no inventando una fila.
  ADD COLUMN IF NOT EXISTS social_proof_none      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS objections_none        BOOLEAN NOT NULL DEFAULT FALSE,

  -- Confirmación explícita del usuario. El gate de la plataforma exige
  -- campos completos Y esta marca: que la IA haya llenado todo no equivale
  -- a que el usuario lo haya revisado. enrich-company solo puede sobrescribir
  -- los campos del ICP mientras esto sea NULL (antes de la confirmación);
  -- después solo rellena huecos.
  ADD COLUMN IF NOT EXISTS context_confirmed_at   TIMESTAMPTZ;

-- Las políticas RLS de intel_hub_intake ya son owner-scoped (select/insert/
-- update propias, sin grants a anon/PUBLIC): las columnas nuevas las heredan.
