-- client_brief ("MI Cliente"): one row per user with the distilled seller
-- context that powers personalized prospecting (outbound-intelligence-engine).
-- Populated by the generate-client-brief edge function from intel_hub_intake
-- (company enrichment + ICP + value proposition) plus live web research.
-- Consumed by generate-outreach (5-layer personalized messages), the
-- Prospección "búsqueda recomendada" (recommended_filters) and the AI coach
-- (meeting context).

create table if not exists public.client_brief (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null unique references auth.users(id) on delete cascade,

  -- Section 1: company identity
  company_name        text,
  positional_phrase   text,   -- e.g. "el 1er Revenue OS de LATAM"
  brand_promise       text,   -- active voice, e.g. "Hacemos el revenue predecible"
  founder_voice       text,   -- who signs the outreach + authority background
  authority_signals   text,   -- extra credibility signals (partnerships, awards)

  -- Section 2: product
  what_it_does        text,   -- 1 sentence
  mechanism           text,   -- the "cómo", concrete, no buzzwords
  key_outcomes        jsonb   not null default '[]'::jsonb, -- ["conversión >30%", ...] only if defensible

  -- Section 3-6: ICP, social proof, objections (from intake — never invented)
  icp                 jsonb   not null default '{}'::jsonb, -- {industries, company_sizes, geographies, roles, buying_triggers, disqualifiers}
  social_proof        jsonb   not null default '[]'::jsonb, -- [{client, industry, what, result}]
  common_objections   jsonb   not null default '[]'::jsonb, -- [{role, objection, neutralizer}]
  voice_notes         text,   -- tone preferences for outreach

  -- Recommended Apollo search derived from the ICP (Prospección → Búsqueda)
  recommended_filters jsonb,  -- payload for /mixed_people/api_search
  status              text    not null default 'pending'
                              check (status in ('pending','generating','ready','error')),
  error_message       text,
  generated_at        timestamptz,
  source              text    not null default 'auto' check (source in ('auto','edited')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists client_brief_user_id_idx on public.client_brief (user_id);

alter table public.client_brief enable row level security;

-- Default-deny: nothing for anon/PUBLIC, owner-scoped for authenticated.
revoke all on public.client_brief from anon, public;

drop policy if exists "own brief select" on public.client_brief;
create policy "own brief select"
  on public.client_brief for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "own brief insert" on public.client_brief;
create policy "own brief insert"
  on public.client_brief for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "own brief update" on public.client_brief;
create policy "own brief update"
  on public.client_brief for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Reuse the shared updated_at trigger function (created in the client_icp migration)
drop trigger if exists client_brief_touch on public.client_brief;
create trigger client_brief_touch
  before update on public.client_brief
  for each row execute function public.set_updated_at();
