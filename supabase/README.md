# GlowOps Supabase (GLOWOpsDB)

**Do not connect the Cresculus repo.**  
Connect GitHub → **`cresculus/getglowop`** (this product only), or keep migrations in this folder and apply via CLI / SQL Editor.

| Item | Value |
|---|---|
| Org | GetGLOWOps |
| Project | GLOWOpsDB |
| Ref | `goxottatihejvzakhdho` |
| Region | us-east-2 |
| Auth for humans | **Clerk** (leave Supabase Auth off for partners) |

## Connect GitHub (recommended)

In Supabase → **Project Settings → Integrations** (or overview **Connect GitHub**):

1. Choose repo **`cresculus/getglowop`** — not Cresculus production.
2. Path / root: `supabase/` (migrations live here once synced to getglowop).
3. Branch: `main`.
4. Supabase applies new files under `supabase/migrations/` on push.

Alternative: no GitHub link — paste/run migrations in **SQL Editor**, or:

```bash
npx supabase link --project-ref goxottatihejvzakhdho
npx supabase db push
```

## Layout

```
supabase/
  README.md
  migrations/
    20261124120000_init.sql   ← partners, businesses, devices, keys, RLS
```

## Apply order

1. `migrations/20261124120000_init.sql`
2. `migrations/20261124230000_rbac_invites.sql`
3. `migrations/20261126140000_rls_membership.sql` — membership RLS, install id, secret columns hidden
4. SQL editor: `tests/rls_cross_tenant.sql` (rolls back). `other_devices` must be 0.

Live fleet rows today are SQLite on the Railway volume (`GLOWOPS_DATA`). This SQL does not move them. RLS protects GLOWOpsDB and the Supabase Data API. The Railway process uses a role that bypasses RLS, so the Python membership check stays mandatory until queries run as the Clerk user.

`partners.clerk_user_id` must be the Clerk `sub`. Policies read that claim. They do not trust a client-supplied business list.

Isolation key is `business_id` (`biz_`). `installs.id` (`ins_`) is the organization you quote. A member can read their install. They cannot edit price or term.

## Rules

- One GlowOps schema — never import Cresculus tables.
- Secrets stay on Railway; never commit `.env`.
- RLS is on; `anon` / public Data API should not see rows without policies you explicitly add.
- Railway Python uses `DATABASE_URL` / `service_role` for now; tighten to partner JWT claims later.
