-- Migration 2 of 3 — memberships and invitations.
-- Run after 01_init. 03 also creates these tables if they are missing, so a rebuild still runs this file.
-- Tenant RBAC: memberships + invitations (shared DB, scoped by business_id)

create table if not exists public.business_memberships (
  id text primary key,
  business_id text not null references public.businesses (id) on delete cascade,
  partner_id text not null references public.partners (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'operator', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (business_id, partner_id)
);

create index if not exists idx_bm_partner on public.business_memberships (partner_id);
create index if not exists idx_bm_business on public.business_memberships (business_id);

create table if not exists public.business_invitations (
  id text primary key,
  business_id text not null references public.businesses (id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner', 'admin', 'operator', 'viewer')),
  token_hash text not null unique,
  invited_by text not null references public.partners (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  accepted_partner_id text references public.partners (id)
);

create index if not exists idx_inv_business on public.business_invitations (business_id);
create index if not exists idx_inv_email on public.business_invitations (email);

alter table public.business_memberships enable row level security;
alter table public.business_invitations enable row level security;

drop policy if exists business_memberships_biz on public.business_memberships;
create policy business_memberships_biz on public.business_memberships
  for all
  using (business_id = any (public.glow_business_ids()))
  with check (business_id = any (public.glow_business_ids()));

drop policy if exists business_invitations_biz on public.business_invitations;
create policy business_invitations_biz on public.business_invitations
  for all
  using (business_id = any (public.glow_business_ids()))
  with check (business_id = any (public.glow_business_ids()));
