# Clerk Google / Microsoft sign-in (GlowOps)

If Google or Microsoft buttons appear to do nothing:

## 1. Enable SSO in Clerk

Clerk Dashboard → **GLOW Ops** → **Configure** (not Developer → API keys) → **SSO connections** / **Social connections**:

- Enable **Google**
- Enable **Microsoft** (optional)

On Hobby/Development, Clerk can use shared OAuth apps. If Google still fails, add your own Google Cloud OAuth client ID/secret in that Clerk screen.

## 2. Allowed redirect URLs

Clerk → **Developer → Paths** (and any “Allowed redirect / origins” list):

- `https://getglowop.com`
- `https://getglowop.com/partner`
- `https://getglowop.com/partner/`
- `https://getglowop.com/partner/sign-in`
- `https://getglowop.com/partner/sign-up`
- `https://getglowop.com/partner/sso-callback`
- `http://127.0.0.1:8787` (+ same paths for local)

## 3. App routes

| URL | Role |
|---|---|
| `/partner/sign-in` | Email + Google + Microsoft (path routing) |
| `/partner/sign-up` | Sign up |
| `/partner/sso-callback` | OAuth return |
| `/partner/` | Dashboard (redirects to sign-in if logged out) |
| `/partner/?view=people` | RBAC / invites |

## 4. Test checklist

1. Email OTP / password — `/partner/sign-in` → Continue → land on `/partner/` → **Sign out** in top bar  
2. Google — same page → Google → allow redirect → `/partner/sso-callback` → `/partner/`  
3. Microsoft — same  
4. People — Partner → **People · RBAC** → invite + role change  

Popup blockers: prefer full redirect (our SSO callback). Disable blockers on getglowop.com while testing.
