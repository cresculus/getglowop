# Master deploy playbook — local app → live SaaS

**One file to replicate GlowOps (or the next product) from zero.**

Covers: local app → GitHub → Railway → GoDaddy DNS → Clerk → Supabase → env vars → Partner sign-in / sign-up → dashboard.  
Filled example = **GlowOps** / **getglowop.com**. Swap every name when you clone for another app.

Related detail docs (same folder):

| Doc | Scope |
|---|---|
| `saas-stack-bootstrap.md` | Clerk + Supabase + Railway keys (deep) |
| `clerk-glowops-app.md` | Clerk-only GlowOps |
| `railway-getglowop-env.md` | Full Railway variable list |
| `intune-first.md` | Graph / Intune (product, not hosting) |

**Rules**

- One product = **one** Clerk app + **one** Supabase project + **one** Railway service + **one** domain.
- Never reuse Cresculus / another product’s Clerk, Supabase, or secrets.
- Never paste `sk_`, `sb_secret_`, DB passwords, or `DATABASE_URL` with password into chat or git.
- Clerk = human login. Supabase = Postgres (+ RLS later). Do **not** turn on Supabase Auth for partners.

---

## 0. Name the product (write this first)

| Slot | GlowOps | Next app |
|---|---|---|
| Product name | GlowOps / GLOW Ops | |
| Public domain | `getglowop.com` | |
| Public URL | `https://getglowop.com` | |
| Local URL | `http://127.0.0.1:8787` | |
| Post-login path | `/partner/` | |
| Sign-in / Sign-up | `/partner/sign-in`, `/partner/sign-up` | |
| Fleet / app UI | `/app/` | |
| Source of truth (dev) | `Private AI Residential/GlowOps/dashboard-app/` | |
| Deploy repo (ship) | `Desktop/RSA_App_V2_LOCAL/getglowop` | |
| GitHub | `github.com/cresculus/getglowop` | |
| Railway project / service | Get GlowOps / `getglowop` | |
| Clerk app | GLOW Ops (dedicated) | |
| Supabase org / project | GetGLOWOps / GLOWOpsDB | |
| GoDaddy domain | getglowop.com | |

---

## Architecture (what talks to what)

```
Browser
  ├─ getglowop.com/          → marketing (static in deploy repo root)
  ├─ getglowop.com/app/      → fleet dashboard (Python live/)
  ├─ getglowop.com/partner/  → partner console (auth required when Clerk on)
  ├─ /partner/sign-in|sign-up → Clerk.js mounts → redirect /partner/
  └─ Clerk Account / Frontend API (*.clerk.accounts.dev)

Railway service (getglowop)
  ├─ Dockerfile → python live/server.py
  ├─ env: CLERK_* , SUPABASE_* , DATABASE_URL , GLOWOPS_*
  └─ SQLite today (GLOWOPS_DATA); Postgres via DATABASE_URL next

Supabase GLOWOpsDB     → Postgres (keys on Railway; schema/RLS later)
GoDaddy                → domain registration + DNS (or Cloudflare DNS)
GitHub main push       → Railway auto-deploy
```

---

## Phase A — Build locally

1. Develop in `GlowOps/dashboard-app/` (Python stdlib server + `static/`).
2. Run: `python server.py` → `http://127.0.0.1:8787/`
3. Confirm locally:
   - `/app/` fleet UI
   - `/partner/` partner shell
   - `/api/health`
4. Auth pages (when wiring Clerk):
   - `/partner/sign-in`
   - `/partner/sign-up`
   - after auth → `/partner/` dashboard

**Direction of truth:** edit **live tree** (`GlowOps/dashboard-app/`), then **copy into** deploy repo `getglowop/live/` before push. Do not hand-edit only Railway / only the kit without syncing back.

---

## Phase B — Deploy repo + GitHub

### B1. Repo shape (GlowOps)

```
getglowop/                 ← git root, connected to Railway
  Dockerfile               ← python:3.11, CMD live/server.py
  railway.toml             ← healthcheck /api/health
  nixpacks.toml            ← fallback start
  requirements.txt         ← PyJWT[crypto], …
  index.html, …            ← marketing site
  live/
    server.py              ← app entry
    static/                ← partner.html, sign-in, sign-up, app UI
    clerk_auth.py
    partners.py
    …
```

### B2. Connect Railway to GitHub

