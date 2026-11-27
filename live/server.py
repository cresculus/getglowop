#!/usr/bin/env python3
"""GlowOps live dashboard + partner MCP.

Serves:
  /app/                 live fleet UI (demo, no login)
  /partner/             partner login + MCP key console
  /mcp                  partner MCP JSON-RPC (Bearer gow_mcp_…)
  /api/*                JSON API
  /download/*           agent artifacts
  /*                    optional marketing site
"""
from __future__ import annotations

import csv
import io
import json
import os
import shutil
import sys
import zipfile
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from db import (  # noqa: E402
    business_activity,
    fleet_summary,
    get_tenant,
    list_devices,
    record_heartbeat,
    record_ingest,
    seed_if_empty,
    set_tenant_name,
    upsert_device,
)
from clerk_auth import (  # noqa: E402
    clerk_configured,
    partner_from_claims,
    public_clerk_config,
    verify_bearer_token,
)
import deploy_kits  # noqa: E402
import intune_graph  # noqa: E402
from graph_map import map_managed_devices  # noqa: E402
from mcp_protocol import handle_mcp_rpc  # noqa: E402
from enrollment import (  # noqa: E402
    list_enrollment_keys,
    mint_enrollment_key,
    revoke_enrollment_key,
    verify_enrollment,
)
from partners import (  # noqa: E402
    authenticate_partner,
    bind_business,
    create_session,
    ensure_clerk_partner,
    list_mcp_keys,
    list_partner_businesses,
    mint_mcp_key,
    partner_from_mcp_key,
    partner_from_session,
    revoke_mcp_key,
    revoke_session,
    seed_demo_partner,
)
from rbac import (  # noqa: E402
    accept_invitation,
    create_invitation,
    ensure_rbac_schema,
    list_invitations,
    list_members,
    partner_can,
    partner_role_on_business,
    permission_catalog,
    revoke_invitation,
    revoke_membership,
    set_member_role,
)
import re  # noqa: E402

def _resolve_data_dir() -> Path:
    """Prefer an explicit GLOWOPS_DATA, then a mounted /data volume, then local ./data.

    Never silently use /tmp in production — Railway wipes it on every deploy, which
    erases renamed businesses and joined devices.
    """
    raw = (os.environ.get("GLOWOPS_DATA") or "").strip()
    candidates: list[Path] = []
    if raw:
        candidates.append(Path(raw))
    candidates.append(Path("/data"))
    candidates.append(ROOT / "data")
    for path in candidates:
        try:
            path.mkdir(parents=True, exist_ok=True)
            probe = path / ".glowops-write-test"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
            resolved = str(path.resolve()).replace("\\", "/").lower()
            if "/tmp/" in resolved or resolved.endswith("/tmp") or "/temp/" in resolved:
                print(
                    f"WARNING: GLOWOPS_DATA={path} looks ephemeral — renames and fleet devices will vanish on restart.",
                    flush=True,
                )
            else:
                print(f"GLOWOPS_DATA={path}", flush=True)
            return path
        except OSError as exc:
            print(f"data dir not usable ({path}): {exc}", flush=True)
    fallback = ROOT / "data"
    fallback.mkdir(parents=True, exist_ok=True)
    print(f"GLOWOPS_DATA fallback={fallback}", flush=True)
    return fallback


def _data_looks_persistent(path: Path) -> bool:
    resolved = str(path.resolve()).replace("\\", "/").lower()
    if resolved.startswith("/tmp") or "/temp/" in resolved or resolved.endswith("/tmp"):
        return False
    # Linux: treat /data as persistent only when it is a real mount (Railway volume).
    try:
        mounts = Path("/proc/mounts").read_text(encoding="utf-8", errors="ignore")
        target = str(path.resolve())
        if any(line.split()[1] == target for line in mounts.splitlines() if line.strip()):
            return True
        if target == "/data":
            return False
    except OSError:
        pass
    # Local Windows / macOS lab paths under the repo are fine.
    try:
        return path.resolve() == (ROOT / "data").resolve() or "glowops" in resolved
    except OSError:
        return False


DATA_DIR = Path("supabase")
DB_PATH = None
STATIC_DIR = ROOT / "static"
AGENT_DIR = ROOT / "agent"
HOST = os.environ.get("GLOWOPS_HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT") or os.environ.get("GLOWOPS_PORT") or "8787")
# Lab snapshot shipped with the image — used when runtime volume/tmp is empty.
BOOTSTRAP_DB = next(
    (
        p
        for p in (ROOT / "bootstrap" / "glowops.db", ROOT / "data" / "glowops.db")
        if p.is_file()
    ),
    ROOT / "bootstrap" / "glowops.db",
)

_marketing_env = os.environ.get("GLOWOPS_MARKETING_ROOT")
if _marketing_env:
    MARKETING_ROOT = Path(_marketing_env).resolve()
elif (ROOT.parent / "index.html").is_file() and (ROOT.parent / "dashboard.html").is_file():
    MARKETING_ROOT = ROOT.parent
elif (ROOT / "index.html").is_file() and ROOT.name != "static":
    MARKETING_ROOT = ROOT
else:
    MARKETING_ROOT = None


from pgstore import connect_postgres, import_sqlite_if_present  # noqa: E402

CONN = connect_postgres()
import_sqlite_if_present(CONN)
ensure_rbac_schema(CONN)
# Seeded demo fleet is lab-only. Signed-in partners never get this data.
# Set GLOWOPS_SEED_DEMO=1 on a lab host if you want the public /app/?tenant=demo sample.
DEMO_PARTNER = None
if os.environ.get("GLOWOPS_SEED_DEMO", "").strip() == "1":
    seed_if_empty(CONN, "demo")
    DEMO_PARTNER = seed_demo_partner(CONN)
    try:
        from rbac import grant_membership, get_membership

        _demo_id = (DEMO_PARTNER.get("partner") or {}).get("id") or "partner_demo"
        if not get_membership(CONN, _demo_id, "demo"):
            grant_membership(CONN, business_id="demo", partner_id=_demo_id, role="owner")
    except Exception:
        pass

AGENT_EXE_NAME = "GlowOpsAgent.exe"
AGENT_RELEASE_URL = os.environ.get(
    "GLOWOPS_AGENT_RELEASE_URL",
    "https://github.com/cresculus/getglowop/releases/latest/download/GlowOpsAgent.exe",
)


def _public_url() -> str:
    return (os.environ.get("GLOWOPS_PUBLIC_URL") or "https://getglowop.com").rstrip("/")


