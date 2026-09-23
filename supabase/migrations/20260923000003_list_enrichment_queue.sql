-- Enriquecimiento de listas en el servidor (2026-09-23).
--
-- Antes el reveal de emails/teléfonos corría en el navegador: cerrar la
-- pestaña lo cortaba a medias y dejaba filas en «Enriqueciendo…» para
-- siempre. Ahora la cola vive en la propia fila de prospect_list_members y la
-- procesa la edge function enrich-list (pg_cron cada minuto con la service
-- role, y el navegador la dispara al encolar para que empiece al instante).
--
--   enrich_requested_at  → no NULL = en cola (la UI lo muestra «Pendiente»)
--   enrich_mode          → 'email': recién guardado desde Buscar (bulk_match
--                          sin revelar + crear contacto en Apollo);
--                          'full': «Enriquecer seleccionados» (/people/match
--                          con email personal y, opcional, teléfono)
--   enrich_reveal_phones → solo en 'full'
--   enrich_claimed_at    → lease de la invocación que la tomó (se reclama de
--                          nuevo si una invocación muere a medias)
--   enrich_attempts      → tras 3 reclamos sin terminar, la fila se cierra
--                          con error en vez de reintentarse para siempre
--   enrich_error         → por qué terminó sin datos (se muestra en la tabla)
--
-- La tabla ya es client-writable con RLS por dueño y está en la publicación
-- realtime: el cliente encola sus filas y ve el avance fila por fila.

ALTER TABLE public.prospect_list_members
  ADD COLUMN IF NOT EXISTS enrich_requested_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS enrich_mode          TEXT
    CHECK (enrich_mode IS NULL OR enrich_mode IN ('email', 'full')),
  ADD COLUMN IF NOT EXISTS enrich_reveal_phones BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS enrich_claimed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS enrich_attempts      SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS enrich_error         TEXT;

CREATE INDEX IF NOT EXISTS prospect_list_members_enrich_queue_idx
  ON public.prospect_list_members (enrich_requested_at)
  WHERE enrich_requested_at IS NOT NULL;

-- Reclamo atómico de un lote de la cola (FOR UPDATE SKIP LOCKED): el cron y
-- el disparo del navegador pueden correr a la vez sin procesar dos veces la
-- misma fila. p_user_id NULL = cualquier usuario (cron).
CREATE OR REPLACE FUNCTION public.claim_enrichment_batch(
  p_user_id       UUID,
  p_limit         INTEGER,
  p_lease_seconds INTEGER DEFAULT 180
)
RETURNS SETOF public.prospect_list_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT m.id
      FROM public.prospect_list_members m
     WHERE m.enrich_requested_at IS NOT NULL
       AND (m.enrich_claimed_at IS NULL
            OR m.enrich_claimed_at < NOW() - make_interval(secs => GREATEST(p_lease_seconds, 30)))
       AND (p_user_id IS NULL OR m.user_id = p_user_id)
     ORDER BY m.enrich_requested_at, m.id
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 10), 50))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.prospect_list_members m
     SET enrich_claimed_at = NOW(),
         enrich_attempts   = m.enrich_attempts + 1
    FROM picked
   WHERE m.id = picked.id
  RETURNING m.*;
END;
$$;

-- Default-deny: solo la edge function (service role) reclama lotes.
REVOKE ALL ON FUNCTION public.claim_enrichment_batch(UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_enrichment_batch(UUID, INTEGER, INTEGER) TO service_role;

-- pg_cron (ejecutar en el SQL editor DESPUÉS de desplegar enrich-list; lleva
-- la service role, por eso no va en la migración):
--
-- SELECT cron.schedule('enrich-list', '* * * * *', $cron$
--   SELECT net.http_post(
--     url     := 'https://<project-ref>.supabase.co/functions/v1/enrich-list',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'),
--     body    := '{"mode":"cron"}'::jsonb,
--     timeout_milliseconds := 150000);
-- $cron$);
