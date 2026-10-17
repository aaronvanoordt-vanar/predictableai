-- ═══════════════════════════════════════════════════════════════════════════
-- Píxel de visitantes web propio + detector `site_visitors` del Radar — 2026-10-17
--
-- Hoja de ruta GTM OS §1 ítem 13 (docs/ROADMAP_GTM_OS.md). Hasta hoy el Radar
-- solo veía visitas a través de Apollo Website Visitors (`website_visitors`,
-- exige la cuenta propia del cliente con esa función). Ahora el cliente pega
-- un script liviano (px.js, en la raíz del sitio de Predictable) en su web y
-- las visitas llegan a la edge function pública `pixel-collect`.
--
--   • web_pixel_sites  — un sitio por fila, con su clave pública (`px_…`, va
--     en el HTML del cliente: NO es un secreto) y las páginas de alta
--     intención. Solo la edge function `web-pixel` (JWT) la escribe.
--   • web_pixel_hits   — SOLO visitas cuya IP se resolvió a una EMPRESA.
--     Nunca guarda la IP: guarda un hash con sal secreta que rota cada
--     semana (sirve para agrupar páginas en visitas) y la empresa resuelta.
--     Las visitas desde ISP residenciales, móviles, hosting o sin resolver no
--     dejan fila: solo suman en el contador del día.
--   • web_pixel_daily  — contadores por sitio y día (eventos, resueltos, ISP,
--     hosting, sin resolver, DNT/GPC, bots, fuera de dominio). Es la medición
--     de cobertura: en Latam la resolución IP → empresa es baja y la UI lo
--     muestra con números reales.
--   • web_pixel_ip_cache — IP (hasheada) → resultado del proveedor de reverse
--     IP, 30 días. Sin grants.
--
-- Retención: hits 90 días, caché 30 días (web_pixel_purge(), la llama
-- pixel-collect de vez en cuando; también se puede programar con pg_cron).
--
-- Amplía el CHECK de radar_detectors.kind con 'site_visitors'.
-- Idempotente (seguro de re-aplicar).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1. Sitios ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.web_pixel_sites (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_key           TEXT        NOT NULL UNIQUE DEFAULT ('px_' || encode(gen_random_bytes(12), 'hex'))
                                 CHECK (site_key ~ '^px_[a-f0-9]{24}$'),
  domain             TEXT        NOT NULL CHECK (domain ~ '^[a-z0-9.-]{3,253}$'),
  high_intent_paths  TEXT[]      NOT NULL DEFAULT ARRAY['/precios','/pricing','/planes','/plans','/demo','/contacto','/contact','/cotiza','/agenda'],
  enabled            BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_event_at      TIMESTAMPTZ,
  verified_at        TIMESTAMPTZ,
  install_check      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (user_id, domain)
);

CREATE INDEX IF NOT EXISTS web_pixel_sites_user_idx ON public.web_pixel_sites (user_id);

ALTER TABLE public.web_pixel_sites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.web_pixel_sites FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.web_pixel_sites TO authenticated;

