# SaaS stack bootstrap — Clerk + Supabase + Railway

**Reusable playbook** for a new product app (GlowOps pattern).  
One product = one Clerk app + one Supabase project + one Railway service.  
**Never** reuse another product’s Clerk app, Supabase project, or env vars.

Filled example below = **GlowOps** (`getglowop.com`). Swap names/domains for the next app.

---

## Decision rules

| Concern | Use | Do not use |
|---|---|---|
| Human login (partners / operators) | **Clerk** | Supabase Auth |
| Postgres + RLS | **Supabase** | Clerk as database |
| Host / env / deploys | **Railway** | Secrets in git or chat |
| Cross-product reuse | Never | Cresculus Clerk, shared DB, copied Stripe keys |

Order every time:

1. Clerk app  
2. Clerk Paths  
3. Supabase project  
4. Railway env (Clerk first, then Supabase)  
5. Redeploy → test sign-in  
6. Schema / RLS later  

---

## 0. Name the product

Before clicking anything, write:

| Slot | GlowOps example | Your next app |
|---|---|---|
| Product name | GlowOps | … |
| Public host | `https://getglowop.com` | `https://…` |
| Local host | `http://127.0.0.1:8787` | `http://127.0.0.1:PORT` |
| Post-login path | `/partner/` | e.g. `/app/` |
| Clerk app name | GLOW Ops / GlowOps | same as product |
| Supabase org | GetGLOWOps | product org |
| Supabase project | GLOWOpsDB | `{Product}DB` |
| Railway service | getglowop | matching deploy |

---

## 1. Clerk — create a dedicated application

