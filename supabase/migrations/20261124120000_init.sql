-- GlowOps GLOWOpsDB — initial schema + RLS skeleton
-- Auth for humans: Clerk (not Supabase Auth).
-- Railway app uses DATABASE_URL / service_role; RLS protects accidental anon/Data API access.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Helpers: session context for future PostgREST / pooled app queries
-- ---------------------------------------------------------------------------
create or replace function public.glow_set_partner(p_partner_id text, p_business_ids text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('app.partner_id', coalesce(p_partner_id, ''), true);
  perform set_config('app.business_ids', coalesce(array_to_string(p_business_ids, ','), ''), true);
end;
$$;

create or replace function public.glow_partner_id()
returns text
language sql
stable
as $$
  select nullif(current_setting('app.partner_id', true), '');
$$;

create or replace function public.glow_business_ids()
returns text[]
language sql
stable
as $$
  select case
    when nullif(current_setting('app.business_ids', true), '') is null then array[]::text[]
    else string_to_array(current_setting('app.business_ids', true), ',')
  end;
$$;

-- ---------------------------------------------------------------------------
-- Partners (Clerk users mapped here; password columns optional/legacy)
-- ---------------------------------------------------------------------------
create table if not exists public.partners (
  id text primary key,
  clerk_user_id text unique,
  name text not null,
  email text not null unique,
  password_hash text,
  password_salt text,
  created_at timestamptz not null default now(),
  active boolean not null default true
);

create index if not exists idx_partners_clerk on public.partners (clerk_user_id);
create index if not exists idx_partners_email on public.partners (email);

-- ---------------------------------------------------------------------------
-- Businesses (tenants / customer companies)
-- ---------------------------------------------------------------------------
create table if not exists public.businesses (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now(),
  active boolean not null default true
);

-- Partner ↔ business allowlist
create table if not exists public.partner_businesses (
  partner_id text not null references public.partners (id) on delete cascade,
  business_id text not null references public.businesses (id) on delete cascade,
  business_name text,
  created_at timestamptz not null default now(),
  primary key (partner_id, business_id)
);

create index if not exists idx_partner_businesses_biz on public.partner_businesses (business_id);

-- ---------------------------------------------------------------------------
-- Intune / Graph connection per business
-- ---------------------------------------------------------------------------
create table if not exists public.connections_intune (
  id text primary key default gen_random_uuid()::text,
  business_id text not null references public.businesses (id) on delete cascade,
  tenant_id text,
  display_name text,
  consent_at timestamptz,
  token_ciphertext text,
  token_expires_at timestamptz,
  scopes text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id)
);