def _audit(partner_id: str, business_id: str, action: str, meta: dict) -> None:
    try:
        CONN.execute(
            "INSERT INTO audit_events (partner_id, business_id, action, meta, created_at) VALUES (?,?,?,CAST(? AS jsonb),?)",
            (partner_id, business_id, action, json.dumps(meta), datetime.now(timezone.utc).isoformat()),
        )
        CONN.commit()
    except Exception as exc:
        print(f"audit write failed: {exc}", flush=True)


def _business_name(partner_id: str, business_id: str) -> str:
    for b in list_partner_businesses(CONN, partner_id):
        if b.get("business_id") == business_id:
            return b.get("business_name") or business_id
    return business_id


def _json_bytes(obj: object, status: int = 200) -> tuple[int, bytes, str]:
    return status, json.dumps(obj, default=str).encode("utf-8"), "application/json; charset=utf-8"


def _read_json(handler: BaseHTTPRequestHandler) -> object:
    length = int(handler.headers.get("Content-Length") or 0)
    raw = handler.rfile.read(length) if length else b"{}"
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def _agent_exe_path() -> Path | None:
    candidate = AGENT_DIR / AGENT_EXE_NAME
    return candidate if candidate.is_file() else None


def _agent_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        exe = _agent_exe_path()
        if exe:
            zf.write(exe, arcname=f"glowops-agent/{AGENT_EXE_NAME}")
        sidecar = AGENT_DIR / "glowops.agent.json"
        if sidecar.is_file():
            zf.write(sidecar, arcname="glowops-agent/glowops.agent.json")
        py = AGENT_DIR / "agent.py"
        if py.is_file():
            zf.write(py, arcname="glowops-agent/agent.py")
        cmd = AGENT_DIR / "Open-GlowOpsAgent.cmd"
        if cmd.is_file():
            zf.write(cmd, arcname="glowops-agent/Open-GlowOpsAgent.cmd")
        zf.writestr(
            "glowops-agent/README.txt",
            "GlowOps Agent (Windows)\n"
            "1. Prefer Open-GlowOpsAgent.cmd (clears download block / SmartScreen MOTW)\n"
            "2. Or double-click GlowOpsAgent.exe — paste join key + password from Partner → Enroll\n"
            "3. If Windows says it protected your PC: More info → Run anyway, or Unblock in Properties\n"
            f"Direct EXE: /download/{AGENT_EXE_NAME}\n"
            "Fleet (Intune/RMM/SCCM): silent Install.ps1 in the Win32 package\n"
            "Partner console: /partner/\n",
        )
    return buf.getvalue()


def _content_type(path: Path) -> str:
    return {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".xml": "application/xml",
        ".txt": "text/plain; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".toml": "text/plain; charset=utf-8",
    }.get(path.suffix.lower(), "application/octet-stream")


def _safe_file(root: Path, rel: str) -> Path | None:
    if not rel or ".." in Path(rel).parts:
        return None
    candidate = (root / rel).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


