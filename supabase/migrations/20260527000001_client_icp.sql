-- Create client_icp table to store Ideal Customer Profile data per user,
-- linked to the profiles table.

CREATE TABLE IF NOT EXISTS public.client_icp (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  company_sizes   TEXT,
  industries      TEXT,
  roles           TEXT,
  geographies     TEXT,
  pain_points     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT client_icp_profile_id_key UNIQUE (profile_id)
);

-- Auto-update updated_at on row changes
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER client_icp_updated_at
  BEFORE UPDATE ON public.client_icp
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: users can only access their own ICP row
ALTER TABLE public.client_icp ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own ICP"
  ON public.client_icp FOR SELECT
  USING (profile_id = auth.uid());

CREATE POLICY "Users can insert own ICP"
  ON public.client_icp FOR INSERT
  WITH CHECK (profile_id = auth.uid());

CREATE POLICY "Users can update own ICP"
  ON public.client_icp FOR UPDATE
  USING (profile_id = auth.uid());
