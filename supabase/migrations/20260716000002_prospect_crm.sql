-- ═══════════════════════════════════════════════════════════════════════════
-- Prospect CRM: contact status pipeline + local message templates — 2026-07-16
--
-- 1. prospect_list_members.contact_status — CRM pipeline column shown in the
--    new "Contactos" tab and editable from the WhatsApp inbox ("Reunión
--    conseguida"). Statuses (product-defined, in Spanish because they are
--    data values consumed verbatim by the UI):
--      no_contactado   → aún no se le escribe
--      saludo_enviado  → solo se envió el primer mensaje / campaña
--      reunion_agendada→ botón "Reunión conseguida"
--      reunion_tomada  → la reunión ya ocurrió
--      no_interesado   → respondió que no
--      no_show         → no se presentó a la reunión
--    The dashboard "Reuniones generadas" KPI counts reunion_agendada +
--    reunion_tomada, so meetings tracked anywhere surface on the home page.
--
-- 2. message_templates — user-owned, CLIENT-WRITABLE plain-text templates for
--    WhatsApp campaigns ({{nombre}}, {{empresa}}, {{rol}} variables). These
--    are independent from whatsapp_templates (Meta-approved templates, which
--    stay service-role-write-only): local templates never touch the Graph
--    API, so users can create/preview them even without a WABA ID and without
--    waiting for Meta approval.
--
-- 3. prospect_list_members joins the realtime publication so the Contactos
--    (CRM) view refreshes live when a contact is updated from any other tab
--    or device (postgres_changes respects the owner-scoped RLS).
--
-- All statements are idempotent and non-destructive (safe to re-apply).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. CRM status on prospect members ───────────────────────────────────────

ALTER TABLE public.prospect_list_members
  ADD COLUMN IF NOT EXISTS contact_status TEXT NOT NULL DEFAULT 'no_contactado';

ALTER TABLE public.prospect_list_members
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;

DO $$
BEGIN
  ALTER TABLE public.prospect_list_members
    ADD CONSTRAINT prospect_list_members_contact_status_check
    CHECK (contact_status IN (
      'no_contactado', 'saludo_enviado', 'reunion_agendada',
      'reunion_tomada', 'no_interesado', 'no_show'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Keep status_changed_at honest without trusting the client clock.
CREATE OR REPLACE FUNCTION public.touch_contact_status_changed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.contact_status IS DISTINCT FROM OLD.contact_status THEN
    NEW.status_changed_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.touch_contact_status_changed_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS prospect_list_members_status_changed_at ON public.prospect_list_members;
CREATE TRIGGER prospect_list_members_status_changed_at
  BEFORE UPDATE ON public.prospect_list_members
  FOR EACH ROW EXECUTE FUNCTION public.touch_contact_status_changed_at();

-- Dashboard KPI ("Reuniones generadas") filters by owner + status.
CREATE INDEX IF NOT EXISTS prospect_list_members_status_idx
  ON public.prospect_list_members (user_id, contact_status);

-- ── 2. Local message templates (campaign texts, not Meta templates) ─────────

CREATE TABLE IF NOT EXISTS public.message_templates (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  -- Free text with {{nombre}} / {{empresa}} / {{rol}} variables.
  body        TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4096),
  -- Canal objetivo (hoy solo se envía por WhatsApp; LinkedIn/email se copian).
  channel     TEXT        NOT NULL DEFAULT 'whatsapp'
              CHECK (channel IN ('whatsapp', 'linkedin', 'email')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT message_templates_user_name_key UNIQUE (user_id, name)
);

DROP TRIGGER IF EXISTS message_templates_updated_at ON public.message_templates;
CREATE TRIGGER message_templates_updated_at
  BEFORE UPDATE ON public.message_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own message templates" ON public.message_templates;
CREATE POLICY "Users can view own message templates"
  ON public.message_templates FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own message templates" ON public.message_templates;
CREATE POLICY "Users can insert own message templates"
  ON public.message_templates FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own message templates" ON public.message_templates;
CREATE POLICY "Users can update own message templates"
  ON public.message_templates FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own message templates" ON public.message_templates;
CREATE POLICY "Users can delete own message templates"
  ON public.message_templates FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Default-deny for anon (no policies + no grants).
REVOKE ALL ON public.message_templates FROM anon;

CREATE INDEX IF NOT EXISTS message_templates_user_id_idx
  ON public.message_templates (user_id, created_at DESC);

-- ── 3. Realtime: live CRM updates ───────────────────────────────────────────
-- postgres_changes respects RLS, so subscribers only ever see their own rows.

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.prospect_list_members;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
