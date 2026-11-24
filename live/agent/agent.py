#!/usr/bin/env python3
"""GlowOps downloadable agent — heartbeat + inventory push (stdlib)."""
from __future__ import annotations

import argparse
import json
import os
import platform
import socket
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

VERSION = "0.1.0"
DEFAULT_URL = os.environ.get("GLOWOPS_URL", "http://127.0.0.1:8787").rstrip("/")
DEFAULT_TENANT = os.environ.get("GLOWOPS_TENANT", "demo")
AGENT_ID = os.environ.get("GLOWOPS_AGENT_ID") or f"{socket.gethostname()}-{platform.system()}"


def _post(url: str, payload: dict) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": f"GlowOpsAgent/{VERSION}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def cmd_heartbeat(args: argparse.Namespace) -> int:
    payload = {
        "agentId": AGENT_ID,
        "hostname": socket.gethostname(),
        "tenantId": args.tenant,
        "version": VERSION,
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "sentAt": datetime.now(timezone.utc).isoformat(),
    }
    if args.file:
        devices = _load_devices(args.file)
        payload["devices"] = devices
    try:
        result = _post(f"{args.url}/api/agent/heartbeat", payload)
    except urllib.error.URLError as exc:
        print(f"ERROR: could not reach {args.url}: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


def _load_devices(path: str) -> list:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        return raw.get("value") or raw.get("devices") or raw.get("managedDevices") or [raw]
    return []


def cmd_inventory(args: argparse.Namespace) -> int:
    devices = _load_devices(args.file)
    payload = {
        "tenantId": args.tenant,
        "source": "agent-inventory",
        "devices": devices,
    }
    try:
        result = _post(f"{args.url}/api/ingest", payload)
    except urllib.error.URLError as exc:
        print(f"ERROR: could not reach {args.url}: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"ingested": result.get("ingested"), "summary": result.get("summary")}, indent=2))
    return 0


def cmd_sample(args: argparse.Namespace) -> int:
    """Emit a tiny Graph-shaped sample for testing."""
    sample = {
        "value": [
            {
                "id": "agent-sample-1",
                "deviceName": socket.gethostname(),
                "manufacturer": platform.system(),
                "model": platform.machine(),
                "serialNumber": AGENT_ID[:16],
                "operatingSystem": platform.system(),
                "osVersion": platform.release(),
                "complianceState": "compliant",
                "enrolledDateTime": "2024-01-15T00:00:00Z",
                "lastSyncDateTime": datetime.now(timezone.utc).isoformat(),
                "userPrincipalName": os.environ.get("USERNAME") or os.environ.get("USER"),
            }
        ]
    }
    out = Path(args.out) if args.out else Path("sample-devices.json")
    out.write_text(json.dumps(sample, indent=2), encoding="utf-8")
    print(f"Wrote {out}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="GlowOps agent")
    p.add_argument("--url", default=DEFAULT_URL, help="Dashboard base URL")
    p.add_argument("--tenant", default=DEFAULT_TENANT, help="Tenant id")
    sub = p.add_subparsers(dest="cmd", required=True)

    hb = sub.add_parser("heartbeat", help="Send heartbeat (optional --file devices)")
    hb.add_argument("--url", default=DEFAULT_URL, help="Dashboard base URL")
    hb.add_argument("--tenant", default=DEFAULT_TENANT, help="Tenant id")
    hb.add_argument("--file", help="Optional Graph/JSON devices to attach")
    hb.set_defaults(func=cmd_heartbeat)

    inv = sub.add_parser("inventory", help="Push inventory JSON to /api/ingest")
    inv.add_argument("--url", default=DEFAULT_URL, help="Dashboard base URL")
    inv.add_argument("--tenant", default=DEFAULT_TENANT, help="Tenant id")
    inv.add_argument("--file", required=True, help="Path to devices JSON")
    inv.set_defaults(func=cmd_inventory)

    samp = sub.add_parser("sample", help="Write a sample devices JSON from this host")
    samp.add_argument("--out", default="sample-devices.json")
    samp.set_defaults(func=cmd_sample)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