DROP POLICY IF EXISTS "Users can view own pixel sites" ON public.web_pixel_sites;
CREATE POLICY "Users can view own pixel sites"
  ON public.web_pixel_sites FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ── 2. Visitas resueltas a una empresa ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.web_pixel_hits (
  id              BIGSERIAL   PRIMARY KEY,
  site_id         UUID        NOT NULL REFERENCES public.web_pixel_sites(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  path            TEXT        NOT NULL CHECK (char_length(path) <= 200),
  high_intent     BOOLEAN     NOT NULL DEFAULT FALSE,
  visitor         TEXT        NOT NULL CHECK (visitor ~ '^[a-f0-9]{16}$'),
  company_domain  TEXT        NOT NULL CHECK (char_length(company_domain) <= 253),
  company_name    TEXT        CHECK (char_length(company_name) <= 200),
  company_type    TEXT        CHECK (char_length(company_type) <= 20),
  country         TEXT        CHECK (char_length(country) <= 60),
  provider        TEXT        CHECK (char_length(provider) <= 30)
);

CREATE INDEX IF NOT EXISTS web_pixel_hits_user_at_idx ON public.web_pixel_hits (user_id, at DESC);
CREATE INDEX IF NOT EXISTS web_pixel_hits_site_at_idx ON public.web_pixel_hits (site_id, at DESC);

ALTER TABLE public.web_pixel_hits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.web_pixel_hits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.web_pixel_hits TO authenticated;

DROP POLICY IF EXISTS "Users can view own pixel hits" ON public.web_pixel_hits;
CREATE POLICY "Users can view own pixel hits"
  ON public.web_pixel_hits FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ── 3. Contadores diarios (cobertura) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.web_pixel_daily (
  site_id     UUID    NOT NULL REFERENCES public.web_pixel_sites(id) ON DELETE CASCADE,
  user_id     UUID    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day         DATE    NOT NULL,
  events      INTEGER NOT NULL DEFAULT 0,   -- todo lo que llegó con una clave válida
  resolved    INTEGER NOT NULL DEFAULT 0,   -- IP → empresa
  isp         INTEGER NOT NULL DEFAULT 0,   -- ISP residencial / móvil
  hosting     INTEGER NOT NULL DEFAULT 0,   -- nube, VPN, centro de datos
  unresolved  INTEGER NOT NULL DEFAULT 0,   -- el proveedor no supo o falló
  opted_out   INTEGER NOT NULL DEFAULT 0,   -- DNT / GPC que llegó igual al servidor
  bots        INTEGER NOT NULL DEFAULT 0,
  rejected    INTEGER NOT NULL DEFAULT 0,   -- dominio que no es el del sitio, rate limit, tope diario
  by_country  JSONB   NOT NULL DEFAULT '{}'::jsonb,  -- país → { events, resolved }
  PRIMARY KEY (site_id, day)
);

CREATE INDEX IF NOT EXISTS web_pixel_daily_user_idx ON public.web_pixel_daily (user_id, day DESC);

ALTER TABLE public.web_pixel_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.web_pixel_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.web_pixel_daily TO authenticated;

DROP POLICY IF EXISTS "Users can view own pixel daily" ON public.web_pixel_daily;
CREATE POLICY "Users can view own pixel daily"
  ON public.web_pixel_daily FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ── 4. Caché IP → empresa (sin grants: solo la service role) ───────────────

CREATE TABLE IF NOT EXISTS public.web_pixel_ip_cache (
  ip_hash      TEXT        PRIMARY KEY CHECK (ip_hash ~ '^[a-f0-9]{32}$'),
  result       JSONB       NOT NULL,
  resolved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.web_pixel_ip_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.web_pixel_ip_cache FROM PUBLIC, anon, authenticated;

-- ── 5. Contar un evento (atómico) ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.web_pixel_count(
  p_site_id  UUID,
  p_outcome  TEXT,
  p_country  TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user   UUID;
  v_day    DATE := (NOW() AT TIME ZONE 'UTC')::date;
  v_events INTEGER;
  v_c      TEXT := NULLIF(left(coalesce(p_country, ''), 60), '');
  v_res    INTEGER := CASE WHEN p_outcome = 'resolved' THEN 1 ELSE 0 END;
BEGIN
  IF p_outcome NOT IN ('resolved','isp','hosting','unresolved','opted_out','bots','rejected') THEN
    RAISE EXCEPTION 'bad outcome %', p_outcome;
  END IF;
  SELECT user_id INTO v_user FROM web_pixel_sites WHERE id = p_site_id;
  IF v_user IS NULL THEN RETURN 0; END IF;

  INSERT INTO web_pixel_daily (site_id, user_id, day) VALUES (p_site_id, v_user, v_day)
  ON CONFLICT (site_id, day) DO NOTHING;

  EXECUTE format(
    'UPDATE web_pixel_daily SET events = events + 1, %I = %I + 1 WHERE site_id = $1 AND day = $2 RETURNING events',
    p_outcome, p_outcome)
  INTO v_events USING p_site_id, v_day;

  IF v_c IS NOT NULL AND (SELECT count(*) FROM jsonb_object_keys((SELECT by_country FROM web_pixel_daily WHERE site_id = p_site_id AND day = v_day))) < 60 THEN
    UPDATE web_pixel_daily
       SET by_country = jsonb_set(by_country, ARRAY[v_c], jsonb_build_object(
             'events',   coalesce((by_country -> v_c ->> 'events')::int, 0) + 1,
             'resolved', coalesce((by_country -> v_c ->> 'resolved')::int, 0) + v_res), true)
     WHERE site_id = p_site_id AND day = v_day;
  END IF;

  RETURN coalesce(v_events, 0);
END $$;

REVOKE ALL ON FUNCTION public.web_pixel_count(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_pixel_count(UUID, TEXT, TEXT) TO service_role;

-- ── 6. Retención ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.web_pixel_purge()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM web_pixel_hits     WHERE at < NOW() - INTERVAL '90 days';
  DELETE FROM web_pixel_ip_cache WHERE resolved_at < NOW() - INTERVAL '30 days';
  DELETE FROM web_pixel_daily    WHERE day < (NOW() - INTERVAL '400 days')::date;
$$;

REVOKE ALL ON FUNCTION public.web_pixel_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_pixel_purge() TO service_role;

-- ── 7. Radar: nuevo kind `site_visitors` ────────────────────────────────────
-- La allowlist real vive en supabase/functions/_shared/radar-plan.ts (espejo
-- en js/radar-live.js); este CHECK solo evita basura.

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
                  'web_footprint', 'site_visitors'));