class Handler(BaseHTTPRequestHandler):
    server_version = "GlowOps/0.2"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _send(self, status: int, body: bytes, content_type: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, location: str, status: int = 302) -> None:
        self.send_response(status)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def _serve_static_html(self, name: str, status: int = 200) -> bool:
        """Serve a file from STATIC_DIR with no-store. Returns False if missing."""
        f = STATIC_DIR / name
        if not f.is_file():
            return False
        self._send(
            status,
            f.read_bytes(),
            _content_type(f),
            {"Cache-Control": "no-store, max-age=0"},
        )
        return True

    def _wants_html(self) -> bool:
        accept = (self.headers.get("Accept") or "").lower()
        return "text/html" in accept or "*/*" in accept or not accept

    def _not_found(self) -> None:
        """JSON for APIs; branded HTML shell when a browser navigates to a missing path."""
        if self._wants_html() and self._serve_static_html("partner-not-found.html", status=404):
            return
        self._send(404, b'{"error":"not found"}', "application/json")

    def _cookie(self, name: str) -> str | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        jar = SimpleCookie()
        jar.load(raw)
        morsel = jar.get(name)
        return morsel.value if morsel else None

    def _bearer(self) -> str | None:
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return None

    def _session_partner(self):
        return partner_from_session(CONN, self._cookie("glowops_partner"))

    def _partner_principal(self):
        """Clerk JWT (Partner UI) or legacy glowops_partner cookie session."""
        token = self._bearer()
        if token and token.count(".") == 2 and clerk_configured():
            claims = verify_bearer_token(token)
            if claims:
                stub = partner_from_claims(claims)
                return ensure_clerk_partner(
                    CONN,
                    partner_id=stub["id"],
                    name=stub.get("name") or "Partner",
                    email=stub.get("email") or "",
                )
        return self._session_partner()

    def _fleet_tenant_for_read(self, tenant: str) -> str | None:
        """Business id this caller may read. None means deny.

        Signed-in partners only see businesses they belong to. Anonymous callers
        only see the lab demo tenant, and only when GLOWOPS_SEED_DEMO=1.
        """
        asked = (tenant or "").strip()
        if asked in ("*", "all"):
            return None
        partner = self._partner_principal()
        demo_on = os.environ.get("GLOWOPS_SEED_DEMO", "").strip() == "1"
        if partner and partner.get("id") != "partner_demo":
            if not asked or asked == "demo":
                from partners import ensure_partner_home_business

                asked = ensure_partner_home_business(CONN, partner).get("business_id") or ""
            if asked and partner_can(CONN, partner["id"], asked, "devices.read"):
                return asked
            return None
        if demo_on and asked in ("", "demo"):
            return "demo"
        return None

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        tenant = (qs.get("tenant") or [""])[0].strip()
        if path.startswith("/api/"):
            partner_for_tenant = self._partner_principal()
            # Signed-in partners always use their own empty business — never the lab demo fleet.
            if partner_for_tenant and partner_for_tenant.get("id") != "partner_demo":
                if not tenant or tenant == "demo":
                    from partners import ensure_partner_home_business

                    tenant = ensure_partner_home_business(CONN, partner_for_tenant).get("business_id") or ""
            elif not tenant:
                if os.environ.get("GLOWOPS_SEED_DEMO", "").strip() == "1":
                    tenant = "demo"
                elif path.rstrip("/") in ("/api/summary", "/api/devices", "/api/business"):
                    status, body, ctype = _json_bytes(
                        {
                            "tenantId": None,
                            "businessId": None,
                            "businessName": None,
                            "deviceCount": 0,
                            "avgGlowScore": None,
                            "ghostCount": 0,
                            "repairBeforeReplaceCount": 0,
                            "manufacturingKgOnBooks": 0,
                            "avoidablePurchasesIfExtended": 0,
                            "byCall": {
                                "keep": 0,
                                "repair": 0,
                                "redeploy": 0,
                                "refresh": 0,
                                "recycle": 0,
                                "ghost": 0,
                            },
                            "devices": [],
                            "count": 0,
                            "business": None,
                        }
                    )
                    return self._send(status, body, ctype)

        if path.rstrip("/") in ("/api/health", "/health"):
            status, body, ctype = _json_bytes(
                {
                    "ok": True,
                    "service": "glowops",
                    "app": "/app/",
                    "partner": "/partner/",
                    "mcp": "/mcp",
                    "fleetAuth": "none-demo",
                    "partnerAuth": "clerk+session+mcp-key" if clerk_configured() else "session+mcp-key",
                    "clerk": clerk_configured(),
                    "clerkPublishableSet": bool(
                        (os.environ.get("CLERK_PUBLISHABLE_KEY") or os.environ.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") or "").strip()
                    ),
                    "clerkSecretSet": bool((os.environ.get("CLERK_SECRET_KEY") or "").strip()),
                    "dataDir": "supabase",
                    "dataPersistent": True,
                    "database": "supabase",
                    "agentIntervals": {
                        "inventoryHours": 6,
                        "heartbeatMinutes": 15,
                    },
                }
            )
            return self._send(status, body, ctype)

        fleet_read = path.rstrip("/") in (
            "/api/summary",
            "/api/business",
            "/api/devices",
            "/api/export.csv",
        ) or path.startswith("/api/devices/")
        if fleet_read:
            allowed = self._fleet_tenant_for_read(tenant)
            if not allowed:
                return self._send(403, b'{"error":"business not assigned"}', "application/json")
            tenant = allowed

        if path.rstrip("/") == "/api/summary":
            status, body, ctype = _json_bytes(fleet_summary(CONN, tenant))
            return self._send(status, body, ctype)

        if path.rstrip("/") == "/api/logs":
            partner = self._partner_principal()
            if not partner or partner.get("id") == "partner_demo":
                return self._send(401, b'{"error":"sign in"}', "application/json")
            try:
                result = CONN.execute(
                    "SELECT business_id, action, meta, created_at FROM audit_events WHERE partner_id = ? ORDER BY created_at DESC LIMIT 200",
                    (partner["id"],),
                )
                logs = []
                for raw in result.fetchall():
                    row = dict(raw)
                    meta = row.get("meta")
                    if isinstance(meta, str):
                        try:
                            meta = json.loads(meta)
                        except json.JSONDecodeError:
                            meta = {"note": meta}
                    created = row.get("created_at")
                    logs.append({
                        "at": created.isoformat() if hasattr(created, "isoformat") else created,
                        "action": row.get("action"),
                        "businessId": row.get("business_id"),
                        "detail": meta if isinstance(meta, dict) else {},
                    })
            except Exception as exc:
                return self._send(500, json.dumps({"error": "logs unavailable"}).encode(), "application/json")
            return self._send(*_json_bytes({"logs": logs}))

        if path.rstrip("/") == "/api/business":
            status, body, ctype = _json_bytes(
                {"business": get_tenant(CONN, tenant), "tenantId": tenant}
            )
            return self._send(status, body, ctype)

        if path.rstrip("/") == "/api/devices":
            rows = list_devices(CONN, tenant)
            # Drop bulky raw_json from list responses — keeps the fleet table reliable.
            slim = []
            for r in rows:
                item = dict(r)
                item.pop("raw_json", None)
                slim.append(item)
            status, body, ctype = _json_bytes({"tenantId": tenant, "devices": slim, "count": len(slim)})
            return self._send(status, body, ctype)

        if path.startswith("/api/devices/"):
            device_id = path[len("/api/devices/") :].strip("/")
            if not device_id:
                return self._send(400, b'{"error":"device id required"}', "application/json")
            rows = list_devices(CONN, tenant)
            match = next((dict(r) for r in rows if str(r.get("id")) == device_id), None)
            if not match:
                return self._send(404, b'{"error":"device not found"}', "application/json")
            inv = None
            raw = match.get("raw_json")
            if raw:
                try:
                    parsed = json.loads(raw) if isinstance(raw, str) else raw
                    inv = parsed.get("glowopsInventory") if isinstance(parsed, dict) else None
                    if inv is None and isinstance(parsed, dict) and parsed.get("device"):
                        inv = parsed
                    match["inventory"] = inv
                    match["raw"] = parsed
                except Exception:
                    match["inventory"] = None
                    match["raw"] = None
            status, body, ctype = _json_bytes({"tenantId": match.get("business_id") or match.get("tenant_id") or tenant, "device": match})
            return self._send(status, body, ctype)

        if path.rstrip("/") == "/api/export.csv":
            rows = list_devices(CONN, tenant)
            out = io.StringIO()
            w = csv.writer(out)
            w.writerow(
                [
                    "device_name",
                    "manufacturer",
                    "model",
                    "serial_number",
                    "call",
                    "glow_score",
                    "age_years",
                    "check_in_days",
                    "compliance_state",
                    "rationale",
                ]
            )
            for d in rows:
                w.writerow(
                    [
                        d.get("device_name"),
                        d.get("manufacturer"),
                        d.get("model"),
                        d.get("serial_number"),
                        d.get("call_label"),
                        d.get("glow_score"),
                        d.get("age_years"),
                        d.get("check_in_days"),
                        d.get("compliance_state"),
                        d.get("rationale"),
                    ]
                )
            data = out.getvalue().encode("utf-8")
            return self._send(
                200,
                data,
                "text/csv; charset=utf-8",
                {"Content-Disposition": f'attachment; filename="glowops-{tenant}.csv"'},
            )

        if path.rstrip("/") == "/api/config/public":
            status, body, ctype = _json_bytes(
                {
                    "clerk": public_clerk_config(),
                    "publicUrl": (os.environ.get("GLOWOPS_PUBLIC_URL") or "https://getglowop.com").rstrip("/"),
                    "authRequired": os.environ.get("GLOWOPS_REQUIRE_AUTH") == "1",
                }
            )
            return self._send(status, body, ctype)

        # Partner session APIs
        if path.rstrip("/") == "/api/partner/me":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            from partners import ensure_partner_home_business

            home = ensure_partner_home_business(CONN, partner)
            businesses = [
                b for b in list_partner_businesses(CONN, partner["id"]) if b.get("business_id") != "demo"
            ]
            roles = []
            for b in businesses:
                bid = b["business_id"]
                roles.append(
                    {
                        "businessId": bid,
                        "businessName": b.get("business_name") or bid,
                        "role": partner_role_on_business(CONN, partner["id"], bid) or "owner",
                    }
                )
            status, body, ctype = _json_bytes(
                {
                    "partner": partner,
                    "clerk": clerk_configured(),
                    "roles": roles,
                    "primaryBusinessId": home.get("business_id"),
                    "primaryBusinessName": home.get("business_name"),
                    "permissions": permission_catalog(),
                }
            )
            return self._send(status, body, ctype)

        if path.rstrip("/") == "/api/partner/businesses":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            status, body, ctype = _json_bytes(
                {"businesses": list_partner_businesses(CONN, partner["id"])}
            )
            return self._send(status, body, ctype)

        if path.rstrip("/") == "/api/partner/portfolio":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            businesses = list_partner_businesses(CONN, partner["id"])
            rolls = {
                "businessCount": len(businesses),
                "deviceCount": 0,
                "ghostCount": 0,
                "repairCount": 0,
                "avgGlowScore": None,
                "manufacturingKgOnBooks": 0,
                "byCall": {"keep": 0, "repair": 0, "redeploy": 0, "refresh": 0, "recycle": 0, "ghost": 0},
                "businesses": [],
            }
            glow_sum = 0
            glow_n = 0
            for b in businesses:
                bid = b["business_id"]
                s = fleet_summary(CONN, bid)
                rolls["deviceCount"] += int(s.get("deviceCount") or 0)
                rolls["ghostCount"] += int(s.get("ghostCount") or 0)
                rolls["repairCount"] += int(s.get("repairBeforeReplaceCount") or 0)
                rolls["manufacturingKgOnBooks"] += int(s.get("manufacturingKgOnBooks") or 0)
                for call, n in (s.get("byCall") or {}).items():
                    rolls["byCall"][call] = rolls["byCall"].get(call, 0) + int(n or 0)
                if s.get("avgGlowScore") is not None and s.get("deviceCount"):
                    glow_sum += int(s["avgGlowScore"]) * int(s["deviceCount"])
                    glow_n += int(s["deviceCount"])
                try:
                    activity = business_activity(CONN, bid)
                except Exception:
                    activity = {"firstCheckIn": None, "lastCheckIn": None}
                rolls["businesses"].append(
                    {
                        "businessId": bid,
                        "businessName": b.get("business_name") or s.get("businessName") or bid,
                        "deviceCount": s.get("deviceCount") or 0,
                        "avgGlowScore": s.get("avgGlowScore"),
                        "ghostCount": s.get("ghostCount") or 0,
                        "repairCount": s.get("repairBeforeReplaceCount") or 0,
                        "firstCheckIn": activity["firstCheckIn"],
                        "lastCheckIn": activity["lastCheckIn"],
                        "canDeploy": partner_can(CONN, partner["id"], bid, "enroll.manage"),
                    }
                )
            rolls["avgGlowScore"] = round(glow_sum / glow_n) if glow_n else None
            status, body, ctype = _json_bytes(rolls)
            return self._send(status, body, ctype)

        if path.rstrip("/") == "/api/partner/mcp-keys":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            status, body, ctype = _json_bytes({"keys": list_mcp_keys(CONN, partner["id"])})
            return self._send(status, body, ctype)

        if path.rstrip("/") == "/api/partner/enrollment-keys":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            status, body, ctype = _json_bytes({"keys": list_enrollment_keys(CONN, partner["id"])})
            return self._send(status, body, ctype)

        if path.rstrip("/") == "/api/partner/rbac/catalog":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            status, body, ctype = _json_bytes(
                {
                    "roles": ["owner", "admin", "operator", "viewer"],
                    "permissions": permission_catalog(),
                }
            )
            return self._send(status, body, ctype)

        if path.rstrip("/") == "/api/partner/members":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            business_id = (qs.get("businessId") or qs.get("tenant") or [""])[0].strip()
            if not business_id:
                return self._send(400, b'{"error":"businessId required"}', "application/json")
            if not partner_can(CONN, partner["id"], business_id, "members.read"):
                return self._send(403, b'{"error":"forbidden"}', "application/json")
            status, body, ctype = _json_bytes(
                {
                    "businessId": business_id,
                    "myRole": partner_role_on_business(CONN, partner["id"], business_id),
                    "members": list_members(CONN, business_id),
                    "invitations": list_invitations(CONN, business_id),
                    "canManage": partner_can(CONN, partner["id"], business_id, "members.manage"),
                }
            )
            return self._send(status, body, ctype)

        if path.rstrip("/") in (f"/download/{AGENT_EXE_NAME}", "/download/agent.exe"):
            exe = _agent_exe_path()
            if exe:
                return self._send(
                    200,
                    exe.read_bytes(),
                    "application/vnd.microsoft.portable-executable",
                    {"Content-Disposition": f'attachment; filename="{AGENT_EXE_NAME}"'},
                )
            return self._redirect(AGENT_RELEASE_URL)

        if path.rstrip("/") == "/download/Open-GlowOpsAgent.cmd":
            cmd = AGENT_DIR / "Open-GlowOpsAgent.cmd"
            if cmd.is_file():
                return self._send(
                    200,
                    cmd.read_bytes(),
                    "application/x-bat",
                    {"Content-Disposition": 'attachment; filename="Open-GlowOpsAgent.cmd"'},
                )
            return self._send(404, b"Open-GlowOpsAgent.cmd missing", "text/plain; charset=utf-8")

        if path.rstrip("/") in ("/download/GlowOpsAgent-Win32.zip", "/download/agent-win32.zip"):
            # Fleet pack on GitHub Releases (Install.ps1 + EXE for Intune/RMM).
            return self._redirect(
                "https://github.com/cresculus/getglowop/releases/latest/download/GlowOpsAgent-Win32.zip"
            )

        if path.rstrip("/") == "/download/agent.zip":
            if _agent_exe_path() is None and not (AGENT_DIR / "agent.py").is_file():
                return self._redirect(AGENT_RELEASE_URL)
            data = _agent_zip()
            return self._send(
                200,
                data,
                "application/zip",
                {"Content-Disposition": 'attachment; filename="glowops-agent.zip"'},
            )

        if path.rstrip("/") == "/api/partner/intune/status":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            business_id = (qs.get("businessId") or [""])[0].strip()
            if not business_id or not partner_can(CONN, partner["id"], business_id, "enroll.manage"):
                return self._send(403, b'{"error":"forbidden"}', "application/json")
            try:
                connection = intune_graph.get_connection(CONN, business_id)
            except Exception:
                connection = None
            status, body, ctype = _json_bytes(
                {
                    "configured": intune_graph.configured(),
                    "connected": bool(connection),
                    "connection": connection,
                    "canConnect": partner_can(CONN, partner["id"], business_id, "connections.manage"),
                }
            )
            return self._send(status, body, ctype)

        if path.rstrip("/") == "/partner/intune/callback":
            # The signed-in console finishes this, so a consent link sent to someone
            # else's admin cannot attach their directory to the sender's business.
            from urllib.parse import urlencode

            raw_state = (qs.get("state") or [""])[0]
            consented = (qs.get("admin_consent") or [""])[0].lower() == "true"
            if not consented:
                return self._redirect("/partner/?view=biz&intune=failed")
            return self._redirect(
                "/partner/?"
                + urlencode(
                    {
                        "view": "biz",
                        "intuneState": raw_state,
                        "intuneDirectory": (qs.get("tenant") or [""])[0].strip(),
                    }
                )
            )

        # Partner console + Clerk auth pages.
        # Clerk path routing hits /partner/sign-in/continue, /factor-one, /sso-callback, etc.
        # Those must serve the same HTML shells (SPA fallback) or the browser gets JSON 404.
        if path.rstrip("/") in ("/partner", "/partner/"):
            if self._serve_static_html("partner.html"):
                return
        if path == "/partner/sign-in" or path.startswith("/partner/sign-in/"):
            if self._serve_static_html("partner-sign-in.html"):
                return
        if path == "/partner/sign-up" or path.startswith("/partner/sign-up/"):
            if self._serve_static_html("partner-sign-up.html"):
                return
        if path.rstrip("/") == "/partner/accept-invite" or path.startswith("/partner/accept-invite/"):
            if self._serve_static_html("partner-accept-invite.html"):
                return
        if path.rstrip("/") == "/partner/sso-callback" or path.startswith("/partner/sso-callback/"):
            if self._serve_static_html("partner-sso-callback.html"):
                return
        # Clerk sometimes lands on /sso-callback at the site root.
        if path.rstrip("/") == "/sso-callback":
            if self._serve_static_html("partner-sso-callback.html"):
                return

        # Live app static under /app/
        if path == "/app" or path == "/app/":
            f = STATIC_DIR / "index.html"
            return self._send(
                200,
                f.read_bytes(),
                _content_type(f),
                {"Cache-Control": "no-store, max-age=0"},
            )
        if path.startswith("/app/"):
            rel = path[len("/app/") :]
            if not rel or rel.endswith("/"):
                rel = "index.html"
            f = _safe_file(STATIC_DIR, rel)
            if f:
                # HTML/JS/CSS change often during partner UX work — never serve stale shells.
                return self._send(
                    200,
                    f.read_bytes(),
                    _content_type(f),
                    {"Cache-Control": "no-store, max-age=0"},
                )
            return self._send(404, b'{"error":"not found"}', "application/json")

        if path.rstrip("/") in ("/live", "/dashboard-live"):
            return self._redirect("/app/")

        if MARKETING_ROOT:
            rel = path.lstrip("/") or "index.html"
            if path.endswith("/") and path != "/":
                rel = path.strip("/") + "/index.html"
            f = _safe_file(MARKETING_ROOT, rel)
            if f and "live" not in Path(rel).parts[:1]:
                return self._send(
                    200,
                    f.read_bytes(),
                    _content_type(f),
                    {"Cache-Control": "no-store, max-age=0"},
                )
            if path == "/" or path == "":
                index = MARKETING_ROOT / "index.html"
                if index.is_file():
                    return self._send(
                        200,
                        index.read_bytes(),
                        _content_type(index),
                        {"Cache-Control": "no-store, max-age=0"},
                    )

        if path in ("/", ""):
            return self._redirect("/app/")

        return self._not_found()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        qs = parse_qs(parsed.query)
        try:
            payload = _read_json(self)
        except json.JSONDecodeError:
            return self._send(400, b'{"error":"invalid json"}', "application/json")

        # ---- MCP (partner API key) ----
        if path in ("/mcp", "/mcp/"):
            partner = partner_from_mcp_key(CONN, self._bearer())
            if not partner:
                return self._send(401, b'{"error":"invalid or revoked MCP key"}', "application/json")
            if not isinstance(payload, dict):
                return self._send(400, b'{"error":"JSON-RPC object required"}', "application/json")
            # batch support
            if isinstance(payload.get("method"), str) or "method" in payload:
                result = handle_mcp_rpc(CONN, partner, payload)
                status, body, ctype = _json_bytes(result)
                return self._send(status, body, ctype)
            return self._send(400, b'{"error":"JSON-RPC method required"}', "application/json")

        # ---- Partner auth ----
        if path == "/api/business":
            tenant_id = str(
                payload.get("tenantId") or payload.get("businessId") or (qs.get("tenant") or ["demo"])[0]
            ).strip()
            name = str(payload.get("name") or payload.get("businessName") or "").strip()
            if not tenant_id:
                return self._send(400, b'{"error":"tenantId required"}', "application/json")
            if not name:
                return self._send(400, b'{"error":"name required"}', "application/json")
            partner = self._partner_principal()
            if partner and not partner_can(CONN, partner["id"], tenant_id, "business.write"):
                return self._send(403, b'{"error":"forbidden - need admin/owner"}', "application/json")
            biz = set_tenant_name(CONN, tenant_id, name)
            status, body, ctype = _json_bytes({"ok": True, "business": biz})
            return self._send(status, body, ctype)

        if path == "/api/partner/invitations":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            if not isinstance(payload, dict):
                return self._send(400, b'{"error":"object required"}', "application/json")
            business_id = str(payload.get("businessId") or payload.get("tenantId") or "").strip()
            email = str(payload.get("email") or "").strip()
            role = str(payload.get("role") or "viewer").strip()
            if not business_id or not email:
                return self._send(400, b'{"error":"businessId and email required"}', "application/json")
            if not partner_can(CONN, partner["id"], business_id, "invite.create"):
                return self._send(403, b'{"error":"forbidden - need admin/owner to invite"}', "application/json")
            try:
                invited = create_invitation(
                    CONN,
                    business_id=business_id,
                    email=email,
                    role=role,
                    invited_by=partner["id"],
                )
            except ValueError as exc:
                return self._send(400, json.dumps({"error": str(exc)}).encode(), "application/json")
            status, body, ctype = _json_bytes(invited)
            return self._send(status, body, ctype)

        if path == "/api/partner/invitations/accept":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized - sign in first"}', "application/json")
            token = str((payload or {}).get("token") or "").strip()
            if not token:
                return self._send(400, b'{"error":"token required"}', "application/json")
            result = accept_invitation(
                CONN,
                token=token,
                partner_id=partner["id"],
                partner_email=partner.get("email") or "",
            )
            if not result:
                return self._send(
                    400,
                    b'{"error":"invalid, expired, or email mismatch for invite"}',
                    "application/json",
                )
            status, body, ctype = _json_bytes(result)
            return self._send(status, body, ctype)

        if path.startswith("/api/partner/invitations/") and path.endswith("/revoke"):
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            inv_id = path[len("/api/partner/invitations/") : -len("/revoke")]
            business_id = str((payload or {}).get("businessId") or "").strip()
            if not business_id:
                return self._send(400, b'{"error":"businessId required"}', "application/json")
            if not partner_can(CONN, partner["id"], business_id, "members.manage"):
                return self._send(403, b'{"error":"forbidden"}', "application/json")
            ok = revoke_invitation(CONN, inv_id, business_id)
            status, body, ctype = _json_bytes({"ok": ok})
            return self._send(status if ok else 404, body, ctype)

        if path == "/api/partner/members/role":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            business_id = str((payload or {}).get("businessId") or "").strip()
            target_id = str((payload or {}).get("partnerId") or "").strip()
            role = str((payload or {}).get("role") or "").strip()
            if not business_id or not target_id or not role:
                return self._send(400, b'{"error":"businessId, partnerId, role required"}', "application/json")
            if not partner_can(CONN, partner["id"], business_id, "members.manage"):
                return self._send(403, b'{"error":"forbidden"}', "application/json")
            updated = set_member_role(
                CONN, business_id=business_id, partner_id=target_id, role=role, actor_id=partner["id"]
            )
            if not updated:
                return self._send(400, b'{"error":"could not change role (last owner?)"}', "application/json")
            status, body, ctype = _json_bytes({"ok": True, "membership": updated})
            return self._send(status, body, ctype)

        if path == "/api/partner/members/revoke":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            business_id = str((payload or {}).get("businessId") or "").strip()
            target_id = str((payload or {}).get("partnerId") or "").strip()
            if not business_id or not target_id:
                return self._send(400, b'{"error":"businessId and partnerId required"}', "application/json")
            if not partner_can(CONN, partner["id"], business_id, "members.manage"):
                return self._send(403, b'{"error":"forbidden"}', "application/json")
            ok = revoke_membership(
                CONN, business_id=business_id, partner_id=target_id, actor_id=partner["id"]
            )
            if not ok:
                return self._send(400, b'{"error":"could not remove member (last owner?)"}', "application/json")
            status, body, ctype = _json_bytes({"ok": True})
            return self._send(status, body, ctype)

        if path == "/api/partner/businesses/unbind":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            from partners import unbind_business

            business_id = str((payload or {}).get("businessId") or (payload or {}).get("tenantId") or "").strip()
            if not business_id:
                return self._send(400, b'{"error":"businessId required"}', "application/json")
            if not partner_can(CONN, partner["id"], business_id, "business.write"):
                return self._send(403, b'{"error":"forbidden - need admin/owner"}', "application/json")
            ok = unbind_business(CONN, partner["id"], business_id)
            if not ok:
                return self._send(404, b'{"error":"business not linked"}', "application/json")
            status, body, ctype = _json_bytes({"ok": True, "businessId": business_id})
            return self._send(status, body, ctype)

        if path == "/api/partner/businesses":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            if not isinstance(payload, dict):
                return self._send(400, b'{"error":"object required"}', "application/json")
            from partners import new_business_id

            name = str(payload.get("name") or payload.get("businessName") or "").strip()
            raw_id = str(payload.get("businessId") or payload.get("id") or "").strip().lower()
            if not name:
                return self._send(400, b'{"error":"name required"}', "application/json")
            # Opaque biz_ ids by default. Optional slug only if it looks intentional (not Clerk-derived).
            if raw_id and not raw_id.startswith("clerk") and "@" not in raw_id and raw_id not in ("*", "all", "demo"):
                slug = re.sub(r"[^a-z0-9]+", "-", raw_id).strip("-")[:40]
                business_id = slug if slug.startswith("biz_") else f"biz_{slug}" if slug else new_business_id()
            else:
                business_id = new_business_id()
            if business_id in ("*", "all", "demo"):
                return self._send(400, b'{"error":"reserved business id"}', "application/json")
            set_tenant_name(CONN, business_id, name)
            bind_business(CONN, partner["id"], business_id, name)
            status, body, ctype = _json_bytes(
                {
                    "ok": True,
                    "business": {"business_id": business_id, "business_name": name},
                }
            )
            return self._send(status, body, ctype)

        if path == "/api/partner/login":
            if not isinstance(payload, dict):
                return self._send(400, b'{"error":"object required"}', "application/json")
            partner = authenticate_partner(
                CONN, str(payload.get("email") or ""), str(payload.get("password") or "")
            )
            if not partner:
                return self._send(401, b'{"error":"invalid credentials"}', "application/json")
            token = create_session(CONN, partner["id"])
            status, body, ctype = _json_bytes({"ok": True, "partner": partner})
            cookie = (
                f"glowops_partner={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={12 * 3600}"
            )
            return self._send(status, body, ctype, {"Set-Cookie": cookie})

        if path == "/api/partner/logout":
            revoke_session(CONN, self._cookie("glowops_partner"))
            status, body, ctype = _json_bytes({"ok": True})
            return self._send(
                status,
                body,
                ctype,
                {"Set-Cookie": "glowops_partner=; Path=/; HttpOnly; Max-Age=0"},
            )

        if path == "/api/partner/mcp-keys":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            # MCP mint is partner-scoped; require admin on at least one business or any membership
            businesses = list_partner_businesses(CONN, partner["id"])
            if businesses and not any(
                partner_can(CONN, partner["id"], b["business_id"], "settings.mcp") for b in businesses
            ):
                return self._send(403, b'{"error":"forbidden - need admin/owner for MCP keys"}', "application/json")
            label = "Default"
            if isinstance(payload, dict):
                label = str(payload.get("label") or "Default")
            minted = mint_mcp_key(CONN, partner["id"], label=label, scopes="read")
            status, body, ctype = _json_bytes(minted)
            return self._send(status, body, ctype)

        if path.startswith("/api/partner/mcp-keys/") and path.endswith("/revoke"):
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            key_id = path[len("/api/partner/mcp-keys/") : -len("/revoke")]
            ok = revoke_mcp_key(CONN, partner["id"], key_id)
            if not ok:
                return self._send(404, b'{"error":"key not found"}', "application/json")
            status, body, ctype = _json_bytes({"ok": True, "id": key_id})
            return self._send(status, body, ctype)

        if path == "/api/partner/enrollment-keys":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            if not isinstance(payload, dict):
                return self._send(400, b'{"error":"object required"}', "application/json")
            business_id = str(payload.get("businessId") or "").strip()
            if not business_id or not partner_can(CONN, partner["id"], business_id, "enroll.manage"):
                return self._send(403, b'{"error":"forbidden - need operator+ to enroll"}', "application/json")
            ttl = int(payload.get("ttlHours") or 24)
            label = str(payload.get("label") or "Device join")
            minted = mint_enrollment_key(
                CONN,
                partner_id=partner["id"],
                business_id=business_id,
                label=label,
                ttl_hours=ttl,
            )
            status, body, ctype = _json_bytes(minted)
            return self._send(status, body, ctype)

        if path.startswith("/api/partner/enrollment-keys/") and path.endswith("/revoke"):
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            key_id = path[len("/api/partner/enrollment-keys/") : -len("/revoke")]
            ok = revoke_enrollment_key(CONN, partner["id"], key_id)
            if not ok:
                return self._send(404, b'{"error":"key not found"}', "application/json")
            status, body, ctype = _json_bytes({"ok": True, "id": key_id})
            return self._send(status, body, ctype)

        if path == "/api/partner/deploy-kit":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            if not isinstance(payload, dict):
                return self._send(400, b'{"error":"object required"}', "application/json")
            business_id = str(payload.get("businessId") or "").strip()
            channel = str(payload.get("channel") or "").strip()
            if channel not in deploy_kits.CHANNELS:
                return self._send(400, b'{"error":"channel must be intune, rmm, or device"}', "application/json")
            if not business_id or not partner_can(CONN, partner["id"], business_id, "enroll.manage"):
                return self._send(403, b'{"error":"forbidden - need operator+ to deploy"}', "application/json")
            ttl = int(payload.get("ttlHours") or deploy_kits.DEFAULT_TTL_HOURS[channel])
            name = _business_name(partner["id"], business_id)
            who = partner.get("email") or partner.get("name") or partner["id"]
            minted = mint_enrollment_key(
                CONN,
                partner_id=partner["id"],
                business_id=business_id,
                label=f"{ {'intune': 'Intune', 'rmm': 'RMM', 'device': 'Device'}[channel] } package · {who}"[:64],
                ttl_hours=ttl,
            )
            base = f"GlowOps-{deploy_kits.slug(name)}"
            if channel == "intune":
                data, _ = deploy_kits.intune_bundle(minted, name)
                filename, ctype = f"{base}-Intune.zip", "application/zip"
            elif channel == "rmm":
                data = deploy_kits.rmm_script(minted, name)
                filename, ctype = f"{base}-RMM.ps1", "text/plain; charset=utf-8"
            else:
                data = deploy_kits.device_zip(minted, name)
                filename, ctype = f"{base}-Install.zip", "application/zip"
            _audit(partner["id"], business_id, "deploy.download",
                   {"channel": channel, "keyId": minted["id"], "expiresAt": minted["expiresAt"]})
            return self._send(
                200,
                data,
                ctype,
                {
                    "Content-Disposition": f'attachment; filename="{filename}"',
                    "Cache-Control": "no-store",
                    "X-GlowOps-Key-Id": minted["id"],
                    "X-GlowOps-Expires": minted["expiresAt"],
                    "Access-Control-Expose-Headers": "Content-Disposition, X-GlowOps-Key-Id, X-GlowOps-Expires",
                },
            )

        if path in ("/api/partner/intune/connect", "/api/partner/intune/complete", "/api/partner/intune/disconnect"):
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            if not isinstance(payload, dict):
                return self._send(400, b'{"error":"object required"}', "application/json")
            if not intune_graph.configured():
                return self._send(503, b'{"error":"Intune push is not set up on this host yet"}', "application/json")
            if path.endswith("/complete"):
                state = intune_graph.verify_state(str(payload.get("state") or ""))
                directory = str(payload.get("directoryId") or "").strip()
                if not state or state.get("p") != partner["id"]:
                    return self._send(403, b'{"error":"this consent link was started by someone else or expired"}', "application/json")
                if not re.fullmatch(r"[0-9a-fA-F-]{36}", directory):
                    return self._send(400, b'{"error":"Microsoft did not return a directory id"}', "application/json")
                business_id = state["b"]
            else:
                business_id = str(payload.get("businessId") or "").strip()
            if not business_id or not partner_can(CONN, partner["id"], business_id, "connections.manage"):
                return self._send(403, b'{"error":"forbidden - need admin or owner"}', "application/json")
            if path.endswith("/connect"):
                url = intune_graph.consent_url(
                    intune_graph.sign_state(partner["id"], business_id),
                    f"{_public_url()}/partner/intune/callback",
                )
                status, body, ctype = _json_bytes({"consentUrl": url})
                return self._send(status, body, ctype)
            if path.endswith("/complete"):
                intune_graph.save_connection(CONN, business_id, directory)
                _audit(partner["id"], business_id, "intune.connect", {"directoryId": directory})
                status, body, ctype = _json_bytes({"ok": True, "businessId": business_id})
                return self._send(status, body, ctype)
            intune_graph.clear_connection(CONN, business_id)
            _audit(partner["id"], business_id, "intune.disconnect", {})
            status, body, ctype = _json_bytes({"ok": True})
            return self._send(status, body, ctype)

        if path == "/api/partner/intune/deploy":
            partner = self._partner_principal()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            if not isinstance(payload, dict):
                return self._send(400, b'{"error":"object required"}', "application/json")
            business_id = str(payload.get("businessId") or "").strip()
            if not business_id or not partner_can(CONN, partner["id"], business_id, "enroll.manage"):
                return self._send(403, b'{"error":"forbidden - need operator+ to deploy"}', "application/json")
            if not intune_graph.configured():
                return self._send(503, b'{"error":"Intune push is not set up on this host yet"}', "application/json")
            connection = intune_graph.get_connection(CONN, business_id)
            if not connection:
                return self._send(409, b'{"error":"connect this business to Intune first"}', "application/json")
            assign = str(payload.get("assign") or "none")
            group_id = str(payload.get("groupId") or "").strip()
            if assign not in ("none", "all", "group"):
                return self._send(400, b'{"error":"assign must be none, all, or group"}', "application/json")
            if assign == "group" and not re.fullmatch(r"[0-9a-fA-F-]{36}", group_id):
                return self._send(400, b'{"error":"group id must be the Entra group object id"}', "application/json")
            name = _business_name(partner["id"], business_id)
            who = partner.get("email") or partner.get("name") or partner["id"]
            minted = mint_enrollment_key(
                CONN,
                partner_id=partner["id"],
                business_id=business_id,
                label=f"Intune push · {who}"[:64],
                ttl_hours=deploy_kits.DEFAULT_TTL_HOURS["intune"],
            )
            try:
                win = deploy_kits.build_intunewin(deploy_kits.payload_files(minted, name, "intune"))
                result = intune_graph.deploy_win32(
                    connection["directoryId"],
                    business_name=name,
                    win=win,
                    expires=minted["expiresAt"][:10],
                    assign=assign,
                    group_id=group_id,
                )
            except intune_graph.IntuneError as exc:
                revoke_enrollment_key(CONN, partner["id"], minted["id"])
                status, body, ctype = _json_bytes({"error": str(exc)}, 502)
                return self._send(502, body, ctype)
            _audit(partner["id"], business_id, "intune.deploy",
                   {"keyId": minted["id"], "appId": result["appId"], "assigned": result["assigned"]})
            status, body, ctype = _json_bytes({**result, "expiresAt": minted["expiresAt"], "keyId": minted["id"]})
            return self._send(status, body, ctype)

        if path == "/api/agent/join":
            # Validate join key+password without uploading devices (agent menu probe).
            if not isinstance(payload, dict):
                return self._send(400, b'{"error":"object required"}', "application/json")
            enrollment = verify_enrollment(
                CONN,
                join_key=str(payload.get("joinKey") or payload.get("key") or ""),
                join_password=str(payload.get("joinPassword") or payload.get("password") or ""),
                business_id=payload.get("businessId") or payload.get("tenantId"),
            )
            if not enrollment:
                return self._send(
                    401,
                    b'{"error":"invalid, revoked, or expired join key"}',
                    "application/json",
                )
            status, body_out, ctype = _json_bytes(
                {
                    "ok": True,
                    "businessId": enrollment["businessId"],
                    "expiresAt": enrollment["expiresAt"],
                    "scope": enrollment["scope"],
                    "label": enrollment["label"],
                }
            )
            return self._send(status, body_out, ctype)

        if path == "/api/ingest":
            if not isinstance(payload, dict):
                return self._send(400, b'{"error":"object required"}', "application/json")
            # Device join / refresh requires enrollment key+password.
            # Scheduled inventory may refresh after key expiry; revoked keys still fail closed.
            source = str(payload.get("source") or "api")
            enrollment = None
            if source.startswith("agent") or payload.get("joinKey") or payload.get("joinPassword"):
                refresh = str(payload.get("mode") or "").lower() in ("refresh", "inventory", "heartbeat")
                enrollment = verify_enrollment(
                    CONN,
                    join_key=str(payload.get("joinKey") or ""),
                    join_password=str(payload.get("joinPassword") or ""),
                    business_id=payload.get("tenantId") or payload.get("businessId"),
                    allow_expired_refresh=refresh or source in ("agent", "agent-refresh"),
                )
                if not enrollment:
                    return self._send(
                        401,
                        b'{"error":"join key required - invalid, revoked, or expired"}',
                        "application/json",
                    )
                tenant = enrollment["businessId"]
                source = "agent-refresh" if enrollment.get("refreshOnly") else "agent-join"
            else:
                # Dashboard paste only into a business this partner belongs to.
                # Anonymous callers may write the lab demo tenant only when that seed is on.
                partner = self._partner_principal()
                tenant = str(payload.get("tenantId") or payload.get("businessId") or "").strip()
                demo_on = os.environ.get("GLOWOPS_SEED_DEMO", "").strip() == "1"
                if tenant in ("*", "all"):
                    return self._send(400, b'{"error":"business id required"}', "application/json")
                if partner and partner.get("id") != "partner_demo":
                    if not tenant or tenant == "demo":
                        from partners import ensure_partner_home_business

                        tenant = ensure_partner_home_business(CONN, partner).get("business_id") or ""
                    if not tenant or not partner_can(CONN, partner["id"], tenant, "devices.write"):
                        return self._send(403, b'{"error":"business not assigned"}', "application/json")
                elif not (demo_on and (not tenant or tenant == "demo")):
                    return self._send(401, b'{"error":"unauthorized"}', "application/json")
                else:
                    tenant = "demo"
            body = payload.get("devices") or payload.get("value") or payload.get("managedDevices") or payload
            devices = map_managed_devices(body)
            if not devices and (payload.get("deviceName") or payload.get("serialNumber")):
                devices = map_managed_devices([payload])
            results = []
            for d in devices:
                results.append(upsert_device(CONN, str(tenant), d, source=str(source)))
            record_ingest(CONN, str(tenant), str(source), len(results))
            status, body_out, ctype = _json_bytes(
                {
                    "ok": True,
                    "tenantId": tenant,
                    "businessId": tenant,
                    "ingested": len(results),
                    "results": results,
                    "summary": fleet_summary(CONN, str(tenant)),
                    "enrollment": {"expiresAt": enrollment["expiresAt"]} if enrollment else None,
                }
            )
            return self._send(status, body_out, ctype)

        if path == "/api/agent/heartbeat":
            if not isinstance(payload, dict):
                return self._send(400, b'{"error":"object required"}', "application/json")
            enrollment = verify_enrollment(
                CONN,
                join_key=str(payload.get("joinKey") or ""),
                join_password=str(payload.get("joinPassword") or ""),
                business_id=payload.get("tenantId") or payload.get("businessId"),
                allow_expired_refresh=True,
            )
            if not enrollment:
                return self._send(
                    401,
                    b'{"error":"join key required - invalid, revoked, or expired"}',
                    "application/json",
                )
            payload = {**payload, "tenantId": enrollment["businessId"]}
            record_heartbeat(CONN, payload)
            devices = map_managed_devices(payload.get("devices") or [])
            tenant = enrollment["businessId"]
            for d in devices:
                upsert_device(CONN, str(tenant), d, source="agent")
            if devices:
                record_ingest(CONN, str(tenant), "agent", len(devices))
            status, body_out, ctype = _json_bytes(
                {
                    "ok": True,
                    "received": True,
                    "devices": len(devices),
                    "businessId": tenant,
                    "expiresAt": enrollment["expiresAt"],
                }
            )
            return self._send(status, body_out, ctype)

        if path == "/api/score":
            from score import decide_device

            device = payload if isinstance(payload, dict) else {}
            if "device" in device:
                device = device["device"]
            status, body_out, ctype = _json_bytes({"decision": decide_device(device)})
            return self._send(status, body_out, ctype)

        return self._send(404, b'{"error":"not found"}', "application/json")


def main() -> None:
    print(f"GlowOps dashboard  http://127.0.0.1:{PORT}/app/")
    print(f"  Partner MCP UI   http://127.0.0.1:{PORT}/partner/")
    print(f"  MCP endpoint     http://127.0.0.1:{PORT}/mcp")
    if DEMO_PARTNER and DEMO_PARTNER.get("bootstrapKey"):
        print(f"  Demo partner     partner@getglowop.com / GlowOps-Partner-2026!")
        print(f"  Bootstrap key    {DEMO_PARTNER['bootstrapKey']['apiKey']}")
    else:
        print("  Demo seed        off (set GLOWOPS_SEED_DEMO=1 for lab sample fleet)")
    print("  Database         Supabase (DATABASE_URL)")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
