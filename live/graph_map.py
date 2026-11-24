"""Map Microsoft Graph / Intune managedDevice shapes → GlowOps inventory rows.

Aligned with Go Live GraphDeviceCollectionService + ManagedDeviceMapper patterns:
deviceName, manufacturer, model, serialNumber, operatingSystem, osVersion,
complianceState, enrolledDateTime, lastSyncDateTime, azureADDeviceId, id, userPrincipalName.
"""
from __future__ import annotations

from typing import Any


def map_managed_device(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize one Graph managedDevice (or CSV-shaped) object."""
    return {
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
    }


def map_managed_devices(payload: Any) -> list[dict[str, Any]]:
    """Accept list, Graph {value:[...]}, or {devices:[...]}."""
    if payload is None:
        return []
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        items = payload.get("value") or payload.get("devices") or payload.get("managedDevices") or []
        if isinstance(items, dict):
            items = items.get("value") or []
    else:
        return []
    return [map_managed_device(x) for x in items if isinstance(x, dict)]
