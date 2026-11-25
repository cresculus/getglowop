"""Tenant RBAC: memberships, invites, permission checks (SQLite)."""
from __future__ import annotations

import hashlib
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

ROLES = ("owner", "admin", "operator", "viewer")

# permission → roles that have it
PERMISSIONS: dict[str, frozenset[str]] = {
    "business.read": frozenset(ROLES),
    "business.write": frozenset({"owner", "admin"}),
    "devices.read": frozenset(ROLES),
    "devices.write": frozenset({"owner", "admin", "operator"}),
    "enroll.manage": frozenset({"owner", "admin", "operator"}),
    "members.read": frozenset({"owner", "admin", "operator", "viewer"}),
    "members.manage": frozenset({"owner", "admin"}),
    "settings.mcp": frozenset({"owner", "admin"}),
    "connections.manage": frozenset({"owner", "admin"}),
    "invite.create": frozenset({"owner", "admin"}),
}

RBAC_SCHEMA = """
CREATE TABLE IF NOT EXISTS business_memberships (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (business_id, partner_id)
);

CREATE INDEX IF NOT EXISTS idx_bm_partner ON business_memberships(partner_id);
CREATE INDEX IF NOT EXISTS idx_bm_business ON business_memberships(business_id);

CREATE TABLE IF NOT EXISTS business_invitations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  accepted_partner_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_inv_business ON business_invitations(business_id);
CREATE INDEX IF NOT EXISTS idx_inv_email ON business_invitations(email);
"""

INVITE_TTL_DAYS = 14


def ensure_rbac_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(RBAC_SCHEMA)
    conn.commit()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None = None) -> str:
    return (dt or _now()).isoformat()


