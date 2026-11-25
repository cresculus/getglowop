# Create a dedicated Clerk app for GlowOps

Do **not** reuse the Cresculus / “My Application” / Dashboard Clerk app.  
Create a **new** application named **GlowOps** (getglowop.com).

## 1. Create the application

1. Open [Clerk Dashboard](https://dashboard.clerk.com).
2. Top-left application switcher → **Create application** (not the existing Dashboard / Cresculus app).
3. Name: **GlowOps**.
4. Sign-in options (recommended for partners):
   - Email
   - Google (optional)
5. Create application → stay on the **Development** instance for lab; create **Production** when you go live.

## 2. Paths & URLs (Configure → Paths / Domains)

**Development (local):**

| Setting | Value |
|---|---|
| Application home URL | `http://127.0.0.1:8787` |
| Sign-in URL | `/partner/sign-in` |
| Sign-up URL | `/partner/sign-up` |
| After sign-in | `/partner/` |
| After sign-up | `/partner/` |

Allowed origins / redirect URLs:

- `http://127.0.0.1:8787`
- `http://localhost:8787`
- `http://127.0.0.1:8787/partner`
- `http://127.0.0.1:8787/partner/*`

**Production (getglowop.com):**

| Setting | Value |
|---|---|
| Home URL | `https://getglowop.com` |
| Sign-in | `/partner/sign-in` |
| Sign-up | `/partner/sign-up` |
| After sign-in | `/partner/` |
| After sign-up | `/partner/` |

Allowed:

- `https://getglowop.com`
- `https://getglowop.com/partner`
- `https://getglowop.com/partner/*`

## 3. Copy API keys → Railway (getglowop service)

Clerk → **API Keys** (for this GlowOps app):

| Railway variable | Clerk key |
|---|---|
| `CLERK_PUBLISHABLE_KEY` | Publishable key (`pk_test_…` / `pk_live_…`) |
| `CLERK_SECRET_KEY` | Secret key (`sk_test_…` / `sk_live_…`) |
| `CLERK_AUTHORIZED_PARTIES` | `https://getglowop.com,http://127.0.0.1:8787` |
| `GLOWOPS_PUBLIC_URL` | `https://getglowop.com` |
| `GLOWOPS_REQUIRE_AUTH` | `1` (after Partner Clerk UI is live) |

Also set (optional aliases used by some SDKs):

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` = same as `CLERK_PUBLISHABLE_KEY` (harmless if unused by Python)

## 4. Organizations (recommended for MSPs)

Enable **Organizations** on the GlowOps Clerk app:

- Each MSP partner ≈ one Clerk Organization  
- Map Organization id → GlowOps partner row later  

For v1 you can allow any signed-in Clerk user as a partner principal and bind businesses in GlowOps DB.

## 5. What you paste back here

After create, paste (dev is fine):

1. Publishable key (`pk_test_…`)  
2. Confirmation that secret key is in Railway (do **not** paste `sk_` in chat)  
3. Frontend API / JWKS issuer host from Clerk (e.g. `https://xxx.clerk.accounts.dev`) — shown on API Keys page  

Then we wire Partner sign-in to this app and drop the demo password form.
