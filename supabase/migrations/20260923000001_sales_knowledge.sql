-- ═══════════════════════════════════════════════════════════════════════════
-- Base de entrenamiento de la IA de campañas — 2026-09-23
--
-- Documentos propios del vendedor (frameworks de venta, scripts que ya
-- funcionaron, guías de estilo, manejo de objeciones, material de la
-- empresa) que la IA consulta ANTES de escribir cada mensaje de campaña.
-- Es un RAG léxico: la edge function trocea los documentos activos, puntúa
-- cada fragmento contra el paso (canal, ángulo, instrucciones) y el lead
-- (cargo, industria, empresa) y mete solo los más relevantes en el prompt
-- (`supabase/functions/_shared/sales-knowledge.ts`, cubierto por deno test).
--
-- Quién lo lee: generate-outreach (modo paso, vista previa y "Redactar con
-- IA" de la bandeja) y generate-campaign (cadencia recomendada), ambos con
-- la service role o el JWT del dueño. El cliente hace CRUD de sus filas.
--
-- `always_apply` = el documento entra siempre (un framework que manda sobre
-- todos los mensajes), no solo cuando la búsqueda lo encuentra relevante.
-- `results_note` = por qué es bueno ("32 % de respuesta en fintech"): la IA
-- lo usa para saber qué imitar.
--
-- Topes (trigger): 60 documentos por usuario, 60.000 caracteres cada uno.
-- RLS: CRUD del dueño. Sin grants a anon. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.sales_knowledge_docs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  title         TEXT        NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  -- framework  → metodología de venta (SPIN, Challenger, PAS, AIDA, propia…)
  -- script     → mensaje o secuencia que ya funcionó
  -- guideline  → guía de estilo / voz / qué nunca decir
  -- objections → manejo de objeciones
  -- document   → material de la empresa (one-pager, casos, pricing…)
  kind          TEXT        NOT NULL DEFAULT 'document'
                CHECK (kind IN ('framework', 'script', 'guideline', 'objections', 'document')),
  -- Canal al que aplica (sobre todo scripts); NULL = cualquiera.
  channel       TEXT        CHECK (channel IN ('email', 'whatsapp', 'linkedin')),
  body          TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 60000),
  source        TEXT        NOT NULL DEFAULT 'paste' CHECK (source IN ('paste', 'file')),
  file_name     TEXT,
  results_note  TEXT        CHECK (results_note IS NULL OR char_length(results_note) <= 400),
  always_apply  BOOLEAN     NOT NULL DEFAULT FALSE,
  enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sales_knowledge_docs_user_idx
  ON public.sales_knowledge_docs (user_id, enabled, updated_at DESC);

CREATE OR REPLACE FUNCTION public.sales_knowledge_docs_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (
    SELECT count(*) FROM public.sales_knowledge_docs WHERE user_id = NEW.user_id
  ) >= 60 THEN
    RAISE EXCEPTION 'sales_knowledge_limit: máximo 60 documentos por usuario';
  END IF;
  -- El dueño no se cambia en un UPDATE.
  IF TG_OP = 'UPDATE' THEN NEW.user_id := OLD.user_id; END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.sales_knowledge_docs_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sales_knowledge_docs_guard ON public.sales_knowledge_docs;
CREATE TRIGGER sales_knowledge_docs_guard
  BEFORE INSERT OR UPDATE ON public.sales_knowledge_docs
  FOR EACH ROW EXECUTE FUNCTION public.sales_knowledge_docs_guard();

ALTER TABLE public.sales_knowledge_docs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own sales_knowledge_docs" ON public.sales_knowledge_docs;
CREATE POLICY "Users can view own sales_knowledge_docs"
  ON public.sales_knowledge_docs FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own sales_knowledge_docs" ON public.sales_knowledge_docs;
CREATE POLICY "Users can insert own sales_knowledge_docs"
  ON public.sales_knowledge_docs FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own sales_knowledge_docs" ON public.sales_knowledge_docs;
CREATE POLICY "Users can update own sales_knowledge_docs"
  ON public.sales_knowledge_docs FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own sales_knowledge_docs" ON public.sales_knowledge_docs;
CREATE POLICY "Users can delete own sales_knowledge_docs"
  ON public.sales_knowledge_docs FOR DELETE TO authenticated USING (auth.uid() = user_id);

REVOKE ALL ON public.sales_knowledge_docs FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_knowledge_docs TO authenticated;
