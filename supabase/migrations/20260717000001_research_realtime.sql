-- Enables live updates for "Contexto de tu empresa" (Intelligence Hub):
-- intel_hub_intake changes while enrich-company runs, and client_brief
-- changes while generate-client-brief runs, need to reach the client without
-- a manual page refresh. postgres_changes respects RLS, so subscribers only
-- ever see their own row (both tables are already owner-scoped).
--
-- intelligence_hub_reports is added too: js/intel-hub-cadence-tabs.js has
-- subscribed to it via postgres_changes since it shipped, but the table was
-- never added to the publication, so those realtime updates were silently
-- never firing (the UI only ever refreshed via the explicit reload after the
-- generation fetch completes).

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.intel_hub_intake;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.client_brief;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.intelligence_hub_reports;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
