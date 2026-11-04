-- ─────────────────────────────────────────────────────────────────────────────
-- Warm Up: constancia de un calentamiento hecho FUERA de Predictable
-- (2026-11-04, pedido del dueño para el espacio de HAI Educators).
--
-- El warm-up de las cuentas de HAI Educators (email, LinkedIn y WhatsApp) se
-- hizo del 12 al 31 de octubre de 2026 en otra plataforma, a la que se perdió
-- el acceso: sus registros de envío no se pueden exportar. Esta tabla guarda
-- SOLO lo que se puede afirmar con honestidad — el periodo declarado, quién lo
-- declara, en qué cuentas y que los registros no están disponibles — y la
-- página «Warm Up» (js/warmup.js) lo muestra junto al estado REAL de esas
-- cuentas medido por Predictable. Nunca guarda ni muestra mensajes, envíos o
-- respuestas: no hay ninguna fuente para ellos.
--
-- La página aparece solo en las cuentas que tienen una fila aquí. Escribe
-- únicamente la service role (SQL editor / migración); el usuario solo lee la
-- suya.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.warmup_attestations (
  user_id          uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  period_start     date        NOT NULL,
  period_end       date        NOT NULL,
  -- Dónde se hizo (texto libre; puede ir vacío si no se nombra la plataforma).
  executed_on      text        NOT NULL DEFAULT 'una plataforma externa',
  -- [{ channel: 'email'|'whatsapp'|'linkedin', label: text }]
  accounts         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- false = no hay registros de envío que mostrar (la página lo dice).
  logs_available   boolean     NOT NULL DEFAULT false,
  attested_by      text        NOT NULL,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warmup_attestations_period_check CHECK (period_end >= period_start)
);

ALTER TABLE public.warmup_attestations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.warmup_attestations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.warmup_attestations TO authenticated;

DROP POLICY IF EXISTS warmup_attestations_select_own ON public.warmup_attestations;
CREATE POLICY warmup_attestations_select_own ON public.warmup_attestations
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ── Constancia del espacio de HAI Educators ────────────────────────────────
-- La cuenta del espacio se encuentra por el cliente (clients.name); si el
-- espacio aún no existe, no se inserta nada y la página no aparece.
DO $$
DECLARE
  n integer;
BEGIN
  INSERT INTO public.warmup_attestations
    (user_id, period_start, period_end, executed_on, accounts, logs_available, attested_by, note)
  SELECT w.workspace_user_id,
         DATE '2026-10-12',
         DATE '2026-10-31',
         'una plataforma externa',
         jsonb_build_array(
           jsonb_build_object('channel', 'email',    'label', 'ggm@mit.edu'),
           jsonb_build_object('channel', 'linkedin', 'label', 'Geraldine García Medina'),
           jsonb_build_object('channel', 'whatsapp', 'label', '+1 555-704-2101')
         ),
         false,
         'Vanarsi',
         'Se perdió el acceso a la plataforma externa y sus registros de envío no se pueden exportar.'
    FROM public.client_workspaces w
    JOIN public.clients c ON c.id = w.client_id
   WHERE lower(c.name) LIKE 'hai educator%'
  ON CONFLICT (user_id) DO UPDATE
     SET period_start   = EXCLUDED.period_start,
         period_end     = EXCLUDED.period_end,
         executed_on    = EXCLUDED.executed_on,
         accounts       = EXCLUDED.accounts,
         logs_available = EXCLUDED.logs_available,
         attested_by    = EXCLUDED.attested_by,
         note           = EXCLUDED.note,
         updated_at     = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'warmup_attestations: % espacio(s) de HAI Educators', n;
END $$;
