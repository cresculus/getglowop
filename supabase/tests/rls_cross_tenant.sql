-- Prove one Clerk user cannot read another business.
-- Run in the Supabase SQL editor as postgres. The transaction rolls back.
-- Expect: biz_a count = 1, biz_b count = 0, secret_hash select fails.

begin;

insert into public.partners (id, clerk_user_id, name, email)
values
  ('partner_a', 'clerk_user_a', 'A', 'a@example.test'),
  ('partner_b', 'clerk_user_b', 'B', 'b@example.test')
on conflict (id) do update set clerk_user_id = excluded.clerk_user_id;

insert into public.installs (id, organization_name, scope, max_businesses)
values
  ('ins_aaaaaaaa', 'Org A', 'internal', 1),
  ('ins_bbbbbbbb', 'Org B', 'internal', 1)
on conflict (id) do nothing;

insert into public.businesses (id, name, install_id)
values
  ('biz_aaaaaaaa', 'Fleet A', 'ins_aaaaaaaa'),
  ('biz_bbbbbbbb', 'Fleet B', 'ins_bbbbbbbb')
on conflict (id) do update set install_id = excluded.install_id;

insert into public.business_memberships (id, business_id, partner_id, role)
values
  ('bm_a', 'biz_aaaaaaaa', 'partner_a', 'owner'),
  ('bm_b', 'biz_bbbbbbbb', 'partner_b', 'owner')
on conflict (business_id, partner_id) do nothing;

insert into public.devices (id, business_id, device_name, serial_number)
values
  ('dev_a', 'biz_aaaaaaaa', 'laptop-a', 'SERIAL-A'),
  ('dev_b', 'biz_bbbbbbbb', 'laptop-b', 'SERIAL-B')
on conflict (id) do nothing;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"clerk_user_a","role":"authenticated"}', true);

-- Must be 1.
select count(*) as own_devices from public.devices where business_id = 'biz_aaaaaaaa';
-- Must be 0. A leak here means RLS is not applied.
select count(*) as other_devices from public.devices where business_id = 'biz_bbbbbbbb';

reset role;
rollback;
