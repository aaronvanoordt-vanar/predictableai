-- Radar: nuevo tipo de detector `web_footprint` (huella pública en internet).
--
-- Busca empresas por un ESTADO visible en la web (tienda oficial en Mercado
-- Libre o Amazon, directorios, expositores de ferias, quejas públicas), no
-- por una noticia fechada. La allowlist real vive en
-- supabase/functions/_shared/radar-plan.ts (espejo en js/radar-live.js); este
-- CHECK solo evita basura, así que hay que ampliarlo para que el insert no
-- falle.

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
                  'web_footprint'));
