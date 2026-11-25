"""SQLite inventory for GlowOps live dashboard."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from score import decide_device

SCHEMA = """
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  device_name TEXT,
  manufacturer TEXT,
  model TEXT,
  serial_number TEXT,
  operating_system TEXT,
  os_version TEXT,
  compliance_state TEXT,
  enrolled_at TEXT,
  last_sync_at TEXT,
  battery_health REAL,
  warranty_end TEXT,
  user_upn TEXT,
  persona TEXT,
  device_class TEXT,
  health_notes TEXT,
  azure_device_id TEXT,
  intune_device_id TEXT,
  raw_json TEXT,
  call_label TEXT,
  glow_score INTEGER,
  rationale TEXT,
  age_years REAL,
  check_in_days INTEGER,
  mfg_kg REAL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_devices_tenant ON devices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_devices_call ON devices(call_label);
CREATE INDEX IF NOT EXISTS idx_devices_glow ON devices(glow_score);

CREATE TABLE IF NOT EXISTS ingest_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  hostname TEXT,
  tenant_id TEXT,
  version TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
"""


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def ensure_tenant(conn: sqlite3.Connection, tenant_id: str, name: str | None = None) -> None:
    now = datetime.now(timezone.utc).isoformat()
    # Insert only — never reset an existing display name to the opaque id.
    conn.execute(
        "INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)",
        (tenant_id, (name or "").strip() or tenant_id, now),
    )
    clean = (name or "").strip()
    if clean and clean != tenant_id:
        conn.execute("UPDATE tenants SET name = ? WHERE id = ?", (clean, tenant_id))
    conn.commit()


def get_tenant(conn: sqlite3.Connection, tenant_id: str) -> dict[str, Any]:
    ensure_tenant(conn, tenant_id)
    row = conn.execute(
        "SELECT id, name, created_at FROM tenants WHERE id = ?",
        (tenant_id,),
    ).fetchone()
    if not row:
        return {"id": tenant_id, "name": tenant_id, "created_at": None}
    return {"id": row["id"], "name": row["name"] or row["id"], "created_at": row["created_at"]}


def set_tenant_name(conn: sqlite3.Connection, tenant_id: str, name: str) -> dict[str, Any]:
    clean = (name or "").strip() or tenant_id
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET name = excluded.name",
        (tenant_id, clean, now),
    )
    try:
        conn.execute(
            "UPDATE partner_businesses SET business_name = ? WHERE business_id = ?",
            (clean, tenant_id),
        )
    except sqlite3.Error:
        pass
    conn.commit()
    return get_tenant(conn, tenant_id)


def _device_input(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "deviceName": row.get("deviceName") or row.get("device_name"),
        "manufacturer": row.get("manufacturer"),
        "model": row.get("model"),
        "serialNumber": row.get("serialNumber") or row.get("serial_number"),
        "operatingSystem": row.get("operatingSystem") or row.get("operating_system"),
        "osVersion": row.get("osVersion") or row.get("os_version"),
        "complianceState": row.get("complianceState") or row.get("compliance_state"),
        "enrolledDateTime": row.get("enrolledDateTime") or row.get("enrolled_at"),
        "lastSyncDateTime": row.get("lastSyncDateTime") or row.get("last_sync_at"),
        "batteryHealthPercent": row.get("batteryHealthPercent") if row.get("batteryHealthPercent") is not None else row.get("battery_health"),
        "warrantyEndDate": row.get("warrantyEndDate") or row.get("warranty_end"),
        "userPrincipalName": row.get("userPrincipalName") or row.get("user_upn"),
        "persona": row.get("persona"),
        "deviceClass": row.get("deviceClass") or row.get("device_class"),
        "healthNotes": row.get("healthNotes") or row.get("health_notes"),
    }


def upsert_device(conn: sqlite3.Connection, tenant_id: str, device: dict[str, Any], source: str = "manual") -> dict[str, Any]:
    ensure_tenant(conn, tenant_id)
    inp = _device_input(device)
    decision = decide_device(inp)
    now = datetime.now(timezone.utc).isoformat()
    device_id = (
        device.get("id")
        or device.get("intuneDeviceId")
        or device.get("azureDeviceId")
        or device.get("serialNumber")
        or device.get("serial_number")
        or f"dev-{hash(json.dumps(inp, sort_keys=True)) & 0xFFFFFFFF:08x}"
    )
    conn.execute(
        """
        INSERT INTO devices (
          id, tenant_id, source, device_name, manufacturer, model, serial_number,
          operating_system, os_version, compliance_state, enrolled_at, last_sync_at,
          battery_health, warranty_end, user_upn, persona, device_class, health_notes,
          azure_device_id, intune_device_id, raw_json, call_label, glow_score, rationale,
          age_years, check_in_days, mfg_kg, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          tenant_id=excluded.tenant_id,
          source=excluded.source,
          device_name=excluded.device_name,
          manufacturer=excluded.manufacturer,
          model=excluded.model,
          serial_number=excluded.serial_number,
          operating_system=excluded.operating_system,
          os_version=excluded.os_version,
          compliance_state=excluded.compliance_state,
          enrolled_at=excluded.enrolled_at,
          last_sync_at=excluded.last_sync_at,
          battery_health=excluded.battery_health,
          warranty_end=excluded.warranty_end,
          user_upn=excluded.user_upn,
          persona=excluded.persona,
          device_class=excluded.device_class,
          health_notes=excluded.health_notes,
          azure_device_id=excluded.azure_device_id,
          intune_device_id=excluded.intune_device_id,
          raw_json=excluded.raw_json,
          call_label=excluded.call_label,
          glow_score=excluded.glow_score,
          rationale=excluded.rationale,
          age_years=excluded.age_years,
          check_in_days=excluded.check_in_days,
          mfg_kg=excluded.mfg_kg,
          updated_at=excluded.updated_at
        """,
        (
            str(device_id),
            tenant_id,
            source,
            inp.get("deviceName"),
            inp.get("manufacturer"),
            inp.get("model"),
            inp.get("serialNumber"),
            inp.get("operatingSystem"),
            inp.get("osVersion"),
            inp.get("complianceState"),
            inp.get("enrolledDateTime"),
            inp.get("lastSyncDateTime"),
            inp.get("batteryHealthPercent"),
            inp.get("warrantyEndDate"),
            inp.get("userPrincipalName"),
            inp.get("persona"),
            inp.get("deviceClass"),
            inp.get("healthNotes"),
            device.get("azureDeviceId") or device.get("azure_device_id"),
            device.get("intuneDeviceId") or device.get("intune_device_id") or device.get("id"),
            json.dumps(device),
            decision["call"],
            decision["glowScore"],
            decision["rationale"],
            decision["ageYears"],
            decision["checkInDaysAgo"],
            decision["factor"]["manufacturingKgCo2e"],
            now,
        ),
    )
    conn.commit()
    return {"id": str(device_id), "decision": decision}


def list_devices(conn: sqlite3.Connection, tenant_id: str | None = None) -> list[dict[str, Any]]:
    if tenant_id:
        rows = conn.execute("SELECT * FROM devices WHERE tenant_id = ? ORDER BY glow_score ASC, device_name", (tenant_id,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM devices ORDER BY glow_score ASC, device_name").fetchall()
    items = [dict(r) for r in rows]
    return _prefer_rich_rows(items)


def _prefer_rich_rows(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """When multiple rows share a hostname, keep the richest inventory (real collector over stubs)."""
    best: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for row in items:
        key = (row.get("device_name") or row.get("serial_number") or row.get("id") or "").strip().lower()
        if not key:
            key = str(row.get("id"))
        score = _richness(row)
        prev = best.get(key)
        if prev is None:
            best[key] = row
            order.append(key)
        elif score > _richness(prev):
            best[key] = row
    return [best[k] for k in order]


def _richness(row: dict[str, Any]) -> int:
    raw = row.get("raw_json") or ""
    score = len(raw) if isinstance(raw, str) else 0
    if row.get("battery_health") is not None:
        score += 50
    if row.get("health_notes"):
        score += 20
    mfr = (row.get("manufacturer") or "").lower()
    if mfr and mfr not in ("windows", "glowopsagent", "unknown"):
        score += 100
    if "glowopsInventory" in raw or '"storage"' in raw or '"volumes"' in raw:
        score += 500
    if row.get("source") in ("collector", "agent-join", "lab-collector"):
        score += 200
    return score


def fleet_summary(conn: sqlite3.Connection, tenant_id: str | None = None) -> dict[str, Any]:
    devices = list_devices(conn, tenant_id)
    by_call = {"keep": 0, "repair": 0, "redeploy": 0, "refresh": 0, "recycle": 0, "ghost": 0}
    mfg = 0.0
    avoidable = 0
    glow_sum = 0
    for d in devices:
        call = d.get("call_label") or "keep"
        by_call[call] = by_call.get(call, 0) + 1
        mfg += float(d.get("mfg_kg") or 0)
        glow_sum += int(d.get("glow_score") or 0)
        age = d.get("age_years")
        if age is not None and float(age) >= 3 and call in ("keep", "repair"):
            avoidable += 1
    count = len(devices)
    biz = get_tenant(conn, tenant_id) if tenant_id else {"id": None, "name": None}
    return {
        "deviceCount": count,
        "byCall": by_call,
        "manufacturingKgOnBooks": round(mfg),
        "avoidablePurchasesIfExtended": avoidable,
        "ghostCount": by_call.get("ghost", 0),
        "repairBeforeReplaceCount": by_call.get("repair", 0),
        "avgGlowScore": round(glow_sum / count) if count else None,
        "tenantId": tenant_id,
        "businessId": tenant_id,
        "businessName": biz.get("name"),
    }


def record_ingest(conn: sqlite3.Connection, tenant_id: str, source: str, count: int) -> None:
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO ingest_events (tenant_id, source, payload_count, created_at) VALUES (?,?,?,?)",
        (tenant_id, source, count, now),
    )
    conn.commit()


def record_heartbeat(conn: sqlite3.Connection, payload: dict[str, Any]) -> None:
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO agent_heartbeats (agent_id, hostname, tenant_id, version, payload_json, created_at) VALUES (?,?,?,?,?,?)",
        (
            payload.get("agentId") or payload.get("agent_id") or "unknown",
            payload.get("hostname"),
            payload.get("tenantId") or payload.get("tenant_id"),
            payload.get("version"),
            json.dumps(payload),
            now,
        ),
    )
    conn.commit()


SAMPLE_DEVICES = [
    {
        "id": "sample-ghost-1",
        "deviceName": "LAPTOP-GHOST-01",
        "manufacturer": "Dell",
        "model": "Latitude 5420",
        "serialNumber": "GHST001",
        "complianceState": "unknown",
        "enrolledDateTime": "2021-03-15T00:00:00Z",
        "lastSyncDateTime": "2025-06-01T00:00:00Z",
        "batteryHealthPercent": 62,
        "persona": "knowledge",
        "healthNotes": "",
    },
    {
        "id": "sample-keep-1",
        "deviceName": "LAPTOP-KEEP-01",
        "manufacturer": "Lenovo",
        "model": "ThinkPad T14",
        "serialNumber": "KEEP001",
        "complianceState": "compliant",
        "enrolledDateTime": "2023-09-01T00:00:00Z",
        "lastSyncDateTime": "2026-11-20T00:00:00Z",
        "batteryHealthPercent": 88,
        "persona": "knowledge",
    },
    {
        "id": "sample-repair-1",
        "deviceName": "LAPTOP-BATT-01",
        "manufacturer": "HP",
        "model": "EliteBook 840",
        "serialNumber": "BATT001",
        "complianceState": "compliant",
        "enrolledDateTime": "2022-01-10T00:00:00Z",
        "lastSyncDateTime": "2026-11-22T00:00:00Z",
        "batteryHealthPercent": 54,
        "persona": "finance",
    },
    {
        "id": "sample-refresh-1",
        "deviceName": "DESK-OLD-01",
        "manufacturer": "Dell",
        "model": "OptiPlex 7070",
        "serialNumber": "OLD001",
        "complianceState": "noncompliant",
        "enrolledDateTime": "2019-05-01T00:00:00Z",
        "lastSyncDateTime": "2026-11-18T00:00:00Z",
        "batteryHealthPercent": None,
        "persona": "default",
        "deviceClass": "desktop",
        "healthNotes": "Windows 10 EOL block — cannot take baseline",
    },
    {
        "id": "sample-redeploy-1",
        "deviceName": "LAPTOP-DISK-01",
        "manufacturer": "Dell",
        "model": "Latitude 5520",
        "serialNumber": "DISK001",
        "complianceState": "compliant",
        "enrolledDateTime": "2022-06-01T00:00:00Z",
        "lastSyncDateTime": "2026-11-21T00:00:00Z",
        "batteryHealthPercent": 78,
        "persona": "clinical",
        "healthNotes": "SSD predictive failure",
    },
]


def seed_if_empty(conn: sqlite3.Connection, tenant_id: str = "demo") -> int:
    n = conn.execute("SELECT COUNT(*) AS c FROM devices").fetchone()["c"]
    if n > 0:
        return 0
    ensure_tenant(conn, tenant_id, "Demo fleet")
    for d in SAMPLE_DEVICES:
        upsert_device(conn, tenant_id, d, source="seed")
    record_ingest(conn, tenant_id, "seed", len(SAMPLE_DEVICES))
    return len(SAMPLE_DEVICES)
