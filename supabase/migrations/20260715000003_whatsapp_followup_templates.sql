-- Allow scheduled WhatsApp follow-ups to be sent as an approved Meta template
-- instead of a free-text message. Free-text follow-ups are rejected by
-- WhatsApp when the contact hasn't written in the last 24h (error 131047);
-- templates are the only way to reach someone outside that window, so the
-- "Programar seguimiento" modal now lets the user pick one for far-future
-- sends. See js/whatsapp-inbox.js (openScheduleModal) and
-- supabase/functions/whatsapp-followups/index.ts.

ALTER TABLE public.whatsapp_followups
  ADD COLUMN IF NOT EXISTS kind              TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'template')),
  ADD COLUMN IF NOT EXISTS template_name     TEXT,
  ADD COLUMN IF NOT EXISTS template_language TEXT,
  ADD COLUMN IF NOT EXISTS template_params   JSONB;

ALTER TABLE public.whatsapp_followups
  ADD CONSTRAINT whatsapp_followups_template_fields_chk
  CHECK (kind = 'text' OR (template_name IS NOT NULL AND template_language IS NOT NULL));
