-- ═══════════════════════════════════════════════════════════════════════════
-- WhatsApp Inbox — timestamped lead notes — 2026-07-15
--
-- Lets the rep jot free-form, timestamped notes on a lead straight from the
-- contact panel of the WhatsApp inbox (right column). Notes are anchored to the
-- conversation (and, when linked, the prospect member for cross-reference).
--
-- Write model:
--   • whatsapp_notes — FULLY CLIENT-WRITABLE (owner-scoped): jotting, editing
--     and deleting a note are plain table writes. No edge function involved.
--     created_at is the note's timestamp shown in the UI.
--
-- All statements are idempotent and non-destructive (safe to re-apply).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Table ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_notes (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id UUID        NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  -- Denormalized link to the enrichment row (when the conversation is linked to
  -- a prospect); SET NULL keeps the note if the prospect row/list is deleted.
  member_id       UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  body            TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── updated_at trigger (reuses public.set_updated_at) ───────────────────────

DROP TRIGGER IF EXISTS whatsapp_notes_updated_at ON public.whatsapp_notes;
CREATE TRIGGER whatsapp_notes_updated_at
  BEFORE UPDATE ON public.whatsapp_notes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS: fully client-writable, owner-scoped ────────────────────────────────

ALTER TABLE public.whatsapp_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own wa notes" ON public.whatsapp_notes;
CREATE POLICY "Users can view own wa notes"
  ON public.whatsapp_notes FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own wa notes" ON public.whatsapp_notes;
CREATE POLICY "Users can insert own wa notes"
  ON public.whatsapp_notes FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own wa notes" ON public.whatsapp_notes;
CREATE POLICY "Users can update own wa notes"
  ON public.whatsapp_notes FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own wa notes" ON public.whatsapp_notes;
CREATE POLICY "Users can delete own wa notes"
  ON public.whatsapp_notes FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.whatsapp_notes FROM anon;

-- ── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS whatsapp_notes_conversation_idx
  ON public.whatsapp_notes (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS whatsapp_notes_member_idx
  ON public.whatsapp_notes (member_id);
