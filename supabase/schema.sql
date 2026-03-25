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

alter table public.websites enable row level security;
alter table public.scans enable row level security;

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

alter publication supabase_realtime add table public.websites;
alter publication supabase_realtime add table public.scans;
