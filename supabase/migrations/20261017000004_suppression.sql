-- ═══════════════════════════════════════════════════════════════════════════
-- Lista de supresión («No contactar») por usuario y por canal — 2026-10-17
--
-- A quién NO se le escribe ni se le llama, con la prueba de por qué:
--
--   • suppression_entries — una fila por identificador (email, teléfono,
--     dominio o LinkedIn) y canal ('all', 'email', 'whatsapp', 'linkedin',
--     'phone'). `source` dice de dónde vino (la baja del lead por respuesta,
--     enlace List-Unsubscribe o botón de WhatsApp; carga manual; CSV; registro
--     oficial; API), `legal_basis` qué es (opt_out = el titular lo pidió,
--     registry = registro oficial de exclusión, user_policy = decisión del
--     equipo) y `evidence` la prueba (texto del lead, id del mensaje, archivo,
--     registro y fecha de descarga). Nunca se borra: se revoca con motivo
--     (revoked_at / revoked_reason / revoked_by), así el registro queda
--     completo.
--   • suppression_imports — cada CSV o archivo de registro cargado, con su
--     fecha de descarga y de vigencia, cuántos números traía, cuántos se
--     guardaron y si cubre todo el archivo o solo los contactos que el
--     usuario tenía ese día (coverage).
--   • suppression_upsert(user_id, rows) — la única escritura. Solo la service
--     role (edge functions `suppression`, `campaign-run`, `wati-webhook`,
--     `dripify-webhook`, `public-api`). No pisa una fila vigente salvo para
--     dejar constancia de una baja del titular sobre otra base, o para
--     refrescar un registro oficial con su nueva importación; reactiva una
--     fila revocada.
--   • suppression_stats() — conteos por canal, origen y base para la
--     pantalla (RLS del usuario).
--
-- El chequeo vive en supabase/functions/_shared/suppression.ts
-- (isSuppressed), cubierto por deno test.
--
-- Idempotente (seguro de re-aplicar).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Importaciones ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.suppression_imports (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind             TEXT        NOT NULL CHECK (kind IN ('csv', 'registry')),
  registry         TEXT        CHECK (registry IS NULL OR registry IN (
                                 'repep_mx', 'rne_co', 'no_llame_ar', 'no_molestar_cl', 'procon_sp_br')),
  file_name        TEXT        CHECK (char_length(file_name) <= 300),
  channels         TEXT[]      NOT NULL DEFAULT '{}',
  reason           TEXT        CHECK (char_length(reason) <= 500),
  downloaded_at    DATE,
  valid_until      DATE,
  -- 'all' = se guardaron todos los números del archivo; 'contacts' = el archivo
  -- era grande y se guardaron solo los que coincidían con tus contactos de ese día.
  coverage         TEXT        NOT NULL DEFAULT 'all' CHECK (coverage IN ('all', 'contacts')),
  rows_in_file     INTEGER     NOT NULL DEFAULT 0 CHECK (rows_in_file >= 0),
  contacts_checked INTEGER     CHECK (contacts_checked >= 0),
  added            INTEGER     NOT NULL DEFAULT 0,
  updated          INTEGER     NOT NULL DEFAULT 0,
  invalid          INTEGER     NOT NULL DEFAULT 0,
  status           TEXT        NOT NULL DEFAULT 'importing' CHECK (status IN ('importing', 'done', 'superseded', 'failed')),
  superseded_by    UUID        REFERENCES public.suppression_imports(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS suppression_imports_user_idx ON public.suppression_imports (user_id, created_at DESC);

ALTER TABLE public.suppression_imports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.suppression_imports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.suppression_imports TO authenticated;
GRANT ALL ON public.suppression_imports TO service_role;

DROP POLICY IF EXISTS "Users can view own suppression imports" ON public.suppression_imports;
CREATE POLICY "Users can view own suppression imports"
  ON public.suppression_imports FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ── 2. Entradas ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.suppression_entries (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind           TEXT        NOT NULL CHECK (kind IN ('email', 'phone', 'domain', 'linkedin')),
  value          TEXT        NOT NULL CHECK (char_length(value) BETWEEN 1 AND 320),
  match_key      TEXT        NOT NULL CHECK (char_length(match_key) BETWEEN 1 AND 320),
  channel        TEXT        NOT NULL CHECK (channel IN ('all', 'email', 'whatsapp', 'linkedin', 'phone')),
  source         TEXT        NOT NULL CHECK (source IN ('reply', 'list_unsubscribe', 'whatsapp_button', 'manual', 'csv', 'registry', 'api')),
  legal_basis    TEXT        NOT NULL CHECK (legal_basis IN ('opt_out', 'registry', 'user_policy')),
  reason         TEXT        CHECK (char_length(reason) <= 500),
  evidence       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  import_id      UUID        REFERENCES public.suppression_imports(id) ON DELETE SET NULL,
  member_id      UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT        CHECK (char_length(revoked_reason) <= 500),
  revoked_by     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (user_id, kind, value, channel)
);

CREATE INDEX IF NOT EXISTS suppression_entries_match_idx
  ON public.suppression_entries (user_id, match_key) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS suppression_entries_user_created_idx
  ON public.suppression_entries (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS suppression_entries_import_idx
  ON public.suppression_entries (import_id) WHERE import_id IS NOT NULL;

ALTER TABLE public.suppression_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.suppression_entries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.suppression_entries TO authenticated;
GRANT ALL ON public.suppression_entries TO service_role;

DROP POLICY IF EXISTS "Users can view own suppression entries" ON public.suppression_entries;
CREATE POLICY "Users can view own suppression entries"
  ON public.suppression_entries FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ── 3. Escritura (solo service role) ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.suppression_upsert(p_user_id UUID, p_rows JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_added   INTEGER := 0;
  v_updated INTEGER := 0;
BEGIN
  IF p_user_id IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN jsonb_build_object('added', 0, 'updated', 0);
  END IF;
  WITH ins AS (
    INSERT INTO public.suppression_entries AS s
      (user_id, kind, value, match_key, channel, source, legal_basis, reason, evidence, import_id, member_id)
    SELECT p_user_id, r.kind, r.value, r.match_key, r.channel, r.source, r.legal_basis, r.reason,
           COALESCE(r.evidence, '{}'::jsonb), r.import_id, r.member_id
      FROM jsonb_to_recordset(p_rows) AS r(
        kind TEXT, value TEXT, match_key TEXT, channel TEXT, source TEXT, legal_basis TEXT,
        reason TEXT, evidence JSONB, import_id UUID, member_id UUID)
    ON CONFLICT (user_id, kind, value, channel) DO UPDATE SET
      source         = EXCLUDED.source,
      legal_basis    = EXCLUDED.legal_basis,
      reason         = EXCLUDED.reason,
      -- Lo que había antes queda dentro de la prueba nueva (salvo al renovar
      -- un registro oficial, que solo cambia de importación): así el registro
      -- conserva la revocación o la base anterior.
      evidence       = CASE WHEN EXCLUDED.source = 'registry' AND s.source = 'registry' THEN EXCLUDED.evidence
                            ELSE EXCLUDED.evidence || jsonb_build_object('previous', jsonb_build_object(
                                   'source', s.source, 'legal_basis', s.legal_basis, 'reason', s.reason,
                                   'created_at', s.created_at, 'revoked_at', s.revoked_at,
                                   'revoked_reason', s.revoked_reason, 'evidence', s.evidence)) END,
      import_id      = EXCLUDED.import_id,
      member_id      = COALESCE(EXCLUDED.member_id, s.member_id),
      created_at     = CASE WHEN s.revoked_at IS NOT NULL THEN NOW() ELSE s.created_at END,
      updated_at     = NOW(),
      revoked_at     = NULL,
      revoked_reason = NULL,
      revoked_by     = NULL
    -- Una fila vigente solo se reescribe para dejar constancia de la baja del
    -- titular (gana sobre cualquier otra base) o para pasarla a la importación
    -- nueva del mismo registro oficial. Lo demás se respeta tal cual.
    WHERE s.revoked_at IS NOT NULL
       OR (EXCLUDED.legal_basis = 'opt_out' AND s.legal_basis <> 'opt_out')
       OR (EXCLUDED.source = 'registry' AND s.source = 'registry')
    RETURNING (xmax = 0) AS inserted
  )
  SELECT COUNT(*) FILTER (WHERE inserted), COUNT(*) FILTER (WHERE NOT inserted)
    INTO v_added, v_updated
    FROM ins;
  RETURN jsonb_build_object('added', v_added, 'updated', v_updated);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.suppression_upsert(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.suppression_upsert(UUID, JSONB) TO service_role;

-- ── 4. Conteos para la pantalla ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.suppression_stats()
RETURNS TABLE (channel TEXT, source TEXT, legal_basis TEXT, kind TEXT, active BIGINT, revoked BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT e.channel, e.source, e.legal_basis, e.kind,
         COUNT(*) FILTER (WHERE e.revoked_at IS NULL),
         COUNT(*) FILTER (WHERE e.revoked_at IS NOT NULL)
    FROM public.suppression_entries e
   WHERE e.user_id = auth.uid()
   GROUP BY 1, 2, 3, 4;
$$;

REVOKE EXECUTE ON FUNCTION public.suppression_stats() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.suppression_stats() TO authenticated;
