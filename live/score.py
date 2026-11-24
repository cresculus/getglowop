"""GLOW Score — ported from Go Live Device Lifecycle Advisor (Phase 0)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

GHOST_CHECKIN_DAYS = 90
DEFAULT_REFRESH_POLICY_YEARS = 3
DEFAULT_LAPTOP_MFG_KG = 219.0

PERSONA_KEEP_YEARS = {
    "default": 5.0,
    "kiosk": 6.0,
    "clinical": 4.0,
    "finance": 4.0,
    "knowledge": 5.0,
}


def _parse_dt(value: str | None) -> datetime | None:
    if not value or not str(value).strip():
        return None
    raw = str(value).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _years_between(a: datetime, b: datetime) -> float:
    return (b - a).total_seconds() / (365.25 * 24 * 3600)


def _days_between(a: datetime, b: datetime) -> float:
    return (b - a).total_seconds() / (24 * 3600)


def _clamp(n: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, n))


def _normalize_persona(raw: str | None) -> str:
    if not raw:
        return "default"
    key = str(raw).strip().lower()
    return key if key in PERSONA_KEEP_YEARS else "default"


def _infer_class(model: str | None, manufacturer: str | None, hint: str | None) -> str:
    if hint in ("laptop", "desktop", "tablet", "unknown"):
        return hint  # type: ignore[return-value]
    blob = f"{manufacturer or ''} {model or ''}".lower()
    if any(x in blob for x in ("optiplex", "thinkcentre", "prodesk", "elite desk", "desktop", "tower")):
        return "desktop"
    if any(x in blob for x in ("ipad", "surface go", "tablet")):
        return "tablet"
    return "laptop"


def _match_factor(model: str | None, device_class: str) -> dict[str, Any]:
    kg = 320.0 if device_class == "desktop" else DEFAULT_LAPTOP_MFG_KG
    label = model or ("Desktop-class device" if device_class == "desktop" else "Laptop-class device")
    return {
        "label": label,
        "manufacturingKgCo2e": kg,
        "confidence": "fallback",
        "source": "GlowOps Phase 0 family estimate (Ferreira-style laptop ~219 kg)",
        "year": 2025,
    }


def decide_device(inp: dict[str, Any], *, now: datetime | None = None, refresh_policy_years: float = DEFAULT_REFRESH_POLICY_YEARS) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    persona_key = _normalize_persona(inp.get("persona"))
    persona_keep = PERSONA_KEEP_YEARS[persona_key]
    device_class = _infer_class(inp.get("model"), inp.get("manufacturer"), inp.get("deviceClass"))
    factor = _match_factor(inp.get("model"), device_class)

    enrolled = _parse_dt(inp.get("enrolledDateTime"))
    last_sync = _parse_dt(inp.get("lastSyncDateTime"))
    age_years = _years_between(enrolled, now) if enrolled else None
    check_in_days = _days_between(last_sync, now) if last_sync else None
    battery = inp.get("batteryHealthPercent")
    if battery is not None:
        try:
            battery = float(battery)
        except (TypeError, ValueError):
            battery = None

    notes = f"{inp.get('healthNotes') or ''} {inp.get('model') or ''}".lower()
    within_persona = True if age_years is None else age_years < persona_keep
    calendar_would = age_years is not None and age_years >= refresh_policy_years

    board_failed = any(x in notes for x in ("board", "motherboard", "logic board", "no boot", "dead"))
    disk_failing = any(x in notes for x in ("disk", "ssd", "hdd", "storage fail", "failing disk", "predictive failure"))
    os_blocked = any(x in notes for x in ("cannot take", "unsupported os", "windows 10 eol"))

    compliance = (inp.get("complianceState") or "").lower()
    noncompliant = "noncompliant" in compliance or "non-compliant" in compliance or compliance == "error"

    if check_in_days is not None and check_in_days >= GHOST_CHECKIN_DAYS:
        call = "ghost"
        rationale = f"Last check-in {round(check_in_days)} days ago. Find it before buying a replacement — ghost hardware is a security and spend problem."
    elif board_failed or (age_years is not None and age_years >= 8) or os_blocked:
        call = "recycle"
        if board_failed:
            rationale = "Hardware failure looks chassis-level. Recycle or remarket — this is the refresh the policy was for."
        elif os_blocked:
            rationale = "Device cannot take the current OS baseline. Refresh or certified recycle."
        else:
            rationale = f"About {age_years:.1f} years in service. Manufacturing is already spent; schedule certified recycle / remarket."
    elif disk_failing and (battery is None or battery >= 60):
        call = "redeploy"
        rationale = "Storage looks like the failure, not the chassis. Redeploy after SSD repair when the device is otherwise sound."
    elif battery is not None and battery < 70 and (age_years is None or age_years < 8):
        call = "repair"
        rationale = f"Battery health {battery}%. Repair the battery before buying a new laptop to celebrate a calendar."
    elif age_years is not None and age_years >= persona_keep and (battery is None or battery < 80):
        call = "refresh"
        rationale = f"Past the {persona_keep:.0f}-year {persona_key} keep window ({age_years:.1f} yrs) with limited health headroom. Plan a controlled refresh."
    elif (not within_persona) and calendar_would:
        call = "refresh"
        rationale = f"Outside the {persona_keep:.0f}-year persona window. Align purchase with real health, not only the {refresh_policy_years:.0f}-year calendar."
    else:
        call = "keep"
        if battery is not None and battery >= 80:
            rationale = f"Keep. Health {battery}% and still inside the {persona_keep:.0f}-year {persona_key} window. Tune power policy; the calendar is early."
        else:
            rationale = f"Keep and optimize. Inside the {persona_keep:.0f}-year {persona_key} window. Extend use before manufacturing another device."

    age_score = 70.0 if age_years is None else _clamp(100 - (age_years / persona_keep) * 70, 5, 100)
    health_score = 55.0 if battery is None else _clamp(battery, 0, 100)
    warranty_end = _parse_dt(inp.get("warrantyEndDate"))
    warranty_score = 90.0 if warranty_end and warranty_end > now else 40.0
    compliance_score = 25.0 if noncompliant else 85.0
    if check_in_days is None:
        check_in_score = 50.0
    elif check_in_days >= GHOST_CHECKIN_DAYS:
        check_in_score = 5.0
    else:
        check_in_score = _clamp(100 - check_in_days / 2, 10, 100)
    carbon_score = _clamp(100 - factor["manufacturingKgCo2e"] / 6, 20, 95)

    glow = round(
        carbon_score * 0.15
        + age_score * 0.25
        + health_score * 0.25
        + warranty_score * 0.1
        + compliance_score * 0.1
        + check_in_score * 0.15
    )
    if call == "ghost":
        glow = min(glow, 25)
    elif call == "recycle":
        glow = min(glow, 30)
    elif call == "refresh":
        glow = min(glow, 45)
    elif call == "repair":
        glow = int(_clamp(glow, 40, 70))
    elif call == "keep":
        glow = max(glow, 60)

    return {
        "call": call,
        "rationale": rationale,
        "glowScore": glow,
        "ageYears": None if age_years is None else round(age_years, 1),
        "checkInDaysAgo": None if check_in_days is None else round(check_in_days),
        "withinPersonaWindow": within_persona,
        "personaKey": persona_key,
        "personaKeepYears": persona_keep,
        "factor": factor,
        "calendarWouldRefresh": calendar_would,
    }
