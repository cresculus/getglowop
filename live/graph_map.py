"""Map Microsoft Graph / Intune / GlowOps collector shapes → inventory rows."""
from __future__ import annotations

from typing import Any


def map_glowops_inventory(doc: dict[str, Any]) -> dict[str, Any]:
    """Map glowops-inventory.json (collector/agent) into a scored device row."""
    device = doc.get("device") or {}
    system = doc.get("system") or {}
    battery = doc.get("battery") or {}
    signals = doc.get("signals") or {}
    storage = doc.get("storage") or []
    volumes = doc.get("volumes") or []

    notes: list[str] = []
    for n in (signals.get("notes") or []):
        if n:
            notes.append(str(n))

    battery_health = battery.get("healthPercent")
    chassis = (device.get("chassis") or "").lower()
    if "laptop" in chassis or "notebook" in chassis or "portable" in chassis:
        device_class = "laptop"
    elif "desktop" in chassis or "tower" in chassis:
        device_class = "desktop"
    else:
        device_class = None

    bitlocker = signals.get("bitlockerEnabled")
    compliance = "noncompliant" if bitlocker is False else "compliant"

    resources = doc.get("resources") or {}
    return {
        "id": doc.get("deviceKey") or device.get("serialNumber") or device.get("hostname"),
        "deviceName": device.get("hostname") or device.get("deviceName"),
        "manufacturer": device.get("manufacturer"),
        "model": device.get("model"),
        "serialNumber": device.get("serialNumber"),
        "operatingSystem": system.get("osCaption") or "Windows",
        "osVersion": system.get("osVersion") or system.get("osBuild"),
        "complianceState": compliance,
        "enrolledDateTime": system.get("osInstallDate"),
        "lastSyncDateTime": doc.get("collectedAt"),
        "batteryHealthPercent": battery_health,
        "userPrincipalName": system.get("lastInteractiveUser"),
        "deviceClass": device_class,
        "healthNotes": " ".join(notes) if notes else None,
        "glowopsInventory": doc,
        "storage": storage,
        "volumes": volumes,
        "signals": signals,
        "resources": resources,
        "cpuLoadPercent": resources.get("cpuLoadPercent"),
        "ramUsedPercent": resources.get("ramUsedPercent"),
        "ramTotalMB": resources.get("ramTotalMB"),
        "bitlockerEnabled": bitlocker,
        "tpmPresent": signals.get("tpmPresent"),
        "pendingReboot": system.get("pendingReboot"),
    }


def map_managed_device(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize one Graph managedDevice, collector doc, or CSV-shaped object."""
    if raw.get("schemaVersion") and isinstance(raw.get("device"), dict):
        return map_glowops_inventory(raw)
    if isinstance(raw.get("glowopsInventory"), dict):
        mapped = map_glowops_inventory(raw["glowopsInventory"])
        # Prefer explicit health notes from agent row if present
        if raw.get("healthNotes"):
            mapped["healthNotes"] = raw.get("healthNotes")
        if raw.get("batteryHealthPercent") is not None:
            mapped["batteryHealthPercent"] = raw.get("batteryHealthPercent")
        return mapped

    # Flat agent/Graph row — keep nested inventory fragments when present
    out = {
        "id": raw.get("id") or raw.get("intuneDeviceId") or raw.get("managedDeviceId"),
        "intuneDeviceId": raw.get("id") or raw.get("intuneDeviceId"),
        "azureDeviceId": raw.get("azureADDeviceId") or raw.get("azureDeviceId") or raw.get("azureAdDeviceId"),
        "deviceName": raw.get("deviceName") or raw.get("displayName") or raw.get("computerName"),
        "manufacturer": raw.get("manufacturer"),
        "model": raw.get("model"),
        "serialNumber": raw.get("serialNumber") or raw.get("serial"),
        "operatingSystem": raw.get("operatingSystem") or raw.get("os"),
        "osVersion": raw.get("osVersion") or raw.get("os_version"),
        "complianceState": raw.get("complianceState") or raw.get("compliance"),
        "enrolledDateTime": raw.get("enrolledDateTime") or raw.get("enrolledDate") or raw.get("createdDateTime"),
        "lastSyncDateTime": raw.get("lastSyncDateTime") or raw.get("lastCheckIn") or raw.get("lastContact"),
        "batteryHealthPercent": raw.get("batteryHealthPercent") or raw.get("batteryHealth"),
        "warrantyEndDate": raw.get("warrantyEndDate"),
        "userPrincipalName": raw.get("userPrincipalName") or raw.get("emailAddress") or raw.get("userDisplayName"),
        "persona": raw.get("persona") or raw.get("deviceCategoryDisplayName"),
        "deviceClass": raw.get("deviceClass"),
        "healthNotes": raw.get("healthNotes") or raw.get("notes"),
        "storage": raw.get("storage"),
        "volumes": raw.get("volumes"),
        "signals": raw.get("signals"),
        "resources": raw.get("resources"),
        "bitlockerEnabled": raw.get("bitlockerEnabled"),
        "tpmPresent": raw.get("tpmPresent"),
        "pendingReboot": raw.get("pendingReboot"),
        "cpuLoadPercent": raw.get("cpuLoadPercent"),
        "ramUsedPercent": raw.get("ramUsedPercent"),
        "ramTotalMB": raw.get("ramTotalMB"),
    }
    return out


def map_managed_devices(payload: Any) -> list[dict[str, Any]]:
    """Accept list, Graph {value:[...]}, collector doc, or {devices:[...]}."""
    if payload is None:
        return []
    if isinstance(payload, dict) and payload.get("schemaVersion") and isinstance(payload.get("device"), dict):
        return [map_glowops_inventory(payload)]
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        items = payload.get("value") or payload.get("devices") or payload.get("managedDevices") or []
        if isinstance(items, dict):
            items = items.get("value") or []
    else:
        return []
    return [map_managed_device(x) for x in items if isinstance(x, dict)]
