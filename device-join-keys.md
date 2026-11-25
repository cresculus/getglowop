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

## Agent UX (one PC)

1. Download [`/download/GlowOpsAgent.exe`](https://getglowop.com/download/GlowOpsAgent.exe) **or** the Win32 zip.
2. If Windows blocks the file: run **`Open-GlowOpsAgent.cmd`** (Unblock-File), or right-click EXE → Properties → Unblock → Apply.
3. Double-click `GlowOpsAgent.exe` → enter Dashboard URL, Join Key, Join Password.
4. Successful join uploads this host into the bound business.

## Silent / fleet (Intune · SCCM · RMM)

Mint a **7-day or 30-day** join key for the push window, then revoke when done.

```powershell
# Stage Win32 folder (+ optional .intunewin)
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Package-GlowOpsAgentIntune.ps1 `
  -JoinKey 'GOW-…' `
  -JoinPassword '…' `
  -BuildIntuneWin
```

Output: `dist\GlowOpsAgent-Win32\` (EXE + `Install.ps1` / `Uninstall.ps1` / `Detect.ps1` + `glowops.join.json`).

| Channel | How |
|---|---|
| **Intune** | Wrap folder with IntuneWinAppUtil → Win32 app, install as **System**, detection = `Detect.ps1`. No extra dependencies (self-contained win-x64). |
| **SCCM / MECM** | Script installer, same `Install.ps1` / `Uninstall.ps1`, detect `C:\ProgramData\GlowOps\GlowOpsAgent.exe`. |
| **RMM** | Run `Install.ps1` as SYSTEM once per device (or paste script + drop EXE + `glowops.join.json`). |

Install command:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File Install.ps1
```

Credentials can also come from env `GLOWOPS_URL` / `GLOWOPS_JOIN_KEY` / `GLOWOPS_JOIN_PASSWORD` (RMM secret store) instead of baking the password into the package.

CLI (lab / script):

```text
GlowOpsAgent.exe join --url https://getglowop.com --join-key GOW-… --password "…" --quiet
```

After expiry the same credentials cannot join or upload.
