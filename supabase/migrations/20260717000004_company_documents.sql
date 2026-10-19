-- company_documents: user-uploaded PDFs (one-pagers, executive presentations)
-- that Claude analyzes to enrich the company context used across the
-- Intelligence Hub, Prospección and outreach generation. See
-- analyze-company-document edge function for the analysis step.

create table if not exists public.company_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  file_name text not null,
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  status text not null default 'pending' check (status in ('pending','analyzing','done','error')),
  summary text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists company_documents_user_id_idx
  on public.company_documents (user_id);

alter table public.company_documents enable row level security;
revoke all on public.company_documents from anon, public;

drop policy if exists "own documents select" on public.company_documents;
create policy "own documents select"
  on public.company_documents for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "own documents insert" on public.company_documents;
create policy "own documents insert"
  on public.company_documents for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "own documents delete" on public.company_documents;
create policy "own documents delete"
  on public.company_documents for delete
  to authenticated
  using (auth.uid() = user_id);

-- No client update policy: status/summary/error_message are written by the
-- analyze-company-document edge function via the service role only.

drop trigger if exists company_documents_touch on public.company_documents;
create trigger company_documents_touch
  before update on public.company_documents
  for each row execute function public.set_updated_at();

do $$
begin
  alter publication supabase_realtime add table public.company_documents;
exception when duplicate_object then null;
end $$;

-- ── Storage bucket: private, one folder per user (<user_id>/<uuid>.pdf) ─────
-- Unlike whatsapp-media this is NOT public: these are private business
-- documents, so reads are also gated by an owner-scoped RLS policy (no
-- public-URL fallback).

insert into storage.buckets (id, name, public)
values ('company-documents', 'company-documents', false)
on conflict (id) do nothing;

drop policy if exists "company docs owner select" on storage.objects;
create policy "company docs owner select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'company-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "company docs owner upload" on storage.objects;
create policy "company docs owner upload"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'company-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "company docs owner delete" on storage.objects;
create policy "company docs owner delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'company-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
