-- ═══════════════════════════════════════════════════════════════════════════
-- Inteligencia universal: el feedback del Intelligence Hub entra al bucle
-- (2026-09-23)
--
-- `intel_hub_feedback` (👍/👎 por hallazgo, y desde hoy también cada hallazgo
-- convertido en acción: nota `accion:<tipo>`) e `intel_hub_learning` (reglas
-- destiladas por segmento) existen en producción desde la generación v2 del
-- Hub, pero se crearon fuera del repo. Esta migración las declara tal como
-- están en producción (idempotente: allí no cambia nada) para que un entorno
-- nuevo las tenga, y añade el índice que usan learning-loop y
-- _shared/intelligence.ts para leer lo reciente de cada usuario.
--
-- Escritores: el navegador inserta en intel_hub_feedback (RLS: solo lo suyo);
-- intel_hub_learning solo la escribe la service role (learning-loop).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.intel_hub_feedback (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  section_key  TEXT        NOT NULL,
  report_id    UUID        REFERENCES public.intelligence_hub_reports(id) ON DELETE SET NULL,
  item_index   INTEGER,
  item_title   TEXT,
  rating       TEXT        NOT NULL CHECK (rating IN ('up', 'down')),
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.intel_hub_learning (
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  section_key      TEXT        NOT NULL,
  distilled_rules  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  feedback_count   INTEGER     NOT NULL DEFAULT 0,
  last_distilled   TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, section_key)
);

CREATE INDEX IF NOT EXISTS intel_hub_feedback_user_created_idx
  ON public.intel_hub_feedback (user_id, created_at DESC);

ALTER TABLE public.intel_hub_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intel_hub_learning ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_hub_feedback FROM anon, PUBLIC;
REVOKE ALL ON public.intel_hub_learning FROM anon, PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'intel_hub_feedback' AND policyname = 'users read own feedback') THEN
    CREATE POLICY "users read own feedback" ON public.intel_hub_feedback FOR SELECT TO authenticated USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'intel_hub_feedback' AND policyname = 'users insert own feedback') THEN
    CREATE POLICY "users insert own feedback" ON public.intel_hub_feedback FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'intel_hub_feedback' AND policyname = 'users update own feedback') THEN
    CREATE POLICY "users update own feedback" ON public.intel_hub_feedback FOR UPDATE TO authenticated USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'intel_hub_feedback' AND policyname = 'users delete own feedback') THEN
    CREATE POLICY "users delete own feedback" ON public.intel_hub_feedback FOR DELETE TO authenticated USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'intel_hub_learning' AND policyname = 'users read own learning') THEN
    CREATE POLICY "users read own learning" ON public.intel_hub_learning FOR SELECT TO authenticated USING (auth.uid() = user_id);
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.intel_hub_feedback TO authenticated;
GRANT SELECT ON public.intel_hub_learning TO authenticated;
-- Las reglas las destila el servidor: el cliente no puede fabricarlas.
REVOKE INSERT, UPDATE, DELETE ON public.intel_hub_learning FROM authenticated;
