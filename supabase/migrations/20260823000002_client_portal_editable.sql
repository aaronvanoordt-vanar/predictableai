-- ═══════════════════════════════════════════════════════════════════════════
-- Portal del cliente editable sin login (2026-08-23)
--
-- Hasta ahora client.html?token=… era SOLO LECTURA y exigía que el cliente
-- final creara una cuenta (RPC claim_client_access → fila en client_access →
-- SELECT vía RLS). A partir de aquí el share_token es una *capability*: quien
-- tiene el link entra sin login y puede editar su propio contexto.
--
-- El token NO se convierte en una credencial de base de datos: `anon` no
-- recibe ningún permiso nuevo aquí. Todo el portal pasa por la edge function
-- `client-portal`, que valida el token con la service role y solo deja tocar
-- una allowlist de campos (icp, industries, historical_notes,
-- target_countries) + su foto + sus PDFs de material de apoyo. Las métricas
-- del CRM, el status, las fechas y los links de trabajo siguen siendo del
-- equipo.
--
-- Esta migración solo abre hueco en el esquema para eso:
--   1. clients.portal_can_edit  — interruptor por cliente (default true).
--   2. clients.portal_updated_at — última edición hecha DESDE el portal.
--   3. client_materials.uploaded_by pasa a NULLABLE — un archivo subido desde
--      el portal no tiene auth.users detrás.
--   4. client_materials.source ('team' | 'portal') — de dónde vino el archivo.
--      El portal solo puede borrar los suyos ('portal'); los del equipo son
--      intocables desde fuera.
--
-- Todas las sentencias son idempotentes y no destructivas.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── clients ─────────────────────────────────────────────────────────────────

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS portal_can_edit BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS portal_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN public.clients.portal_can_edit IS
  'Si es false, client.html?token=… queda en solo lectura (el link sigue abriendo el dashboard).';
COMMENT ON COLUMN public.clients.portal_updated_at IS
  'Última vez que el cliente final editó algo desde el portal (no lo toca el equipo).';

-- ── client_materials ────────────────────────────────────────────────────────

ALTER TABLE public.client_materials
  ALTER COLUMN uploaded_by DROP NOT NULL;

ALTER TABLE public.client_materials
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'team';

-- ADD COLUMN IF NOT EXISTS no añade el CHECK si la columna ya existía, así que
-- va aparte para que re-aplicar la migración deje siempre el mismo estado.
ALTER TABLE public.client_materials
  DROP CONSTRAINT IF EXISTS client_materials_source_check;
ALTER TABLE public.client_materials
  ADD CONSTRAINT client_materials_source_check CHECK (source IN ('team', 'portal'));

COMMENT ON COLUMN public.client_materials.uploaded_by IS
  'NULL cuando el archivo lo subió el cliente final desde el portal (no hay auth.users).';
COMMENT ON COLUMN public.client_materials.source IS
  'team = lo subió el equipo desde Clients; portal = lo subió el cliente desde client.html.';

-- ── RLS: sin cambios de superficie para el cliente web ──────────────────────
-- client_materials_insert exigía uploaded_by = auth.uid(); con la columna ya
-- nullable hay que permitir explícitamente el NULL para que la service role no
-- dependa de saltarse RLS por accidente, pero SIN abrirle la puerta a un
-- usuario autenticado que quiera insertar filas anónimas en clientes ajenos:
-- el can_manage_client(client_id) sigue mandando.
DROP POLICY IF EXISTS "client_materials_insert" ON public.client_materials;
CREATE POLICY "client_materials_insert"
  ON public.client_materials FOR INSERT
  TO authenticated
  WITH CHECK (public.can_manage_client(client_id) AND uploaded_by = auth.uid());
