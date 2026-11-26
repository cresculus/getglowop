# GlowOps production architecture

Replicate this for the next product. One Clerk app, one Supabase project, one Railway service, one domain. Do not reuse another product’s keys.

Checked live 2026-11-26: `https://getglowop.com/api/health` returned `"database": "supabase"`.

## What runs where

| Piece | Where | Not |
| --- | --- | --- |
| Marketing + dashboard + partner API | Railway service `getglowop`, `python live/server.py` | Not the database |
| Human login | Clerk app **GLOW Ops** | Not Supabase Auth |
| Customer rows | Supabase project **GLOWOpsDB** (`goxottatihejvzakhdho`, us-east-2) | Not a Railway volume |
| Domain | getglowop.com | |

```
Browser → getglowop.com (Railway)
              │
              ├─ Clerk JWT for /partner/
              └─ DATABASE_URL → Supabase session pooler (IPv4) → Postgres
```

Railway env that matters: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_AUTHORIZED_PARTIES`, `GLOWOPS_PUBLIC_URL`.

`DATABASE_URL` is the **session pooler** URI. Host looks like `aws-0-us-east-2.pooler.supabase.com`, port **5432**, user `postgres.<project-ref>`. Copy it from Supabase → **Connect → Session pooler**.

Do not use **Direct connection** (`db.<ref>.supabase.co`). That host is IPv6-only. Railway is IPv4-only. The 2026-11-26 crash was `Network is unreachable` to `2600:1f16:…:5432`. This project’s pooler is `aws-0-us-east-2` (a wrong-password probe returned “password authentication failed”, which means the tenant exists). `aws-1-us-east-2` returned “tenant not found”.

If someone pastes the direct URI anyway, `live/pgstore.py` rewrites `db.<ref>.supabase.co` to that pooler and prefixes the user with the project ref. Prefer setting the pooler URI yourself.

The Python process uses that URL as a privileged database login. It bypasses row level security. The Supabase Data API still has RLS. The app must keep its own membership check before it reads a `business_id`.

## Ids

| Id | Meaning |
| --- | --- |
| `ins_` | Organization you quote. One timeline, one price. Not built in the app yet. |
| `biz_` | One customer fleet. Isolation key on every device row. |
| Clerk `sub` | Stored on `partners.clerk_user_id`. RLS matches this, not a client-supplied business list. |

## Rebuild the database

Empty project, SQL editor, in order. Do not re-run these on GLOWOpsDB.

1. `supabase/migrations/20261124120000_01_init.sql`
2. `supabase/migrations/20261124230000_02_memberships.sql`
3. `supabase/migrations/20261126140000_03_rls.sql`
4. `supabase/tests/rls_cross_tenant.sql` — rolls back. `other_devices` must be 0.

The next change is file `04`. Do not edit 01–03 after they have been applied.

## Volume

A Railway volume is not the database. The first Supabase boot can import `/data/glowops.db` once if that file is still mounted, then it writes `glowops.supabase-imported` beside it.

After health says `"database": "supabase"` and a signed-in business still shows its devices, remove the volume and delete `GLOWOPS_DATA`.

## Ship path

Edit `GlowOps/dashboard-app/`, copy into `getglowop/live/`, push `cresculus/getglowop` `main`. Railway deploys from that. Schema changes are SQL files, not something the Python process creates on startup.