1. [railway.app](https://railway.app) → New project → **Deploy from GitHub**.
2. Select `cresculus/getglowop` (or the new app’s repo).
3. Service name = product slug (`getglowop`).
4. Builder: **Dockerfile** (see `railway.toml`).
5. Start: `python live/server.py` (PORT from Railway).
6. Health: `GET /api/health`.

### B3. Ship loop (every change)

```text
1. Edit GlowOps/dashboard-app/…
2. Copy changed files → RSA_App_V2_LOCAL/getglowop/live/…
3. cd getglowop
4. git add … && git commit && git push origin main
5. Railway deploys from main
```

Do **not** commit secrets. Env vars live only on Railway.

---

## Phase C — GoDaddy domain → Railway

### C1. Buy / own the domain

1. GoDaddy → Domains → register or use existing (GlowOps: **getglowop.com**).
2. Note: GoDaddy often **cannot** CNAME the apex (`@`) the way Railway wants. Prefer one of:

| Option | When |
|---|---|
| **A. Cloudflare DNS** (recommended) | Point GoDaddy **nameservers** to Cloudflare; manage records in Cloudflare (CNAME flattening for apex) |
| **B. www only** | Railway custom domain `www.getglowop.com` + CNAME `www` → Railway host; redirect apex → www |
| **C. Provider that supports ALIAS / ANAME** | Same idea as Cloudflare flattening |

### C2. Attach domain on Railway

1. Railway → getglowop service → **Settings → Networking / Domains**.
2. **Custom domain** → `getglowop.com` (and/or `www.getglowop.com`).
3. Railway shows the target (e.g. `xxxx.up.railway.app`) and any **TXT** verification record.
4. Copy those exactly into DNS (Cloudflare or GoDaddy).

### C3. DNS records (typical)

| Type | Name | Value | Notes |
|---|---|---|---|
| CNAME | `www` | `xxxx.up.railway.app` | Always works on GoDaddy |
| CNAME or flattened | `@` | Railway target | Needs Cloudflare / ALIAS |
| TXT | as Railway shows | verification string | Required for SSL / verify |
| CAA | optional | include `letsencrypt.org` | If you use CAA at all |

Wait for Railway domain = verified + certificate issued (can take minutes to hours).

### C4. Sanity

- `https://getglowop.com/api/health` → JSON `ok`
- `https://getglowop.com/` → marketing
- `https://getglowop.com/app/` → fleet UI

---

## Phase D — Clerk (partner login)

### D1. Create a **dedicated** Clerk application

1. [dashboard.clerk.com](https://dashboard.clerk.com) → **Create application** (not Cresculus).
2. Name: **GLOW Ops** / product name.
3. Enable **Email** (Microsoft/Google optional).
4. Stay on **Development** until cutover; add **Production** instance later.

### D2. Where to click (Clerk left nav)

| Need | Click |
|---|---|
| `pk_` / `sk_` keys | **Developer → API keys** |
| Clerk host `*.clerk.accounts.dev` | **Developer → Domains** (leave default in Dev) |
| Home / sign-in paths | **Developer → Paths** |
| Name / logo | **Application → Settings** (not keys) |
| SSO providers | **Configure** (User & auth / SSO) |

### D3. Paths (Developer → Paths)

| Field | GlowOps value |
|---|---|
| Fallback development host | `http://127.0.0.1:8787` |
| Home URL | `/partner/` |
| Sign-in | prefer host page `/partner/sign-in` (or Account Portal until pages exist) |
| Sign-up | prefer host page `/partner/sign-up` |
| After sign-in / sign-up | `/partner/` |

### D4. App routes we shipped

| URL | Role |
|---|---|
| `/partner/sign-up` | Clerk `<SignUp />` → redirect `/partner/` |
| `/partner/sign-in` | Clerk `<SignIn />` → redirect `/partner/` |
| `/partner/` | Dashboard if session; else redirect to sign-in |
| Log out | → `/partner/sign-in` |

### D5. Copy keys → Railway (never into chat)

| Railway variable | Clerk |
|---|---|
| `CLERK_PUBLISHABLE_KEY` | Publishable `pk_test_…` / `pk_live_…` |
| `CLERK_SECRET_KEY` | Secret `sk_…` |
| `CLERK_AUTHORIZED_PARTIES` | `https://getglowop.com,http://127.0.0.1:8787` |
| `GLOWOPS_PUBLIC_URL` | `https://getglowop.com` |
| `GLOWOPS_REQUIRE_AUTH` | `0` until smoke test passes; then `1` |

---

## Phase E — Supabase (database)

### E1. Create project

1. [supabase.com/dashboard](https://supabase.com/dashboard) → org for product (**GetGLOWOps**).
2. **New project** → name `{Product}DB` (GlowOps: **GLOWOpsDB**).
3. Generate DB password → store offline.
4. Region near Railway (GlowOps: **us-east-2**).
5. Data API **On**; auto-grant API on new tables **Off**; RLS on new tables **On**.
6. Wait until **Healthy**.

### E2. Where keys are

| Need | Click |
|---|---|
| Publishable / secret (or legacy anon / service_role) | **Settings → API Keys** (not General) |
| Postgres URI | Top **Connect → Direct** |

### E3. Map to Railway

| Supabase | Railway variable |
|---|---|
| Project URL `https://….supabase.co` | `SUPABASE_URL` |
| Publishable `sb_publishable_…` (or legacy anon) | `SUPABASE_ANON_KEY` |
| Secret `sb_secret_…` (or legacy service_role) | `SUPABASE_SERVICE_ROLE_KEY` |
| `postgresql://postgres:PASSWORD@db.….supabase.co:5432/postgres` | `DATABASE_URL` |

- Replace `[YOUR-DATABASE-PASSWORD]` with the **database** password (not the API secret).
- `service_role` / `sb_secret_` = **server only**.
- Do **not** enable Supabase Authentication for partner login.

Schema + RLS = later (SQL Editor / migrations). App may still use SQLite until then; vars can sit on Railway early.

---

## Phase F — Railway variables checklist (GlowOps)

Service → **Variables** (mask values; never screenshot secrets into chat):

```text
CLERK_PUBLISHABLE_KEY
CLERK_SECRET_KEY
CLERK_AUTHORIZED_PARTIES=https://getglowop.com,http://127.0.0.1:8787
GLOWOPS_PUBLIC_URL=https://getglowop.com
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
DATABASE_URL
```

Optional later: `GLOWOPS_REQUIRE_AUTH=1`, Microsoft Graph vars (see `railway-getglowop-env.md`).

**Deploy** after saving. Confirm new deployment is green.

If a secret was ever pasted into chat: **rotate** Clerk secret + Supabase secret, update Railway, redeploy.

---

## Phase G — Smoke test (must pass)

1. `https://getglowop.com/api/health` → `ok`, ideally `"clerk": true`.
2. `https://getglowop.com/partner/sign-up` → Clerk widget loads.
3. Create account → lands on `/partner/` dashboard (Home / Enroll / Businesses…).
4. Log out → `/partner/sign-in`.
5. Sign in again → dashboard.
6. `https://getglowop.com/app/` still loads fleet UI.
7. Only then set `GLOWOPS_REQUIRE_AUTH=1` if you want to force auth hard.

---

## Phase H — Ongoing updates

| Change type | Where | Ship |
|---|---|---|
| UI / partner / auth pages | `GlowOps/dashboard-app/static/` | sync → `getglowop/live/static/` → push |
| Server / Clerk verify / partners | `dashboard-app/*.py` | sync → `live/` → push |
| Env / secrets | Railway Variables only | redeploy |
| DNS | GoDaddy / Cloudflare | wait for SSL |
| Clerk paths / SSO | Clerk Dashboard | no git |
| DB schema | Supabase SQL Editor / migrations | then app code |

---

## GlowOps filled snapshot (2026-11-24)

| Step | Done |
|---|---|
| Local dashboard-app | Yes |
| GitHub `cresculus/getglowop` | Yes |
| Railway service + Dockerfile | Yes |
| Domain getglowop.com on Railway | Yes (GoDaddy-registered) |
| Clerk GLOW Ops + Paths | Yes (Dev) |
| Supabase GLOWOpsDB `goxottatihejvzakhdho` us-east-2 | Yes |
| Railway Clerk + Supabase + DATABASE_URL | Yes |
| `/partner/sign-in` + `/partner/sign-up` → `/partner/` | Yes (push `7018e95`) |
| Postgres schema + RLS | Not yet |
| Graph / Intune Connect | Not yet |
| Clerk Production instance | Not yet |

---

## Template — next app checklist

```text
Product:
Domain (GoDaddy):
GitHub repo:
Railway project/service:
Local path:
Deploy path (live/):

[ ] Local runs on 127.0.0.1:PORT
[ ] GitHub repo + Railway from GitHub
[ ] Dockerfile / start command / /api/health
[ ] Custom domain on Railway + DNS (Cloudflare recommended for apex)
[ ] https://DOMAIN/api/health OK
[ ] Clerk app (dedicated) + Paths
[ ] Supabase org/project + API keys + DATABASE_URL
[ ] Railway vars: Clerk then Supabase
[ ] Sign-in / sign-up routes + after-auth → dashboard
[ ] Smoke test sign-up → dashboard → sign-out → sign-in
[ ] Rotate any secret that hit chat
[ ] GLOWOPS_REQUIRE_AUTH (or app equivalent) when ready
```

---

## Do not

- Reuse another product’s Clerk or Supabase.
- Put secrets in git, HTML, or chat.
- Use Supabase Auth while Clerk is the IdP.
- Hand-edit only production without updating `dashboard-app/` + `getglowop/live/`.
- Expect GoDaddy apex CNAME without Cloudflare (or www-only / ALIAS).

---

*End of master playbook. For key-screen click paths, use `saas-stack-bootstrap.md`.*
