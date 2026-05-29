-- Create sales_reports table to store meeting reports per SDR
CREATE TABLE IF NOT EXISTS public.sales_reports (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_name             TEXT,
  meeting_id               TEXT,
  sdr_name                 TEXT,
  sdr_email                TEXT,
  prospect_name            TEXT,
  prospect_company         TEXT,
  meeting_type             TEXT,
  meeting_url              TEXT,
  started_at               TIMESTAMPTZ,
  ended_at                 TIMESTAMPTZ,
  duration_seconds         INTEGER,
  score_total              INTEGER DEFAULT 0,
  score_active_listening   INTEGER,
  score_pain_deepening     INTEGER,
  score_pace_control       INTEGER,
  score_objection_handling INTEGER,
  report                   JSONB DEFAULT '{}'::jsonb,
  status                   TEXT DEFAULT 'completed',
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS sales_reports_user_id_idx      ON public.sales_reports(user_id);
CREATE INDEX IF NOT EXISTS sales_reports_company_name_idx ON public.sales_reports(company_name);
CREATE INDEX IF NOT EXISTS sales_reports_started_at_idx   ON public.sales_reports(started_at DESC);
CREATE INDEX IF NOT EXISTS sales_reports_meeting_id_idx   ON public.sales_reports(meeting_id);

-- Enable RLS
ALTER TABLE public.sales_reports ENABLE ROW LEVEL SECURITY;

-- SDRs can insert their own reports
CREATE POLICY "Users insert own reports" ON public.sales_reports
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users always see their own reports
CREATE POLICY "Users see own reports" ON public.sales_reports
  FOR SELECT USING (auth.uid() = user_id);

-- Admins/directors see all reports from the same company
CREATE POLICY "Admins see company reports" ON public.sales_reports
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.role IN ('admin', 'director')
        AND p.company_name = sales_reports.company_name
    )
  );

-- Users can update their own reports
CREATE POLICY "Users update own reports" ON public.sales_reports
  FOR UPDATE USING (auth.uid() = user_id);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.sales_reports_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER sales_reports_updated_at
  BEFORE UPDATE ON public.sales_reports
  FOR EACH ROW EXECUTE FUNCTION public.sales_reports_set_updated_at();
