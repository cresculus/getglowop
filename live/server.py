#!/usr/bin/env python3
"""GlowOps live dashboard — stdlib HTTP + SQLite. No login for local / early demo.

Serves:
  /app/              live dashboard UI
  /api/*             JSON API
  /download/agent.zip
  /*                 optional marketing site (GLOWOPS_MARKETING_ROOT or sibling getglowop files)
"""
from __future__ import annotations

import csv
import io
import json
import os
import sys
import zipfile
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
    # getglowop layout: live/ next to marketing html
    MARKETING_ROOT = ROOT.parent
elif (ROOT / "index.html").is_file() and ROOT.name != "static":
    MARKETING_ROOT = ROOT
else:
    MARKETING_ROOT = None

CONN = connect(DB_PATH)
seed_if_empty(CONN, "demo")


def _json_bytes(obj: object, status: int = 200) -> tuple[int, bytes, str]:
    return status, json.dumps(obj, default=str).encode("utf-8"), "application/json; charset=utf-8"


def _read_json(handler: BaseHTTPRequestHandler) -> object:
    length = int(handler.headers.get("Content-Length") or 0)
    raw = handler.rfile.read(length) if length else b"{}"
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


AGENT_EXE_NAME = "GlowOpsAgent.exe"
AGENT_RELEASE_URL = os.environ.get(
    "GLOWOPS_AGENT_RELEASE_URL",
    "https://github.com/cresculus/getglowop/releases/latest/download/GlowOpsAgent.exe",
)


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
        # Keep optional Python helper for labs; EXE is the published agent.
        py = AGENT_DIR / "agent.py"
        if py.is_file():
            zf.write(py, arcname="glowops-agent/agent.py")
        zf.writestr(
            "glowops-agent/README.txt",
            "GlowOps Agent (Windows)\n"
            "=======================\n"
            "1. Edit glowops.agent.json (url + tenantId) next to the EXE\n"
            "2. Double-click GlowOpsAgent.exe  (run = heartbeat + this host)\n"
            "   Or: GlowOpsAgent.exe inventory --file devices.json\n"
            "3. Graph/Intune JSON uses the same shape as managedDevices value[]\n"
            f"\nDirect EXE: /download/{AGENT_EXE_NAME}\n",
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
    server_version = "GlowOps/0.1"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

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
        body = b""
        self.send_response(status)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

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
                {"ok": True, "service": "glowops", "auth": "none", "app": "/app/"}
            )
            return self._send(status, body, ctype)

        if path.rstrip("/") == "/api/summary":
            status, body, ctype = _json_bytes(fleet_summary(CONN, tenant))
            return self._send(status, body, ctype)

        if path.rstrip("/") == "/api/devices":
            rows = list_devices(CONN, tenant)
            status, body, ctype = _json_bytes({"tenantId": tenant, "devices": rows, "count": len(rows)})
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
            # Prefer zip that includes EXE when present; otherwise redirect to release EXE.
            if _agent_exe_path() is None and not (AGENT_DIR / "agent.py").is_file():
                return self._redirect(AGENT_RELEASE_URL)
            data = _agent_zip()
            return self._send(
                200,
                data,
                "application/zip",
                {"Content-Disposition": 'attachment; filename="glowops-agent.zip"'},
            )

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

        # Convenience aliases
        if path.rstrip("/") in ("/live", "/dashboard-live"):
            return self._redirect("/app/")

        # Marketing site (getglowop) or fall through to app
        if MARKETING_ROOT:
            rel = path.lstrip("/") or "index.html"
            if path.endswith("/") and path != "/":
                rel = path.strip("/") + "/index.html"
            f = _safe_file(MARKETING_ROOT, rel)
            # never serve live/ python sources as static accidentally for dirs we care about
            if f and "live" not in Path(rel).parts[:1]:
                return self._send(200, f.read_bytes(), _content_type(f))
            if path == "/" or path == "":
                index = MARKETING_ROOT / "index.html"
                if index.is_file():
                    return self._send(200, index.read_bytes(), _content_type(index))

        # Local-only: no marketing → send people to the app
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

        if path == "/api/ingest":
            tenant = (
                (payload.get("tenantId") if isinstance(payload, dict) else None)
                or (qs.get("tenant") or ["demo"])[0]
            )
            source = (payload.get("source") if isinstance(payload, dict) else None) or "api"
            body = payload
            if isinstance(payload, dict):
                body = payload.get("devices") or payload.get("value") or payload.get("managedDevices") or payload
            devices = map_managed_devices(body)
            if not devices and isinstance(payload, dict) and (
                payload.get("deviceName") or payload.get("serialNumber")
            ):
                devices = map_managed_devices([payload])
            results = []
            for d in devices:
                results.append(upsert_device(CONN, str(tenant), d, source=str(source)))
            record_ingest(CONN, str(tenant), str(source), len(results))
            status, body_out, ctype = _json_bytes(
                {
                    "ok": True,
                    "tenantId": tenant,
                    "ingested": len(results),
                    "results": results,
                    "summary": fleet_summary(CONN, str(tenant)),
                }
            )
            return self._send(status, body_out, ctype)

        if path == "/api/agent/heartbeat":
            if not isinstance(payload, dict):
                return self._send(400, b'{"error":"object required"}', "application/json")
            record_heartbeat(CONN, payload)
            devices = map_managed_devices(payload.get("devices") or [])
            tenant = payload.get("tenantId") or "demo"
            for d in devices:
                upsert_device(CONN, str(tenant), d, source="agent")
            if devices:
                record_ingest(CONN, str(tenant), "agent", len(devices))
            status, body_out, ctype = _json_bytes({"ok": True, "received": True, "devices": len(devices)})
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
    print(f"  API summary      http://127.0.0.1:{PORT}/api/summary?tenant=demo")
    print(f"  Agent download   http://127.0.0.1:{PORT}/download/agent.zip")
    print(f"  SQLite           {DB_PATH}")
    print(f"  Marketing root   {MARKETING_ROOT or '(none — / redirects to /app/)'}")
    print("  Auth             none (demo mode)")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
