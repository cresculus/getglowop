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

1. Review `migrations/20261124120000_init.sql`
2. Push to getglowop `main` (if GitHub connected) **or** run in SQL Editor
3. Confirm tables in **Table Editor**
4. Keep Railway `DATABASE_URL` + service role; app uses server-side access (RLS still on for defense)

## Rules

- One GlowOps schema — never import Cresculus tables.
- Secrets stay on Railway; never commit `.env`.
- RLS is on; `anon` / public Data API should not see rows without policies you explicitly add.
- Railway Python uses `DATABASE_URL` / `service_role` for now; tighten to partner JWT claims later.
