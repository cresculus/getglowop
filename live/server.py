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
import sys
import zipfile
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from db import (  # noqa: E402
    connect,
    fleet_summary,
    list_devices,
    record_heartbeat,
    record_ingest,
    seed_if_empty,
    upsert_device,
)
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
    create_session,
    list_mcp_keys,
    list_partner_businesses,
    mint_mcp_key,
    partner_from_mcp_key,
    partner_from_session,
    partner_may_access,
    revoke_mcp_key,
    revoke_session,
    seed_demo_partner,
)

DATA_DIR = Path(os.environ.get("GLOWOPS_DATA", str(ROOT / "data")))
DB_PATH = DATA_DIR / "glowops.db"
STATIC_DIR = ROOT / "static"
AGENT_DIR = ROOT / "agent"
HOST = os.environ.get("GLOWOPS_HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT") or os.environ.get("GLOWOPS_PORT") or "8787")

_marketing_env = os.environ.get("GLOWOPS_MARKETING_ROOT")
if _marketing_env:
    MARKETING_ROOT = Path(_marketing_env).resolve()
elif (ROOT.parent / "index.html").is_file() and (ROOT.parent / "dashboard.html").is_file():
    MARKETING_ROOT = ROOT.parent
elif (ROOT / "index.html").is_file() and ROOT.name != "static":
    MARKETING_ROOT = ROOT
else:
    MARKETING_ROOT = None

CONN = connect(DB_PATH)
seed_if_empty(CONN, "demo")
DEMO_PARTNER = seed_demo_partner(CONN)