-- ---------------------------------------------------------------------------
-- Devices + optional snapshots
-- ---------------------------------------------------------------------------
create table if not exists public.devices (
  id text primary key,
  business_id text not null references public.businesses (id) on delete cascade,
  source text not null default 'manual',
  device_name text,
  manufacturer text,
  model text,
  serial_number text,
  operating_system text,
  os_version text,
  compliance_state text,
  enrolled_at timestamptz,
  last_sync_at timestamptz,
  battery_health double precision,
  warranty_end date,
  user_upn text,
  persona text,
  device_class text,
  health_notes text,
  azure_device_id text,
  intune_device_id text,
  raw_json jsonb,
  call_label text,
  glow_score integer,
  rationale text,
  age_years double precision,
  check_in_days integer,
  mfg_kg double precision,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_devices_business on public.devices (business_id);
create index if not exists idx_devices_call on public.devices (call_label);
create index if not exists idx_devices_glow on public.devices (glow_score);
create index if not exists idx_devices_intune on public.devices (intune_device_id);

create table if not exists public.device_snapshots (
  id bigserial primary key,
  business_id text not null references public.businesses (id) on delete cascade,
  device_id text not null references public.devices (id) on delete cascade,
  payload jsonb not null,
  source text not null default 'sync',
  created_at timestamptz not null default now()
);

create index if not exists idx_device_snapshots_device on public.device_snapshots (device_id, created_at desc);
create index if not exists idx_device_snapshots_biz on public.device_snapshots (business_id);

-- ---------------------------------------------------------------------------
-- Enrollment (device join) + MCP keys — store hashes only
-- ---------------------------------------------------------------------------
create table if not exists public.enrollment_keys (
  id text primary key,
  partner_id text not null references public.partners (id) on delete cascade,
  business_id text not null references public.businesses (id) on delete cascade,
  label text not null,
  key_code text not null unique,
  secret_hash text not null,
  secret_salt text not null,
  key_prefix text not null,
  scope text not null default 'device-join',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  use_count integer not null default 0
);

create index if not exists idx_enroll_partner on public.enrollment_keys (partner_id);
create index if not exists idx_enroll_business on public.enrollment_keys (business_id);

create table if not exists public.mcp_keys (
  id text primary key,
  partner_id text not null references public.partners (id) on delete cascade,
  label text not null,
  key_prefix text not null,
  key_hash text not null,
  scopes text not null default 'read',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);

create index if not exists idx_mcp_keys_partner on public.mcp_keys (partner_id);

-- Legacy cookie sessions (optional while password lab login exists)
create table if not exists public.partner_sessions (
  token_hash text primary key,
  partner_id text not null references public.partners (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_partner_sessions_partner on public.partner_sessions (partner_id);

-- ---------------------------------------------------------------------------
-- Ingest / agent / audit
-- ---------------------------------------------------------------------------
create table if not exists public.ingest_events (
  id bigserial primary key,
  business_id text not null references public.businesses (id) on delete cascade,
  source text not null,
  payload_count integer not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ingest_business on public.ingest_events (business_id, created_at desc);

create table if not exists public.agent_heartbeats (
  id bigserial primary key,
  agent_id text not null,
  hostname text,
  business_id text references public.businesses (id) on delete set null,
  version text,
  payload_json jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_hb_agent on public.agent_heartbeats (agent_id, created_at desc);

create table if not exists public.audit_events (
  id bigserial primary key,
  partner_id text,
  business_id text,
  action text not null,
  meta jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_biz on public.audit_events (business_id, created_at desc);
create index if not exists idx_audit_partner on public.audit_events (partner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS: enable everywhere; allow only rows in app.business_ids / partner_id
-- service_role bypasses RLS (Railway backend). anon gets nothing by default.
-- ---------------------------------------------------------------------------
alter table public.partners enable row level security;
alter table public.businesses enable row level security;
alter table public.partner_businesses enable row level security;
alter table public.connections_intune enable row level security;
alter table public.devices enable row level security;
alter table public.device_snapshots enable row level security;
alter table public.enrollment_keys enable row level security;
alter table public.mcp_keys enable row level security;
alter table public.partner_sessions enable row level security;
alter table public.ingest_events enable row level security;
alter table public.agent_heartbeats enable row level security;
alter table public.audit_events enable row level security;

-- Partners: self by partner id context
drop policy if exists partners_self on public.partners;
create policy partners_self on public.partners
  for all
  using (id = public.glow_partner_id())
  with check (id = public.glow_partner_id());

drop policy if exists partner_businesses_self on public.partner_businesses;
create policy partner_businesses_self on public.partner_businesses
  for all
  using (partner_id = public.glow_partner_id())
  with check (partner_id = public.glow_partner_id());

drop policy if exists businesses_allowed on public.businesses;
create policy businesses_allowed on public.businesses
  for all
  using (id = any (public.glow_business_ids()))
  with check (id = any (public.glow_business_ids()));

drop policy if exists connections_intune_biz on public.connections_intune;
create policy connections_intune_biz on public.connections_intune
  for all
  using (business_id = any (public.glow_business_ids()))
  with check (business_id = any (public.glow_business_ids()));

drop policy if exists devices_biz on public.devices;
create policy devices_biz on public.devices
  for all
  using (business_id = any (public.glow_business_ids()))
  with check (business_id = any (public.glow_business_ids()));

drop policy if exists device_snapshots_biz on public.device_snapshots;
create policy device_snapshots_biz on public.device_snapshots
  for all
  using (business_id = any (public.glow_business_ids()))
  with check (business_id = any (public.glow_business_ids()));

drop policy if exists enrollment_keys_scope on public.enrollment_keys;
create policy enrollment_keys_scope on public.enrollment_keys
  for all
  using (
    partner_id = public.glow_partner_id()
    and business_id = any (public.glow_business_ids())
  )
  with check (
    partner_id = public.glow_partner_id()
    and business_id = any (public.glow_business_ids())
  );

drop policy if exists mcp_keys_self on public.mcp_keys;
create policy mcp_keys_self on public.mcp_keys
  for all
  using (partner_id = public.glow_partner_id())
  with check (partner_id = public.glow_partner_id());

drop policy if exists partner_sessions_self on public.partner_sessions;
create policy partner_sessions_self on public.partner_sessions
  for all
  using (partner_id = public.glow_partner_id())
  with check (partner_id = public.glow_partner_id());

drop policy if exists ingest_events_biz on public.ingest_events;
create policy ingest_events_biz on public.ingest_events
  for all
  using (business_id = any (public.glow_business_ids()))
  with check (business_id = any (public.glow_business_ids()));

drop policy if exists agent_heartbeats_biz on public.agent_heartbeats;
create policy agent_heartbeats_biz on public.agent_heartbeats
  for all
  using (
    business_id is null
    or business_id = any (public.glow_business_ids())
  )
  with check (
    business_id is null
    or business_id = any (public.glow_business_ids())
  );

drop policy if exists audit_events_scope on public.audit_events;
create policy audit_events_scope on public.audit_events
  for all
  using (
    (partner_id is not null and partner_id = public.glow_partner_id())
    or (business_id is not null and business_id = any (public.glow_business_ids()))
  )
  with check (
    (partner_id is not null and partner_id = public.glow_partner_id())
    or (business_id is not null and business_id = any (public.glow_business_ids()))
  );

-- Seed demo business (safe; empty fleet)
insert into public.businesses (id, name)
values ('demo', 'Demo fleet')
on conflict (id) do update set name = excluded.name;
