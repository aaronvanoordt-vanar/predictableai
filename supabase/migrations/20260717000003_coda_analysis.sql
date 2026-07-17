-- coda_analysis ("CODA AI"): one row per user holding the optional strategic
-- context that complements the (mandatory) Intelligence Hub + company context.
--
-- Three blocks:
--   1. PESTEL — Political / Economic / Social / Technological / Environmental /
--      Legal factors of the user's market, each translated into a sales impact.
--      AI-generated (generate-coda edge function, web research) from the
--      client_brief + intel_hub_intake context.
--   2. FODA — the classic SWOT matrix (Fortalezas / Oportunidades / Debilidades
--      / Amenazas). Filled BY THE USER, client-writable, owner-scoped.
--   3. CAME — the strategic response matrix (Corregir / Afrontar / Mantener /
--      Explotar) that generate-coda derives from the user's FODA.
--
-- Everything here is OPTIONAL enrichment: unlike the Intelligence Hub and the
-- company context, the app never blocks on it being filled.

create table if not exists public.coda_analysis (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null unique references auth.users(id) on delete cascade,

  -- PESTEL (AI-generated). Shape:
  -- { "political": [{ "factor": "...", "impact": "high|medium|low",
  --                   "sales_impact": "...", "action": "..." }], ... }
  -- keys: political, economic, social, technological, environmental, legal
  pestel              jsonb       not null default '{}'::jsonb,
  pestel_status       text        not null default 'idle'
                                  check (pestel_status in ('idle','generating','ready','error')),
  pestel_error        text,
  pestel_generated_at timestamptz,

  -- FODA (user-filled). Shape:
  -- { "fortalezas": ["..."], "oportunidades": ["..."],
  --   "debilidades": ["..."], "amenazas": ["..."] }
  foda                jsonb       not null default '{}'::jsonb,

  -- CAME (AI-derived from FODA). Shape:
  -- { "mantener": [{ "titulo": "...", "accion": "..." }],
  --   "explotar": [...], "corregir": [...], "afrontar": [...] }
  came                jsonb       not null default '{}'::jsonb,
  came_status         text        not null default 'idle'
                                  check (came_status in ('idle','generating','ready','error')),
  came_error          text,
  came_generated_at   timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists coda_analysis_user_id_idx on public.coda_analysis (user_id);

alter table public.coda_analysis enable row level security;

-- Default-deny: nothing for anon/PUBLIC, owner-scoped for authenticated.
revoke all on public.coda_analysis from anon, public;

drop policy if exists "own coda select" on public.coda_analysis;
create policy "own coda select"
  on public.coda_analysis for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "own coda insert" on public.coda_analysis;
create policy "own coda insert"
  on public.coda_analysis for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "own coda update" on public.coda_analysis;
create policy "own coda update"
  on public.coda_analysis for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Reuse the shared updated_at trigger function (created in the client_icp migration)
drop trigger if exists coda_analysis_touch on public.coda_analysis;
create trigger coda_analysis_touch
  before update on public.coda_analysis
  for each row execute function public.set_updated_at();

-- Live updates: PESTEL and CAME are generated asynchronously by the
-- generate-coda edge function (service role), so the client needs realtime to
-- see status flip generating → ready without a manual refresh. RLS is
-- respected, so subscribers only ever see their own row.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.coda_analysis;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
