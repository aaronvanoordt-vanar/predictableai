-- ═══════════════════════════════════════════════════════════════════════════
-- WhatsApp message templates (Meta approval workflow) — 2026-07-16
--
-- Lets a user compose a WhatsApp template (header/body/footer/buttons) inside
-- predictable.ai and submit it to Meta's WhatsApp Manager for review, instead
-- of leaving Meta Business Suite as the only place to do so (WATI-style).
--
-- Write model: exactly like whatsapp_accounts — ALL writes (create, status
-- sync, delete) happen inside the whatsapp-send edge function (service role)
-- so every payload is validated against the Graph API before being persisted
-- and the local `status` always reflects what Meta actually decided. The
-- client only ever SELECTs its own rows.
--
-- All statements are idempotent and non-destructive (safe to re-apply).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.whatsapp_templates (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id        UUID        NOT NULL REFERENCES public.whatsapp_accounts(id) ON DELETE CASCADE,
  -- Meta requires lowercase snake_case names, unique per WABA + language.
  name              TEXT        NOT NULL CHECK (name ~ '^[a-z0-9_]{1,512}$'),
  category          TEXT        NOT NULL CHECK (category IN ('MARKETING', 'UTILITY')),
  language          TEXT        NOT NULL,
  -- Full Meta "components" array as submitted (HEADER/BODY/FOOTER/BUTTONS),
  -- kept verbatim so the create form can be reopened/duplicated later.
  components        JSONB       NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL')),
  -- Meta's numeric template id, used to poll status.
  meta_template_id  TEXT,
  rejection_reason  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_templates_account_name_lang_key UNIQUE (account_id, name, language)
);

DROP TRIGGER IF EXISTS whatsapp_templates_updated_at ON public.whatsapp_templates;
CREATE TRIGGER whatsapp_templates_updated_at
  BEFORE UPDATE ON public.whatsapp_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.whatsapp_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own wa templates" ON public.whatsapp_templates;
CREATE POLICY "Users can view own wa templates"
  ON public.whatsapp_templates FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policy for the client: those only happen via the
-- whatsapp-send edge function (service role), mirroring whatsapp_accounts.
REVOKE ALL ON public.whatsapp_templates FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.whatsapp_templates FROM authenticated;

-- ── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS whatsapp_templates_user_id_idx
  ON public.whatsapp_templates (user_id, created_at DESC);