1. Open [dashboard.clerk.com](https://dashboard.clerk.com).
2. Top-left app switcher → **Create application** (new app — not Cresculus / not an old product).
3. Name it after the product.
4. Enable sign-in methods you need (GlowOps: **Email**; Microsoft/Google optional).
5. Stay on **Development** until live; add a **Production** instance later.

### Where things live (Clerk left nav)

Clerk’s UI labels move. Use this map:

| You need | Click |
|---|---|
| Publishable + secret keys | **Developer → API keys** |
| Auth host (`*.clerk.accounts.dev`) | **Developer → Domains** (leave default in Dev) |
| Home URL, Account Portal sign-in | **Developer → Paths** |
| App name / logo | **Application → Settings** (not keys) |
| Email / Microsoft providers | **Configure** (User & auth / SSO) — not Developer Settings |

**Domains** = Clerk’s own Frontend API / Account Portal host.  
You do **not** put `getglowop.com` here on Hobby/Dev. Custom domain = Production / Pro polish.

### Paths (exact fields on current Dashboard)

**Developer → Paths:**

| Field | GlowOps Dev value |
|---|---|
| Fallback development host | `http://127.0.0.1:8787` |
| Home URL | `/partner/` |
| Unauthorized sign in URL | blank or `/partner/` |
| `<SignIn />` / `<SignUp />` | Prefer **development host**: `/partner/sign-in`, `/partner/sign-up` |

GlowOps serves those pages; after auth → `/partner/` dashboard. Unauthenticated `/partner/` redirects to sign-in when Clerk keys are set.

Production instance later: home host = `https://getglowop.com`, same path pattern.

### Copy from Clerk (never paste `sk_` in chat)

| Item | Where |
|---|---|
| Publishable key `pk_test_…` / `pk_live_…` | Developer → API keys |
| Secret key `sk_test_…` / `sk_live_…` | Developer → API keys (Reveal) |
| Frontend API host | Domains / API keys page (e.g. `merry-locust-9551.clerk.accounts.dev`) |

---

## 2. Supabase — create a dedicated project

1. Open [supabase.com/dashboard](https://supabase.com/dashboard).
2. Org for this product (GlowOps: **GetGLOWOps**) → **New project**.
3. Settings that matter on create:

| Field | Value |
|---|---|
| Project name | `{Product}DB` (e.g. GLOWOpsDB) |
| Database password | Generate + store offline |
| Region | Americas / closest to Railway (GlowOps: **us-east-2**) |
| Enable Data API | On |
| Grant API access to new tables automatically | **Off** |
| Enable RLS on new tables automatically | **On** |

4. Skip GitHub connect until you want migration CI.
5. Wait until Status = **Healthy**.

### Where keys live (Supabase)

You will land on **Project Settings → General**. Keys are **not** there.

| You need | Click |
|---|---|
| Project URL, anon, service_role | Left: **Settings → API Keys** |
| Postgres URI (`DATABASE_URL`) | Top **Connect** → **Direct** (connection string) |
| JWT / legacy | Settings → JWT Keys (usually leave alone) |

**Do not** enable Supabase **Authentication** for partner login when Clerk is the IdP. Supabase = database (+ RLS). Clerk = humans.

### Copy from Supabase (store offline; never paste secrets in chat)

| Item | Railway variable name |
|---|---|
| Project URL `https://….supabase.co` | `SUPABASE_URL` |
| anon / public key | `SUPABASE_ANON_KEY` |
| service_role key | `SUPABASE_SERVICE_ROLE_KEY` (server only) |
| Direct Postgres URI | `DATABASE_URL` |

`service_role` bypasses RLS — **never** ship it to the browser or a public repo.

---

## 3. Railway — place the keys

**Where:** Railway → project for this product → **service** (GlowOps: getglowop) → **Variables**.

### 3a. Clerk (do this first)

| Variable | Value |
|---|---|
| `CLERK_PUBLISHABLE_KEY` | `pk_…` from Clerk |
| `CLERK_SECRET_KEY` | `sk_…` from Clerk |
| `CLERK_AUTHORIZED_PARTIES` | `https://PUBLIC_HOST,http://127.0.0.1:PORT` |
| `GLOWOPS_PUBLIC_URL` | `https://PUBLIC_HOST` (rename per app if needed) |
| `GLOWOPS_REQUIRE_AUTH` | leave unset / `0` until Partner Clerk UI works; then `1` |

Optional: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` = same as publishable (harmless for Python).

### 3b. Supabase (after Clerk vars exist)

| Variable | Value |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
| `DATABASE_URL` | Direct connection string from **Connect** |

App may still use SQLite until migrations land — storing vars early is fine; schema comes next.

### 3c. Never copy from another product

Do not pull Stripe, Resend, Ollama, RAG, scanner, or another app’s Supabase/Clerk keys into this service.

Redeploy (or let Railway auto-redeploy) after saving variables.

---

## 4. Smoke test

1. Open `https://PUBLIC_HOST/partner/` (or your post-login path).
2. Clerk sign-in should mount when publishable + secret are set.
3. Confirm `/api/config/public` (or equivalent) shows `"clerk": { "enabled": true }` without exposing the secret.
4. Only then set `*_REQUIRE_AUTH=1` and drop demo passwords.

---

## 5. Later (same stack, next session)

- SQL Editor / migrations: tables + **RLS** on `business_id` (or tenant key).
- Clerk Organizations ↔ partner rows (MSP).
- Entra multi-tenant app + Graph sync (GlowOps-specific).
- Production Clerk instance + live keys when cutting over.

---

## GlowOps filled checklist (2026-11-24)

| Step | Status / value |
|---|---|
| Clerk app | GLOW Ops (Development) |
| Clerk Domains | `merry-locust-9551.clerk.accounts.dev` (leave alone) |
| Clerk Paths | Fallback `http://127.0.0.1:8787`, Home `/partner/`, Account Portal sign-in |
| Supabase org / project | GetGLOWOps / GLOWOpsDB |
| Supabase URL | `https://goxottatihejvzakhdho.supabase.co` |
| Region | us-east-2 |
| Railway Clerk vars | Operator places on getglowop service |
| Railway Supabase vars | Operator places on getglowop service (this doc §3b) |
| Schema + RLS | Not yet |
| `GLOWOPS_REQUIRE_AUTH=1` | Not yet |

---

## Template for the next app

Copy this block into a new `docs/saas-stack-bootstrap-{app}.md` or a checklist note:

```text
Product:
Public URL:
Local URL + port:
Post-login path:
Clerk app name:
Supabase org / project:
Railway project / service:

Clerk pk_ placed on Railway: [ ]
Clerk sk_ placed on Railway: [ ]  (not in chat)
SUPABASE_URL / ANON / SERVICE_ROLE / DATABASE_URL on Railway: [ ]
Smoke test sign-in: [ ]
REQUIRE_AUTH enabled: [ ]
```

Related: `clerk-glowops-app.md`, `railway-getglowop-env.md`, `security-architecture.md`.
