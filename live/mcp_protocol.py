"""GlowOps MCP JSON-RPC surface (HTTP). Auth = partner MCP API key; data scoped to partner businesses."""
from __future__ import annotations

import json
import sqlite3
from typing import Any, Callable

from db import fleet_summary, list_devices
from partners import list_partner_businesses, partner_may_access
from score import decide_device

TOOLS: list[dict[str, Any]] = [
    {
        "name": "glowops_list_businesses",
        "description": "List customer businesses this partner MCP key can access. Never returns other partners' tenants.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "glowops_fleet_summary",
        "description": "GLOW Op Report summary KPIs for one business (device counts by call, ghosts, mfg kg, avg score).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "businessId": {"type": "string", "description": "Customer business / tenant id"},
            },
            "required": ["businessId"],
            "additionalProperties": False,
        },
    },
    {
        "name": "glowops_list_devices",
        "description": "List scored devices for one business. Optional filter by lifecycle call.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "businessId": {"type": "string"},
                "call": {
                    "type": "string",
                    "enum": ["keep", "repair", "redeploy", "refresh", "recycle", "ghost"],
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 500},
            },
            "required": ["businessId"],
            "additionalProperties": False,
        },
    },
    {
        "name": "glowops_get_device",
        "description": "Get one device row by id or serial within an allowed business.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "businessId": {"type": "string"},
                "deviceId": {"type": "string"},
                "serialNumber": {"type": "string"},
            },
            "required": ["businessId"],
            "additionalProperties": False,
        },
    },
    {
        "name": "glowops_score_device",
        "description": "Score a hypothetical or pasted device object with GlowOps lifecycle rules (no persist).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "device": {"type": "object", "description": "Fleet device fields (Graph/Intune-shaped OK)"},
            },
            "required": ["device"],
            "additionalProperties": False,
        },
    },
]


def _tool_result(payload: Any, is_error: bool = False) -> dict[str, Any]:
    text = payload if isinstance(payload, str) else json.dumps(payload, default=str, indent=2)
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def _deny() -> dict[str, Any]:
    return _tool_result({"error": "forbidden", "message": "Business not assigned to this partner."}, True)


def handle_tool(
    conn: sqlite3.Connection,
    partner: dict[str, Any],
    name: str,
    arguments: dict[str, Any] | None,
) -> dict[str, Any]:
    args = arguments or {}
    partner_id = partner["id"]

    if name == "glowops_list_businesses":
        return _tool_result({"partnerId": partner_id, "businesses": list_partner_businesses(conn, partner_id)})

    if name == "glowops_fleet_summary":
        biz = str(args.get("businessId") or "")
        if not partner_may_access(conn, partner_id, biz):
            return _deny()
        return _tool_result(fleet_summary(conn, biz))

    if name == "glowops_list_devices":
        biz = str(args.get("businessId") or "")
        if not partner_may_access(conn, partner_id, biz):
            return _deny()
        rows = list_devices(conn, biz)
        call = args.get("call")
        if call:
            rows = [r for r in rows if (r.get("call_label") or "") == call]
        limit = int(args.get("limit") or 100)
        limit = max(1, min(500, limit))
        slim = [
            {
                "id": r.get("id"),
                "deviceName": r.get("device_name"),
                "model": r.get("model"),
                "serialNumber": r.get("serial_number"),
                "call": r.get("call_label"),
                "glowScore": r.get("glow_score"),
                "ageYears": r.get("age_years"),
                "checkInDays": r.get("check_in_days"),
                "complianceState": r.get("compliance_state"),
                "rationale": r.get("rationale"),
            }
            for r in rows[:limit]
        ]
        return _tool_result({"businessId": biz, "count": len(slim), "devices": slim})

    if name == "glowops_get_device":
        biz = str(args.get("businessId") or "")
        if not partner_may_access(conn, partner_id, biz):
            return _deny()
        device_id = args.get("deviceId")
        serial = args.get("serialNumber")
        rows = list_devices(conn, biz)
        match = None
        for r in rows:
            if device_id and r.get("id") == device_id:
                match = r
                break
            if serial and (r.get("serial_number") or "") == serial:
                match = r
                break
        if not match:
            return _tool_result({"error": "not_found"}, True)
        return _tool_result(dict(match))

    if name == "glowops_score_device":
        device = args.get("device") or {}
        if not isinstance(device, dict):
            return _tool_result({"error": "device object required"}, True)
        return _tool_result({"decision": decide_device(device)})

    return _tool_result({"error": f"unknown tool: {name}"}, True)


def handle_mcp_rpc(conn: sqlite3.Connection, partner: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    """Minimal MCP-compatible JSON-RPC (initialize, tools/list, tools/call, ping)."""
    req_id = body.get("id")
    method = body.get("method") or ""
    params = body.get("params") or {}

    def ok(result: Any) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    def err(code: int, message: str) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}

    if method in ("initialize", "notifications/initialized"):
        if method == "notifications/initialized":
            return {"jsonrpc": "2.0", "id": req_id, "result": {}}
        return ok(
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": "glowops-partner-mcp",
                    "version": "0.1.0",
                    "partnerId": partner["id"],
                },
            }
        )

    if method in ("ping", "notifications/ping"):
        return ok({})

    if method == "tools/list":
        return ok({"tools": TOOLS})

    if method == "tools/call":
        name = params.get("name") or ""
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            arguments = {}
        result = handle_tool(conn, partner, name, arguments)
        return ok(result)

    if method == "resources/list":
        return ok({"resources": []})

    return err(-32601, f"Method not found: {method}")


# For typing consumers
ToolHandler = Callable[[sqlite3.Connection, dict[str, Any], str, dict[str, Any] | None], dict[str, Any]]
