# Create a dedicated Clerk app for GlowOps

Do **not** reuse the Cresculus / “My Application” / Dashboard Clerk app.  
Create a **new** application named **GlowOps** / **GLOW Ops** (getglowop.com).

**Full replicate playbook (Clerk + Supabase + Railway):** `docs/saas-stack-bootstrap.md`.

## 1. Create the application

1. Open [Clerk Dashboard](https://dashboard.clerk.com).
2. Top-left application switcher → **Create application**.
3. Name: **GlowOps** / **GLOW Ops**.
4. Sign-in options: **Email** (Microsoft / Google optional).
5. Stay on **Development** for lab; **Production** instance when live.

## 2. Where to click (current Dashboard)

| Need | Nav |
|---|---|
| API keys (`pk_` / `sk_`) | **Developer → API keys** |
| Clerk auth host | **Developer → Domains** (leave `*.clerk.accounts.dev` in Dev) |
| Home / Account Portal paths | **Developer → Paths** |
| Name / logo | **Application → Settings** (not keys) |

## 3. Paths (Developer → Paths)

| Field | Development value |
|---|---|
| Fallback development host | `http://127.0.0.1:8787` |
| Home URL | `/partner/` |
| Unauthorized sign in | blank or `/partner/` |
| Sign-in / Sign-up / Sign out | **Account Portal** (`*.accounts.dev`) — leave selected |

Production instance later: public host `https://getglowop.com`, same `/partner/` home.

## 4. Copy API keys → Railway (getglowop)

| Railway variable | Clerk key |
|---|---|
| `CLERK_PUBLISHABLE_KEY` | Publishable (`pk_test_…` / `pk_live_…`) |
| `CLERK_SECRET_KEY` | Secret (`sk_test_…` / `sk_live_…`) |
| `CLERK_AUTHORIZED_PARTIES` | `https://getglowop.com,http://127.0.0.1:8787` |
| `GLOWOPS_PUBLIC_URL` | `https://getglowop.com` |
| `GLOWOPS_REQUIRE_AUTH` | `1` only after Partner Clerk UI works |

Optional: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` = same publishable key.

## 5. Organizations (later)

Each MSP partner ≈ one Clerk Organization → map to GlowOps partner row.  
v1: any signed-in Clerk user as partner principal; bind businesses in DB.

## 6. Paste back in chat (safe only)

1. Publishable key (`pk_test_…`) — optional  
2. Confirm secret is in Railway — **do not** paste `sk_`  
3. Frontend API host (e.g. `….clerk.accounts.dev`)
