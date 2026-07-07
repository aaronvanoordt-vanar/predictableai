-- ═══════════════════════════════════════════════════════════════════════════
-- coach_lead_context — persists the "current lead" handed from Prospección to
-- the AI Sales Coach ("Preparar reunión con el coach").
--
-- Before this table the handoff lived only in window.predictable.currentProspect
-- (in-memory): a reload between clicking the button and starting the meeting
-- lost the context. One row per user (the lead currently being prepped);
-- history of messages/angles stays on prospect_list_members.outreach.
--
-- Client-writable (like prospect_lists), gated by owner-scoped RLS.
-- All statements are idempotent and non-destructive (safe to re-apply).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.coach_lead_context (
  user_id    UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  member_id  UUID        REFERENCES public.prospect_list_members(id) ON DELETE SET NULL,
  -- Snapshot del lead para el coach: name/title/company, brief_who/why/risks
  -- y el objeto outreach completo (mensajes + angle) al momento del handoff.
  lead       JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS coach_lead_context_updated_at ON public.coach_lead_context;
CREATE TRIGGER coach_lead_context_updated_at
  BEFORE UPDATE ON public.coach_lead_context
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.coach_lead_context ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own coach context" ON public.coach_lead_context;
CREATE POLICY "Users can view own coach context"
  ON public.coach_lead_context FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own coach context" ON public.coach_lead_context;
CREATE POLICY "Users can insert own coach context"
  ON public.coach_lead_context FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own coach context" ON public.coach_lead_context;
CREATE POLICY "Users can update own coach context"
  ON public.coach_lead_context FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own coach context" ON public.coach_lead_context;
CREATE POLICY "Users can delete own coach context"
  ON public.coach_lead_context FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
