-- ═══════════════════════════════════════════════════════════════════════════
-- Entrenamiento IA (2026-09-23): un Predictable distinto para cada empresa.
--
-- Cada cuenta entrena al Meeting Coach y a las campañas con:
--   ai_training        una fila por usuario: metodologías de venta para el
--                      coach y para las campañas (ids del catálogo de
--                      supabase/functions/_shared/sales-training.ts), estilo
--                      de comunicación, personalidad del coach y reglas
--                      propias (siempre / nunca). La edita el usuario.
--   ai_training_docs   su base de conocimiento: libros de venta, playbooks,
--                      casos, precios, battlecards, llamadas modelo… subidos
--                      en PDF (bucket privado `ai-training`) o pegados como
--                      texto. La edge function `ai-training` los destila a
--                      principios accionables (`summary`, service role); el
--                      usuario decide si aplican al coach, a las campañas o a
--                      ambos, puede apagarlos y puede corregir el resumen.
--
-- Lo leen sales-coach, generate-outreach y generate-campaign con la service
-- role (loadTraining). Sin fila, todo se comporta como antes.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ai_training (
  user_id          UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  coach_methods    TEXT[]      NOT NULL DEFAULT '{}',
  campaign_methods TEXT[]      NOT NULL DEFAULT '{}',
  -- { address: 'tu'|'usted', length: 'breve'|'medio'|'detallado',
  --   emojis: 'nunca'|'a_veces', voice, words_use, words_avoid, examples }
  style            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  coach_persona    TEXT,
  rules_always     TEXT,
  rules_never      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_training_methods_len CHECK (cardinality(coach_methods) <= 6 AND cardinality(campaign_methods) <= 6),
  CONSTRAINT ai_training_text_len CHECK (
    coalesce(length(coach_persona), 0) <= 2000 AND
    coalesce(length(rules_always), 0) <= 3000 AND
    coalesce(length(rules_never), 0) <= 3000 AND
    length(style::text) <= 12000
  )
);

ALTER TABLE public.ai_training ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_training FROM anon, public;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_training TO authenticated;

DROP POLICY IF EXISTS "ai_training own select" ON public.ai_training;
CREATE POLICY "ai_training own select" ON public.ai_training
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "ai_training own insert" ON public.ai_training;
CREATE POLICY "ai_training own insert" ON public.ai_training
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "ai_training own update" ON public.ai_training;
CREATE POLICY "ai_training own update" ON public.ai_training
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "ai_training own delete" ON public.ai_training;
CREATE POLICY "ai_training own delete" ON public.ai_training
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS ai_training_touch ON public.ai_training;
CREATE TRIGGER ai_training_touch
  BEFORE UPDATE ON public.ai_training
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


CREATE TABLE IF NOT EXISTS public.ai_training_docs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title           TEXT        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind            TEXT        NOT NULL DEFAULT 'other'
                  CHECK (kind IN ('book', 'playbook', 'case', 'pricing', 'battlecard', 'call', 'other')),
  source          TEXT        NOT NULL CHECK (source IN ('upload', 'text')),
  file_name       TEXT,
  storage_path    TEXT,
  size_bytes      BIGINT,
  raw_text        TEXT        CHECK (raw_text IS NULL OR length(raw_text) <= 60000),
  summary         TEXT        CHECK (summary IS NULL OR length(summary) <= 8000),
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'analyzing', 'done', 'error')),
  error_message   TEXT,
  apply_coach     BOOLEAN     NOT NULL DEFAULT TRUE,
  apply_campaigns BOOLEAN     NOT NULL DEFAULT TRUE,
  enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_training_docs_source_payload CHECK (
    (source = 'upload' AND storage_path IS NOT NULL) OR
    (source = 'text' AND raw_text IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ai_training_docs_user_idx ON public.ai_training_docs (user_id, created_at);

ALTER TABLE public.ai_training_docs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_training_docs FROM anon, public, authenticated;
GRANT SELECT, INSERT, DELETE ON public.ai_training_docs TO authenticated;
-- status / error_message los escribe solo la edge function (service role). El
-- usuario puede renombrar, reclasificar, elegir a qué aplica, apagarlo y
-- corregir el resumen destilado (es SU entrenamiento).
GRANT UPDATE (title, kind, apply_coach, apply_campaigns, enabled, summary) ON public.ai_training_docs TO authenticated;

DROP POLICY IF EXISTS "ai_training_docs own select" ON public.ai_training_docs;
CREATE POLICY "ai_training_docs own select" ON public.ai_training_docs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
-- Un documento nace 'pending': el cliente no puede insertar uno ya "analizado".
-- El PDF tiene que estar en SU carpeta: la edge function lo descarga con la
-- service role, así que un storage_path ajeno sería leer el archivo de otro.
DROP POLICY IF EXISTS "ai_training_docs own insert" ON public.ai_training_docs;
CREATE POLICY "ai_training_docs own insert" ON public.ai_training_docs
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id AND status = 'pending' AND summary IS NULL AND error_message IS NULL
    AND (storage_path IS NULL OR split_part(storage_path, '/', 1) = auth.uid()::text)
  );
DROP POLICY IF EXISTS "ai_training_docs own update" ON public.ai_training_docs;
CREATE POLICY "ai_training_docs own update" ON public.ai_training_docs
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "ai_training_docs own delete" ON public.ai_training_docs;
CREATE POLICY "ai_training_docs own delete" ON public.ai_training_docs
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS ai_training_docs_touch ON public.ai_training_docs;
CREATE TRIGGER ai_training_docs_touch
  BEFORE UPDATE ON public.ai_training_docs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_training_docs;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Storage: privado, una carpeta por usuario (<user_id>/<uuid>.pdf) ────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('ai-training', 'ai-training', false, 20971520, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "ai training owner select" ON storage.objects;
CREATE POLICY "ai training owner select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'ai-training' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "ai training owner upload" ON storage.objects;
CREATE POLICY "ai training owner upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'ai-training' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "ai training owner delete" ON storage.objects;
CREATE POLICY "ai training owner delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'ai-training' AND (storage.foldername(name))[1] = auth.uid()::text);
