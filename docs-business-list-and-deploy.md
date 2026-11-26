# Businesses page and one-click deploy

Built 2026-11-26. Code: `live/deploy_kits.py`, `live/intune_graph.py`, routes in `live/server.py`, UI in `live/static/partner.*`. Public page: `deploy.html`.

## Businesses page

- Card grid with search, status filter, sort (name, ghosts, lowest GLOW, devices, last check-in), pins, and a table toggle. Layout and pins are saved in the browser.
- Each card shows devices, average GLOW, ghosts, last check-in, and a status:
  - **Not deployed**: no devices and no check-ins.
  - **Collecting · day N of 30**: first check-in under 30 days ago.
  - **Report ready**: 30 days or more.
  - **Stale**: nothing for 7 days.
- The numbers come from `/api/partner/portfolio`, which now returns `firstCheckIn`, `lastCheckIn`, and `canDeploy` per business.

## Deploy

Every download mints a new join key for that business (`enroll.manage`: owner, admin, operator). The password goes into the package only. The server keeps a hash. Each download writes an `audit_events` row (`deploy.download`, `intune.deploy`, `intune.connect`).

| Channel | Route | What you get |
| --- | --- | --- |
| Intune file | `POST /api/partner/deploy-kit` `channel=intune` | Zip: `GlowOpsAgent.intunewin` (built on the server, same format as Microsoft's prep tool), `Detect.ps1`, settings sheet |
| RMM | `channel=rmm` | One `.ps1` with URL, key, and password inside. Run as SYSTEM |
| Any PC | `channel=device` | Zip: `Install GlowOps.cmd` (self-elevates), `Install.ps1`, join file |
| Intune push | `POST /api/partner/intune/deploy` | Uploads or refreshes the Win32 app in the client's Intune through Graph, optional assignment to all devices or one group |

The agent EXE is not inside the packages. `Install.ps1` downloads it from `<dashboard>/download/GlowOpsAgent.exe` if it is not next to the script.

Pushing again keeps the same Intune app and swaps its content, so new devices get the fresh key and devices that already joined are left alone.

Revoking a key also stops devices that joined with it from reporting, because refresh allows expired keys but not revoked ones. Let keys expire unless one leaked.

## Intune push setup (one time, GlowOps side)

Until this is done, the dialog shows "Coming to this host", and the `.intunewin` download still works.

1. Entra admin center, App registrations, New. Supported accounts: **any organizational directory (multitenant)**.
2. Redirect URI (Web): `https://getglowop.com/partner/intune/callback`.
3. API permissions: Microsoft Graph, **Application**, `DeviceManagementApps.ReadWrite.All`.
4. Certificates & secrets: new client secret.
5. Railway variables: `GLOWOPS_INTUNE_CLIENT_ID`, `GLOWOPS_INTUNE_CLIENT_SECRET`. `GLOWOPS_PUBLIC_URL` must match the redirect URI host.

Per client: an admin or owner presses **Connect Intune**, and a Global Admin of that client's Microsoft 365 approves. The console finishes the connection, so a consent link sent to someone else's admin cannot attach their directory to the sender's business. The directory id is stored in `connections_intune`. No customer tokens are stored. Each push asks Entra for a fresh app-only token.

## Not verified yet

- The Graph upload has not run against a real tenant. Expect to fix one or two request details on the first live push.
- The `.intunewin` round-trips through decrypt, HMAC, and digest checks locally, but has not been uploaded in the Intune portal yet.
- No package has run on a real PC end to end. The generated scripts parse with no errors in Windows PowerShell.
