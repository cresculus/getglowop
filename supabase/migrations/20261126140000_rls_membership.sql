-- Membership RLS for GLOWOpsDB.
-- Isolation key is business_id (the customer fleet), not the commercial install.
-- Clerk user id must be partners.clerk_user_id. Policies read auth.jwt()->>'sub'.
-- They do not trust app.business_ids. glow_set_partner is locked to the server.
-- service_role (Railway) still bypasses RLS. The Python API must keep its own checks.
-- anon receives no table privileges.

-- ---------------------------------------------------------------------------
-- Install (commercial org). One license later. Many businesses.
-- ---------------------------------------------------------------------------
create table if not exists public.installs (
  id text primary key,
  organization_name text not null,
  status text not null default 'trialing'
    check (status in ('trialing', 'active', 'past_due', 'expired')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  price_cents integer,
  currency text not null default 'usd',
  billing_interval text,
  max_businesses integer not null default 1 check (max_businesses >= 1),
  scope text not null default 'internal' check (scope in ('internal', 'msp')),
  quote_note text,
  created_at timestamptz not null default now()
);

alter table public.businesses
  add column if not exists install_id text references public.installs (id);

create index if not exists idx_businesses_install on public.businesses (install_id);

-- ---------------------------------------------------------------------------
-- Memberships. Missing on this project (init ran, RBAC migration did not).
-- ---------------------------------------------------------------------------
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

insert into public.business_memberships (id, business_id, partner_id, role)
select
  'bm_' || substr(md5(pb.partner_id || ':' || pb.business_id), 1, 16),
  pb.business_id,
  pb.partner_id,
  'owner'
from public.partner_businesses pb
on conflict (business_id, partner_id) do nothing;

-- ---------------------------------------------------------------------------
-- Who is calling. JWT sub only. Not a client-supplied business list.
-- ---------------------------------------------------------------------------
create or replace function public.glow_clerk_sub()
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  claims json;
begin
  begin
    claims := auth.jwt()::json;
  exception
    when undefined_function or invalid_parameter_value then
      claims := null;
  end;
  if claims is null or nullif(claims->>'sub', '') is null then
    begin
      claims := nullif(current_setting('request.jwt.claims', true), '')::json;
    exception
      when others then
        claims := null;
    end;
  end if;
  return nullif(claims->>'sub', '');
end;
$$;

create or replace function public.glow_role_on(p_business_id text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select m.role
  from public.business_memberships m
  join public.partners p on p.id = m.partner_id
  where m.business_id = p_business_id
    and m.revoked_at is null
    and p.active
    and p.clerk_user_id = public.glow_clerk_sub()
  limit 1;
$$;

create or replace function public.glow_is_member(p_business_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.glow_role_on(p_business_id) is not null;
$$;

revoke all on function public.glow_set_partner(text, text[]) from public, anon, authenticated;
revoke all on function public.glow_clerk_sub() from public, anon;
revoke all on function public.glow_role_on(text) from public, anon;
revoke all on function public.glow_is_member(text) from public, anon;
grant execute on function public.glow_clerk_sub() to authenticated, service_role;
grant execute on function public.glow_role_on(text) to authenticated, service_role;
grant execute on function public.glow_is_member(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Replace the session-setting policies.
-- ---------------------------------------------------------------------------
drop policy if exists partners_self on public.partners;
drop policy if exists partner_businesses_self on public.partner_businesses;
drop policy if exists businesses_allowed on public.businesses;
drop policy if exists connections_intune_biz on public.connections_intune;
drop policy if exists devices_biz on public.devices;
drop policy if exists device_snapshots_biz on public.device_snapshots;
drop policy if exists enrollment_keys_scope on public.enrollment_keys;
drop policy if exists mcp_keys_self on public.mcp_keys;
drop policy if exists partner_sessions_self on public.partner_sessions;
drop policy if exists ingest_events_biz on public.ingest_events;
drop policy if exists agent_heartbeats_biz on public.agent_heartbeats;
drop policy if exists audit_events_scope on public.audit_events;
drop policy if exists business_memberships_biz on public.business_memberships;
drop policy if exists business_invitations_biz on public.business_invitations;

create policy partners_self on public.partners
  for select to authenticated
  using (clerk_user_id = public.glow_clerk_sub());

create policy businesses_member on public.businesses
  for select to authenticated
  using (public.glow_is_member(id));

create policy installs_member on public.installs
  for select to authenticated
  using (
    exists (
      select 1
      from public.businesses b
      where b.install_id = installs.id
        and public.glow_is_member(b.id)
    )
  );

create policy partner_businesses_member on public.partner_businesses
  for select to authenticated
  using (public.glow_is_member(business_id));

create policy memberships_select on public.business_memberships
  for select to authenticated
  using (public.glow_is_member(business_id));

create policy memberships_write on public.business_memberships
  for all to authenticated
  using (public.glow_role_on(business_id) in ('owner', 'admin'))
  with check (public.glow_role_on(business_id) in ('owner', 'admin'));

create policy invitations_admin on public.business_invitations
  for all to authenticated
  using (public.glow_role_on(business_id) in ('owner', 'admin'))
  with check (public.glow_role_on(business_id) in ('owner', 'admin'));

create policy devices_select on public.devices
  for select to authenticated
  using (public.glow_is_member(business_id));

create policy devices_write on public.devices
  for insert to authenticated
  with check (public.glow_role_on(business_id) in ('owner', 'admin', 'operator'));

create policy devices_update on public.devices
  for update to authenticated
  using (public.glow_role_on(business_id) in ('owner', 'admin', 'operator'))
  with check (public.glow_role_on(business_id) in ('owner', 'admin', 'operator'));

create policy devices_delete on public.devices
  for delete to authenticated
  using (public.glow_role_on(business_id) in ('owner', 'admin'));

create policy snapshots_select on public.device_snapshots
  for select to authenticated
  using (public.glow_is_member(business_id));

create policy snapshots_write on public.device_snapshots
  for insert to authenticated
  with check (public.glow_role_on(business_id) in ('owner', 'admin', 'operator'));

create policy connections_select on public.connections_intune
  for select to authenticated
  using (public.glow_is_member(business_id));

create policy ingest_select on public.ingest_events
  for select to authenticated
  using (public.glow_is_member(business_id));

create policy heartbeats_select on public.agent_heartbeats
  for select to authenticated
  using (business_id is not null and public.glow_is_member(business_id));

create policy enrollment_select on public.enrollment_keys
  for select to authenticated
  using (
    public.glow_role_on(business_id) in ('owner', 'admin', 'operator')
  );

create policy mcp_select on public.mcp_keys
  for select to authenticated
  using (
    partner_id in (
      select id from public.partners where clerk_user_id = public.glow_clerk_sub()
    )
  );

create policy audit_select on public.audit_events
  for select to authenticated
  using (business_id is not null and public.glow_is_member(business_id));

-- Sessions and token ciphertext stay server-side. No authenticated policy.

-- ---------------------------------------------------------------------------
-- Privileges. RLS is not enough if anon has a grant and a missing policy
-- on a new table. Force RLS so the table owner is covered too.
-- service_role still bypasses via BYPASSRLS.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;

grant select on public.partners to authenticated;
grant select on public.businesses to authenticated;
grant select on public.installs to authenticated;
grant select on public.partner_businesses to authenticated;
grant select on public.business_memberships to authenticated;
grant select, insert, update, delete on public.business_memberships to authenticated;
grant select, insert, update, delete on public.business_invitations to authenticated;
grant select, insert, update, delete on public.devices to authenticated;
grant select, insert on public.device_snapshots to authenticated;
grant select on public.ingest_events to authenticated;
grant select on public.agent_heartbeats to authenticated;
grant select on public.audit_events to authenticated;

grant select (
  id, business_id, tenant_id, display_name, consent_at, token_expires_at,
  scopes, status, created_at, updated_at
) on public.connections_intune to authenticated;

grant select (
  id, partner_id, business_id, label, key_prefix, scope,
  created_at, expires_at, revoked_at, last_used_at, use_count
) on public.enrollment_keys to authenticated;

grant select (id, partner_id, label, key_prefix, scopes, created_at, revoked_at, last_used_at)
  on public.mcp_keys to authenticated;

revoke select (password_hash, password_salt) on public.partners from authenticated;
revoke select (token_hash) on public.business_invitations from authenticated;

alter table public.installs enable row level security;
alter table public.business_memberships enable row level security;
alter table public.business_invitations enable row level security;

alter table public.partners force row level security;
alter table public.businesses force row level security;
alter table public.installs force row level security;
alter table public.partner_businesses force row level security;
alter table public.business_memberships force row level security;
alter table public.business_invitations force row level security;
alter table public.connections_intune force row level security;
alter table public.devices force row level security;
alter table public.device_snapshots force row level security;
alter table public.enrollment_keys force row level security;
alter table public.mcp_keys force row level security;
alter table public.partner_sessions force row level security;
alter table public.ingest_events force row level security;
alter table public.agent_heartbeats force row level security;
alter table public.audit_events force row level security;
