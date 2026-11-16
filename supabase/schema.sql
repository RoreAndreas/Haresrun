-- HARES RUN : table des trajets et règles d'accès.
-- À coller une fois dans Supabase → SQL Editor → New query → Run.

create table if not exists public.routes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null default 'Trajet',
  distance    real not null default 0,          -- mètres
  gain        real,                             -- dénivelé positif, mètres
  loop        boolean not null default false,
  points      jsonb not null default '[]',      -- [{lat, lng, label}]
  path        text not null default '',         -- tracé, polyligne encodée
  source      text,                             -- roads | straight | generated | shared
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists routes_user_updated on public.routes (user_id, updated_at desc);

-- Chacun ne voit, ne crée, ne modifie et ne supprime que ses propres trajets.
alter table public.routes enable row level security;

drop policy if exists "routes_select_own" on public.routes;
drop policy if exists "routes_insert_own" on public.routes;
drop policy if exists "routes_update_own" on public.routes;
drop policy if exists "routes_delete_own" on public.routes;

create policy "routes_select_own" on public.routes for select to authenticated using (auth.uid() = user_id);
create policy "routes_insert_own" on public.routes for insert to authenticated with check (auth.uid() = user_id);
create policy "routes_update_own" on public.routes for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "routes_delete_own" on public.routes for delete to authenticated using (auth.uid() = user_id);