AGENT_EXE_NAME = "GlowOpsAgent.exe"
AGENT_RELEASE_URL = os.environ.get(
    "GLOWOPS_AGENT_RELEASE_URL",
    "https://github.com/cresculus/getglowop/releases/latest/download/GlowOpsAgent.exe",
)


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
        zf.writestr(
            "glowops-agent/README.txt",
            "GlowOps Agent (Windows)\n"
            "1. Edit glowops.agent.json (url + tenantId)\n"
            "2. Double-click GlowOpsAgent.exe\n"
            f"Direct EXE: /download/{AGENT_EXE_NAME}\n"
            "Partner MCP: /partner/  (mint gow_mcp_ keys)\n",
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

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        tenant = (qs.get("tenant") or ["demo"])[0]

        if path.rstrip("/") in ("/api/health", "/health"):
            status, body, ctype = _json_bytes(
                {
                    "ok": True,
                    "service": "glowops",
                    "app": "/app/",
                    "partner": "/partner/",
                    "mcp": "/mcp",
                    "fleetAuth": "none-demo",
                    "partnerAuth": "session+mcp-key",
                }
            )
            return self._send(status, body, ctype)

        if path.rstrip("/") == "/api/summary":
            status, body, ctype = _json_bytes(fleet_summary(CONN, tenant))
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

        # Partner session APIs
        if path.rstrip("/") == "/api/partner/me":
            partner = self._session_partner()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            status, body, ctype = _json_bytes({"partner": partner})
            return self._send(status, body, ctype)

        if path.rstrip("/") == "/api/partner/businesses":
            partner = self._session_partner()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            status, body, ctype = _json_bytes(
                {"businesses": list_partner_businesses(CONN, partner["id"])}
            )
            return self._send(status, body, ctype)

        if path.rstrip("/") == "/api/partner/mcp-keys":
            partner = self._session_partner()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            status, body, ctype = _json_bytes({"keys": list_mcp_keys(CONN, partner["id"])})
            return self._send(status, body, ctype)

        if path.rstrip("/") == "/api/partner/enrollment-keys":
            partner = self._session_partner()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            status, body, ctype = _json_bytes({"keys": list_enrollment_keys(CONN, partner["id"])})
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

        # Partner console
        if path.rstrip("/") in ("/partner", "/partner/"):
            f = STATIC_DIR / "partner.html"
            return self._send(200, f.read_bytes(), _content_type(f))

        # Live app static under /app/
        if path == "/app" or path == "/app/":
            f = STATIC_DIR / "index.html"
            return self._send(200, f.read_bytes(), _content_type(f))
        if path.startswith("/app/"):
            rel = path[len("/app/") :]
            if not rel or rel.endswith("/"):
                rel = "index.html"
            f = _safe_file(STATIC_DIR, rel)
            if f:
                return self._send(200, f.read_bytes(), _content_type(f))
            return self._send(404, b'{"error":"not found"}', "application/json")

        if path.rstrip("/") in ("/live", "/dashboard-live"):
            return self._redirect("/app/")

        if MARKETING_ROOT:
            rel = path.lstrip("/") or "index.html"
            if path.endswith("/") and path != "/":
                rel = path.strip("/") + "/index.html"
            f = _safe_file(MARKETING_ROOT, rel)
            if f and "live" not in Path(rel).parts[:1]:
                return self._send(200, f.read_bytes(), _content_type(f))
            if path == "/" or path == "":
                index = MARKETING_ROOT / "index.html"
                if index.is_file():
                    return self._send(200, index.read_bytes(), _content_type(index))

        if path in ("/", ""):
            return self._redirect("/app/")

        return self._send(404, b'{"error":"not found"}', "application/json")

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
            partner = self._session_partner()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            label = "Default"
            if isinstance(payload, dict):
                label = str(payload.get("label") or "Default")
            minted = mint_mcp_key(CONN, partner["id"], label=label, scopes="read")
            status, body, ctype = _json_bytes(minted)
            return self._send(status, body, ctype)

        if path.startswith("/api/partner/mcp-keys/") and path.endswith("/revoke"):
            partner = self._session_partner()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            key_id = path[len("/api/partner/mcp-keys/") : -len("/revoke")]
            ok = revoke_mcp_key(CONN, partner["id"], key_id)
            if not ok:
                return self._send(404, b'{"error":"key not found"}', "application/json")
            status, body, ctype = _json_bytes({"ok": True, "id": key_id})
            return self._send(status, body, ctype)

        if path == "/api/partner/enrollment-keys":
            partner = self._session_partner()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            if not isinstance(payload, dict):
                return self._send(400, b'{"error":"object required"}', "application/json")
            business_id = str(payload.get("businessId") or "").strip()
            if not business_id or not partner_may_access(CONN, partner["id"], business_id):
                return self._send(403, b'{"error":"business not assigned to partner"}', "application/json")
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
            partner = self._session_partner()
            if not partner:
                return self._send(401, b'{"error":"unauthorized"}', "application/json")
            key_id = path[len("/api/partner/enrollment-keys/") : -len("/revoke")]
            ok = revoke_enrollment_key(CONN, partner["id"], key_id)
            if not ok:
                return self._send(404, b'{"error":"key not found"}', "application/json")
            status, body, ctype = _json_bytes({"ok": True, "id": key_id})
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
            # Device join path requires enrollment key+password (fail closed after expiry).
            source = str(payload.get("source") or "api")
            enrollment = None
            if source.startswith("agent") or payload.get("joinKey") or payload.get("joinPassword"):
                enrollment = verify_enrollment(
                    CONN,
                    join_key=str(payload.get("joinKey") or ""),
                    join_password=str(payload.get("joinPassword") or ""),
                    business_id=payload.get("tenantId") or payload.get("businessId"),
                )
                if not enrollment:
                    return self._send(
                        401,
                        b'{"error":"join key required - invalid, revoked, or expired"}',
                        "application/json",
                    )
                tenant = enrollment["businessId"]
                source = "agent-join"
            else:
                # Dashboard paste / lab ingest (partner session or open demo tenant)
                partner = self._session_partner()
                tenant = str(payload.get("tenantId") or payload.get("businessId") or (qs.get("tenant") or ["demo"])[0])
                if partner and not partner_may_access(CONN, partner["id"], tenant):
                    return self._send(403, b'{"error":"business not assigned"}', "application/json")
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
    print(f"  Demo partner     partner@getglowop.com / GlowOps-Partner-2026!")
    if DEMO_PARTNER.get("bootstrapKey"):
        print(f"  Bootstrap key    {DEMO_PARTNER['bootstrapKey']['apiKey']}")
    print(f"  SQLite           {DB_PATH}")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
