# Device join keys (agent enrollment)

Partners mint **join key + password** pairs in `/partner/` → **Enroll**.

## Properties

| Control | Behavior |
|---|---|
| Unique | `GOW-XXXX-XXXX-XXXX` + 28-char password |
| Storage | Password hashed (PBKDF2); plaintext shown once |
| Scope | `device-join` only — agent heartbeat/ingest/join |
| Expiry | 1h / 24h / 7d / **30d max** — fails closed after |
| Revocation | Immediate; agent uploads rejected |

These are access-control measures for device onboarding (unique secrets, time-bound, purpose-limited). They support a compliance program; they are not a SOC 1 or SOC 2 attestation by themselves.

## Agent UX

Double-click `GlowOpsAgent.exe` → branded menu asks for:

1. Dashboard URL  
2. Join Key (from Enroll tab)  
3. Join Password  

Successful join uploads this host into the bound business. After expiry the same credentials cannot join or upload.
