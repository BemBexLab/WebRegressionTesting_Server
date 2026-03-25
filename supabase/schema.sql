create extension if not exists pgcrypto;

create table if not exists public.websites (
  id uuid primary key default gen_random_uuid(),
  url text unique not null,
  site_key text not null,
  viewport text not null default 'desktop',
  threshold_percentage double precision not null default 0.3,
  ignored_selectors jsonb not null default '[]'::jsonb,
  baseline_image_path text,
  baseline_html text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.scans (
  id bigint generated always as identity primary key,
  website_id uuid not null references public.websites(id) on delete cascade,
  baseline_created boolean not null default false,
  visual_mismatch_percentage double precision not null default 0,
  visual_status text not null default 'Pass',
  visual_baseline_image_url text,
  visual_current_image_url text,
  visual_diff_image_url text,
  report_payload jsonb not null default '{}'::jsonb,
  dom_summary jsonb not null default '{}'::jsonb,
  dom_changed_selectors jsonb not null default '[]'::jsonb,
  dom_diff_log jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.scan_jobs (
  job_id uuid primary key,
  status text not null default 'queued',
  progress_percentage integer not null default 0,
  message text not null default 'Queued',
  website_id uuid references public.websites(id) on delete set null,
  site_name text,
  total_pages integer not null default 0,
  completed_pages integer not null default 0,
  current_page_url text,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.page_baselines (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete cascade,
  page_path text not null,
  baseline_image_path text not null,
  baseline_html text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (website_id, page_path)
);

create table if not exists public.code_repo_baselines (
  id uuid primary key default gen_random_uuid(),
  owner text not null,
  repo text not null,
  repository_url text not null,
  branch text not null,
  commit_sha text not null,
  commit_url text,
  committed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (owner, repo)
);

alter table public.websites enable row level security;
alter table public.scans enable row level security;
alter table public.scan_jobs enable row level security;
alter table public.page_baselines enable row level security;
alter table public.code_repo_baselines enable row level security;

drop policy if exists "Allow read websites" on public.websites;
create policy "Allow read websites"
on public.websites
for select
using (true);

drop policy if exists "Allow read scans" on public.scans;
create policy "Allow read scans"
on public.scans
for select
using (true);

drop policy if exists "Allow read scan jobs" on public.scan_jobs;
create policy "Allow read scan jobs"
on public.scan_jobs
for select
using (true);

drop policy if exists "Allow read page baselines" on public.page_baselines;
create policy "Allow read page baselines"
on public.page_baselines
for select
using (true);

drop policy if exists "Allow read code repo baselines" on public.code_repo_baselines;
create policy "Allow read code repo baselines"
on public.code_repo_baselines
for select
using (true);

alter publication supabase_realtime add table public.websites;
alter publication supabase_realtime add table public.scans;
alter publication supabase_realtime add table public.scan_jobs;
alter publication supabase_realtime add table public.page_baselines;
alter publication supabase_realtime add table public.code_repo_baselines;
