"""Business join/enrollment keys — strong key+password, expiring, join-only scope.

Controls aligned to a SaaS access-control baseline (unique secret, hashed at rest,
time-bound, purpose-limited to device join/inventory upload). Not a compliance claim.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
import string
from datetime import datetime, timedelta, timezone
from typing import Any

ENROLLMENT_SCHEMA = """
CREATE TABLE IF NOT EXISTS enrollment_keys (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  label TEXT NOT NULL,
  key_code TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  secret_salt TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'device-join',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_enroll_partner ON enrollment_keys(partner_id);
CREATE INDEX IF NOT EXISTS idx_enroll_business ON enrollment_keys(business_id);
CREATE INDEX IF NOT EXISTS idx_enroll_code ON enrollment_keys(key_code);
"""

# Join keys hard-cap: 30 days (tight window for device onboarding).
MAX_TTL_HOURS = 24 * 30
DEFAULT_TTL_HOURS = 24
PBKDF2_ITERATIONS = 180_000


def ensure_enrollment_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(ENROLLMENT_SCHEMA)
    conn.commit()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None = None) -> str:
    return (dt or _now()).isoformat()


def _parse_iso(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        dt = value
    else:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _hash_secret(secret: str, salt: bytes | None = None) -> tuple[str, str]:
    salt_b = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", secret.encode("utf-8"), salt_b, PBKDF2_ITERATIONS)
    return digest.hex(), salt_b.hex()


def _verify_secret(secret: str, secret_hash: str, secret_salt: str) -> bool:
    salt_b = bytes.fromhex(secret_salt)
    digest, _ = _hash_secret(secret, salt_b)
    return hmac.compare_digest(digest, secret_hash)


def _strong_password(length: int = 28) -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*-_=+"
    # Guarantee complexity classes
    parts = [
        secrets.choice(string.ascii_uppercase),
        secrets.choice(string.ascii_lowercase),
        secrets.choice(string.digits),
        secrets.choice("!@#$%^&*-_=+"),
    ]
    parts += [secrets.choice(alphabet) for _ in range(length - 4)]
    # shuffle
    for i in range(len(parts) - 1, 0, -1):
        j = secrets.randbelow(i + 1)
        parts[i], parts[j] = parts[j], parts[i]
    return "".join(parts)


def _key_code() -> str:
    # Human-enterable join key, unique
    chunk = lambda n: "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(n))
    return f"GOW-{chunk(4)}-{chunk(4)}-{chunk(4)}"


def mint_enrollment_key(
    conn: sqlite3.Connection,
    *,
    partner_id: str,
    business_id: str,
    label: str = "Device join",
    ttl_hours: int = DEFAULT_TTL_HOURS,
) -> dict[str, Any]:
    ensure_enrollment_schema(conn)
    ttl = max(1, min(int(ttl_hours), MAX_TTL_HOURS))
    key_id = "enroll_" + secrets.token_hex(8)
    code = _key_code()
    # collision retry
    for _ in range(5):
        exists = conn.execute("SELECT 1 FROM enrollment_keys WHERE key_code = ?", (code,)).fetchone()
        if not exists:
            break
        code = _key_code()
    password = _strong_password(28)
    secret_hash, secret_salt = _hash_secret(password)
    expires = _now() + timedelta(hours=ttl)
    conn.execute(
        """
        INSERT INTO enrollment_keys (
          id, partner_id, business_id, label, key_code, secret_hash, secret_salt,
          key_prefix, scope, created_at, expires_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            key_id,
            partner_id,
            business_id,
            (label or "Device join").strip(),
            code,
            secret_hash,
            secret_salt,
            code[:8],
            "device-join",
            _iso(),
            _iso(expires),
        ),
    )
    conn.commit()
    dashboard_url = (os.environ.get("GLOWOPS_PUBLIC_URL") or "https://getglowop.com").rstrip("/")
    return {
        "id": key_id,
        "businessId": business_id,
        "label": label,
        "joinKey": code,
        "joinPassword": password,
        "dashboardUrl": dashboard_url,
        "scope": "device-join",
        "expiresAt": _iso(expires),
        "ttlHours": ttl,
        "note": "Copy now — GlowOps stores only a hash. After expiry this key cannot join devices.",
    }


def list_enrollment_keys(conn: sqlite3.Connection, partner_id: str) -> list[dict[str, Any]]:
    ensure_enrollment_schema(conn)
    rows = conn.execute(
        """
        SELECT id, business_id, label, key_code, key_prefix, scope, created_at, expires_at,
               revoked_at, last_used_at, use_count
        FROM enrollment_keys
        WHERE partner_id = ?
        ORDER BY created_at DESC
        """,
        (partner_id,),
    ).fetchall()
    out = []
    now = _now()
    for r in rows:
        d = dict(r)
        try:
            exp = _parse_iso(d["expires_at"])
            d["expired"] = exp <= now
        except ValueError:
            d["expired"] = True
        d["status"] = (
            "revoked" if d.get("revoked_at") else ("expired" if d["expired"] else "active")
        )
        out.append(d)
    return out


def revoke_enrollment_key(conn: sqlite3.Connection, partner_id: str, key_id: str) -> bool:
    cur = conn.execute(
        """
        UPDATE enrollment_keys SET revoked_at = ?
        WHERE id = ? AND partner_id = ? AND revoked_at IS NULL
        """,
        (_iso(), key_id, partner_id),
    )
    conn.commit()
    return cur.rowcount > 0


def verify_enrollment(
    conn: sqlite3.Connection,
    *,
    join_key: str | None,
    join_password: str | None,
    business_id: str | None = None,
    allow_expired_refresh: bool = False,
) -> dict[str, Any] | None:
    """Validate join key+password. Returns business binding or None.

    New joins fail closed after expiry/revoke. Scheduled inventory/heartbeat may
    pass allow_expired_refresh=True so already-enrolled devices keep reporting.
    """
    ensure_enrollment_schema(conn)
    if not join_key or not join_password:
        return None
    code = join_key.strip().upper().replace(" ", "")
    row = conn.execute(
        "SELECT * FROM enrollment_keys WHERE key_code = ?",
        (code,),
    ).fetchone()
    if not row:
        return None
    if row["revoked_at"]:
        return None
    expired = False
    try:
        expired = _parse_iso(row["expires_at"]) <= _now()
    except ValueError:
        return None
    if expired and not allow_expired_refresh:
        return None
    if not _verify_secret(join_password, row["secret_hash"], row["secret_salt"]):
        return None
    if business_id and business_id != row["business_id"]:
        # Client-claimed business must match key binding
        return None
    conn.execute(
        """
        UPDATE enrollment_keys
        SET last_used_at = ?, use_count = use_count + 1
        WHERE id = ?
        """,
        (_iso(), row["id"]),
    )
    conn.commit()
    return {
        "enrollmentId": row["id"],
        "partnerId": row["partner_id"],
        "businessId": row["business_id"],
        "scope": row["scope"],
        "expiresAt": row["expires_at"],
        "label": row["label"],
        "expired": expired,
        "refreshOnly": expired,
    }
