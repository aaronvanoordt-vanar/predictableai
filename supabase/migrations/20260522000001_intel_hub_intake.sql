-- intel_hub_intake: one row per user with their answer to
-- "What would you want to know periodically about your market?"
-- Drives the personalization of the Intelligence Hub module.

create table if not exists public.intel_hub_intake (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  what_to_know text not null,
  company_linkedin_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists intel_hub_intake_user_id_idx
  on public.intel_hub_intake (user_id);

alter table public.intel_hub_intake enable row level security;

drop policy if exists "own intake select" on public.intel_hub_intake;
create policy "own intake select"
  on public.intel_hub_intake for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "own intake insert" on public.intel_hub_intake;
create policy "own intake insert"
  on public.intel_hub_intake for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "own intake update" on public.intel_hub_intake;
create policy "own intake update"
  on public.intel_hub_intake for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.intel_hub_intake_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists intel_hub_intake_touch on public.intel_hub_intake;
create trigger intel_hub_intake_touch
  before update on public.intel_hub_intake
  for each row execute function public.intel_hub_intake_touch_updated_at();