def _parse(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def normalize_role(role: str | None) -> str | None:
    r = (role or "").strip().lower()
    return r if r in ROLES else None


def role_allows(role: str | None, permission: str) -> bool:
    allowed = PERMISSIONS.get(permission)
    if not allowed:
        return False
    return (role or "") in allowed


def get_membership(
    conn: sqlite3.Connection, partner_id: str, business_id: str
) -> dict[str, Any] | None:
    ensure_rbac_schema(conn)
    row = conn.execute(
        """
        SELECT id, business_id, partner_id, role, created_at, updated_at
        FROM business_memberships
        WHERE partner_id = ? AND business_id = ? AND revoked_at IS NULL
        """,
        (partner_id, business_id),
    ).fetchone()
    return dict(row) if row else None


def partner_role_on_business(conn: sqlite3.Connection, partner_id: str, business_id: str) -> str | None:
    m = get_membership(conn, partner_id, business_id)
    return m["role"] if m else None


def partner_can(
    conn: sqlite3.Connection, partner_id: str, business_id: str, permission: str
) -> bool:
    # Legacy allowlist without membership row → treat as owner (bootstrap)
    role = partner_role_on_business(conn, partner_id, business_id)
    if role:
        return role_allows(role, permission)
    row = conn.execute(
        "SELECT 1 FROM partner_businesses WHERE partner_id = ? AND business_id = ?",
        (partner_id, business_id),
    ).fetchone()
    if row:
        # Backfill owner once
        grant_membership(conn, business_id=business_id, partner_id=partner_id, role="owner")
        return role_allows("owner", permission)
    return False


def grant_membership(
    conn: sqlite3.Connection,
    *,
    business_id: str,
    partner_id: str,
    role: str,
) -> dict[str, Any]:
    ensure_rbac_schema(conn)
    role_n = normalize_role(role) or "viewer"
    mid = f"bm_{secrets.token_hex(8)}"
    now = _iso()
    existing = conn.execute(
        "SELECT id FROM business_memberships WHERE business_id = ? AND partner_id = ?",
        (business_id, partner_id),
    ).fetchone()
    if existing:
        conn.execute(
            """
            UPDATE business_memberships
            SET role = ?, updated_at = ?, revoked_at = NULL
            WHERE business_id = ? AND partner_id = ?
            """,
            (role_n, now, business_id, partner_id),
        )
        mid = existing["id"]
    else:
        conn.execute(
            """
            INSERT INTO business_memberships (id, business_id, partner_id, role, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (mid, business_id, partner_id, role_n, now, now),
        )
    # Keep partner_businesses in sync for existing APIs
    conn.execute(
        """
        INSERT INTO partner_businesses (partner_id, business_id, business_name)
        VALUES (?, ?, ?)
        ON CONFLICT(partner_id, business_id) DO NOTHING
        """,
        (partner_id, business_id, business_id),
    )
    conn.commit()
    return {"id": mid, "businessId": business_id, "partnerId": partner_id, "role": role_n}


def revoke_membership(conn: sqlite3.Connection, *, business_id: str, partner_id: str, actor_id: str) -> bool:
    ensure_rbac_schema(conn)
    target = get_membership(conn, partner_id, business_id)
    if not target:
        return False
    if target["role"] == "owner" and partner_id != actor_id:
        # Only owners can remove themselves if another owner exists — block removing last owner
        owners = conn.execute(
            """
            SELECT COUNT(*) AS n FROM business_memberships
            WHERE business_id = ? AND role = 'owner' AND revoked_at IS NULL
            """,
            (business_id,),
        ).fetchone()
        if owners and int(owners["n"] or 0) <= 1:
            return False
    conn.execute(
        """
        UPDATE business_memberships SET revoked_at = ?, updated_at = ?
        WHERE business_id = ? AND partner_id = ? AND revoked_at IS NULL
        """,
        (_iso(), _iso(), business_id, partner_id),
    )
    conn.execute(
        "DELETE FROM partner_businesses WHERE partner_id = ? AND business_id = ?",
        (partner_id, business_id),
    )
    conn.commit()
    return True


def set_member_role(
    conn: sqlite3.Connection, *, business_id: str, partner_id: str, role: str, actor_id: str
) -> dict[str, Any] | None:
    role_n = normalize_role(role)
    if not role_n:
        return None
    target = get_membership(conn, partner_id, business_id)
    if not target:
        return None
    if target["role"] == "owner" and role_n != "owner":
        owners = conn.execute(
            """
            SELECT COUNT(*) AS n FROM business_memberships
            WHERE business_id = ? AND role = 'owner' AND revoked_at IS NULL
            """,
            (business_id,),
        ).fetchone()
        if owners and int(owners["n"] or 0) <= 1:
            return None
    return grant_membership(conn, business_id=business_id, partner_id=partner_id, role=role_n)


def list_members(conn: sqlite3.Connection, business_id: str) -> list[dict[str, Any]]:
    ensure_rbac_schema(conn)
    rows = conn.execute(
        """
        SELECT m.id, m.business_id, m.partner_id, m.role, m.created_at, m.updated_at,
               p.name, p.email
        FROM business_memberships m
        JOIN partners p ON p.id = m.partner_id
        WHERE m.business_id = ? AND m.revoked_at IS NULL
        ORDER BY
          CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END,
          p.email COLLATE NOCASE
        """,
        (business_id,),
    ).fetchall()
    return [
        {
            "id": r["id"],
            "businessId": r["business_id"],
            "partnerId": r["partner_id"],
            "role": r["role"],
            "name": r["name"],
            "email": r["email"],
            "createdAt": r["created_at"],
            "updatedAt": r["updated_at"],
        }
        for r in rows
    ]


def create_invitation(
    conn: sqlite3.Connection,
    *,
    business_id: str,
    email: str,
    role: str,
    invited_by: str,
) -> dict[str, Any]:
    ensure_rbac_schema(conn)
    role_n = normalize_role(role) or "viewer"
    if role_n == "owner":
        role_n = "admin"  # cannot invite as owner; promote later
    email_n = email.lower().strip()
    if not email_n or "@" not in email_n:
        raise ValueError("valid email required")
    token = "gow_inv_" + secrets.token_urlsafe(24)
    iid = "inv_" + secrets.token_hex(8)
    expires = _now() + timedelta(days=INVITE_TTL_DAYS)
    conn.execute(
        """
        INSERT INTO business_invitations
          (id, business_id, email, role, token_hash, invited_by, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (iid, business_id, email_n, role_n, _hash_token(token), invited_by, _iso(), _iso(expires)),
    )
    conn.commit()
    return {
        "id": iid,
        "businessId": business_id,
        "email": email_n,
        "role": role_n,
        "expiresAt": _iso(expires),
        "inviteToken": token,
        "acceptPath": f"/partner/accept-invite?token={token}",
        "note": "Share the invite link once. Token is not stored in plaintext.",
    }


def list_invitations(conn: sqlite3.Connection, business_id: str) -> list[dict[str, Any]]:
    ensure_rbac_schema(conn)
    rows = conn.execute(
        """
        SELECT id, business_id, email, role, invited_by, created_at, expires_at,
               accepted_at, revoked_at
        FROM business_invitations
        WHERE business_id = ?
        ORDER BY created_at DESC
        """,
        (business_id,),
    ).fetchall()
    out = []
    for r in rows:
        status = "pending"
        if r["revoked_at"]:
            status = "revoked"
        elif r["accepted_at"]:
            status = "accepted"
        elif _parse(r["expires_at"]) < _now():
            status = "expired"
        out.append(
            {
                "id": r["id"],
                "businessId": r["business_id"],
                "email": r["email"],
                "role": r["role"],
                "invitedBy": r["invited_by"],
                "createdAt": r["created_at"],
                "expiresAt": r["expires_at"],
                "status": status,
            }
        )
    return out


def revoke_invitation(conn: sqlite3.Connection, invitation_id: str, business_id: str) -> bool:
    ensure_rbac_schema(conn)
    cur = conn.execute(
        """
        UPDATE business_invitations SET revoked_at = ?
        WHERE id = ? AND business_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
        """,
        (_iso(), invitation_id, business_id),
    )
    conn.commit()
    return cur.rowcount > 0


def accept_invitation(
    conn: sqlite3.Connection, *, token: str, partner_id: str, partner_email: str
) -> dict[str, Any] | None:
    ensure_rbac_schema(conn)
    row = conn.execute(
        """
        SELECT * FROM business_invitations WHERE token_hash = ?
        """,
        (_hash_token(token),),
    ).fetchone()
    if not row or row["revoked_at"] or row["accepted_at"]:
        return None
    if _parse(row["expires_at"]) < _now():
        return None
    inv_email = (row["email"] or "").lower().strip()
    if inv_email and partner_email and inv_email != partner_email.lower().strip():
        return None
    membership = grant_membership(
        conn, business_id=row["business_id"], partner_id=partner_id, role=row["role"]
    )
    conn.execute(
        """
        UPDATE business_invitations
        SET accepted_at = ?, accepted_partner_id = ?
        WHERE id = ?
        """,
        (_iso(), partner_id, row["id"]),
    )
    conn.commit()
    return {
        "ok": True,
        "businessId": row["business_id"],
        "role": row["role"],
        "membership": membership,
    }


def permission_catalog() -> list[dict[str, Any]]:
    return [
        {"permission": p, "roles": sorted(roles)}
        for p, roles in sorted(PERMISSIONS.items())
    ]
