"""Partner accounts, sessions, and MCP API keys (per-partner isolation)."""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

PARTNER_SCHEMA = """
CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS partner_businesses (
  partner_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  business_name TEXT,
  PRIMARY KEY (partner_id, business_id),
  FOREIGN KEY (partner_id) REFERENCES partners(id)
);

CREATE TABLE IF NOT EXISTS partner_sessions (
  token_hash TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (partner_id) REFERENCES partners(id)
);

CREATE TABLE IF NOT EXISTS mcp_keys (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  label TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'read',
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  FOREIGN KEY (partner_id) REFERENCES partners(id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_keys_partner ON mcp_keys(partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_sessions_partner ON partner_sessions(partner_id);
"""

PBKDF2_ITERATIONS = 120_000
SESSION_HOURS = 12


def ensure_partner_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(PARTNER_SCHEMA)
    conn.commit()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None = None) -> str:
    return (dt or _now()).isoformat()


def _hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    salt_b = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt_b, PBKDF2_ITERATIONS)
    return digest.hex(), salt_b.hex()


def _verify_password(password: str, password_hash: str, password_salt: str) -> bool:
    salt_b = bytes.fromhex(password_salt)
    digest, _ = _hash_password(password, salt_b)
    return hmac.compare_digest(digest, password_hash)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_partner(
    conn: sqlite3.Connection,
    *,
    partner_id: str,
    name: str,
    email: str,
    password: str,
) -> dict[str, Any]:
    ensure_partner_schema(conn)
    pw_hash, pw_salt = _hash_password(password)
    conn.execute(
        """
        INSERT INTO partners (id, name, email, password_hash, password_salt, created_at, active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,
          email=excluded.email,
          password_hash=excluded.password_hash,
          password_salt=excluded.password_salt,
          active=1
        """,
        (partner_id, name, email.lower().strip(), pw_hash, pw_salt, _iso()),
    )
    conn.commit()
    return {"id": partner_id, "name": name, "email": email.lower().strip()}


def bind_business(conn: sqlite3.Connection, partner_id: str, business_id: str, business_name: str | None = None) -> None:
    ensure_partner_schema(conn)
    name = (business_name or "").strip() or business_id
    # Never clobber a human rename with the opaque id or a blank placeholder.
    conn.execute(
        """
        INSERT INTO partner_businesses (partner_id, business_id, business_name)
        VALUES (?, ?, ?)
        ON CONFLICT(partner_id, business_id) DO UPDATE SET
          business_name = CASE
            WHEN excluded.business_name IS NULL OR TRIM(excluded.business_name) = '' THEN partner_businesses.business_name
            WHEN excluded.business_name = excluded.business_id
                 AND partner_businesses.business_name IS NOT NULL
                 AND TRIM(partner_businesses.business_name) != ''
                 AND partner_businesses.business_name != partner_businesses.business_id
              THEN partner_businesses.business_name
            ELSE excluded.business_name
          END
        """,
        (partner_id, business_id, name),
    )
    conn.commit()
    try:
        from rbac import get_membership, grant_membership

        if not get_membership(conn, partner_id, business_id):
            grant_membership(conn, business_id=business_id, partner_id=partner_id, role="owner")
    except Exception:
        pass


def list_partner_businesses(conn: sqlite3.Connection, partner_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT pb.business_id,
               COALESCE(NULLIF(t.name, ''), NULLIF(pb.business_name, ''), pb.business_id) AS business_name,
               COALESCE(bm.created_at, '') AS bound_at
        FROM partner_businesses pb
        LEFT JOIN tenants t ON t.id = pb.business_id
        LEFT JOIN business_memberships bm
          ON bm.business_id = pb.business_id
         AND bm.partner_id = pb.partner_id
         AND bm.revoked_at IS NULL
        WHERE pb.partner_id = ?
        ORDER BY bound_at ASC, business_name COLLATE NOCASE, pb.business_id
        """,
        (partner_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def partner_may_access(conn: sqlite3.Connection, partner_id: str, business_id: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM partner_businesses WHERE partner_id = ? AND business_id = ?",
        (partner_id, business_id),
    ).fetchone()
    return row is not None


def authenticate_partner(conn: sqlite3.Connection, email: str, password: str) -> dict[str, Any] | None:
    ensure_partner_schema(conn)
    row = conn.execute(
        "SELECT * FROM partners WHERE email = ? AND active = 1",
        (email.lower().strip(),),
    ).fetchone()
    if not row:
        return None
    if not _verify_password(password, row["password_hash"], row["password_salt"]):
        return None
    return {"id": row["id"], "name": row["name"], "email": row["email"]}


def create_session(conn: sqlite3.Connection, partner_id: str) -> str:
    token = "gow_sess_" + secrets.token_urlsafe(32)
    expires = _now() + timedelta(hours=SESSION_HOURS)
    conn.execute(
        "INSERT INTO partner_sessions (token_hash, partner_id, expires_at, created_at) VALUES (?,?,?,?)",
        (_hash_token(token), partner_id, _iso(expires), _iso()),
    )
    conn.commit()
    return token


def partner_from_session(conn: sqlite3.Connection, token: str | None) -> dict[str, Any] | None:
    if not token or not token.startswith("gow_sess_"):
        return None
    row = conn.execute(
        """
        SELECT p.id, p.name, p.email, s.expires_at
        FROM partner_sessions s
        JOIN partners p ON p.id = s.partner_id
        WHERE s.token_hash = ? AND p.active = 1
        """,
        (_hash_token(token),),
    ).fetchone()
    if not row:
        return None
    try:
        expires = datetime.fromisoformat(row["expires_at"])
    except ValueError:
        return None
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires < _now():
        return None
    return {"id": row["id"], "name": row["name"], "email": row["email"]}


def revoke_session(conn: sqlite3.Connection, token: str | None) -> None:
    if not token:
        return
    conn.execute("DELETE FROM partner_sessions WHERE token_hash = ?", (_hash_token(token),))
    conn.commit()


def mint_mcp_key(conn: sqlite3.Connection, partner_id: str, label: str = "Default", scopes: str = "read") -> dict[str, Any]:
    """Returns plaintext key once; only hash is stored."""
    ensure_partner_schema(conn)
    key_id = "key_" + secrets.token_hex(8)
    plaintext = "gow_mcp_" + secrets.token_urlsafe(32)
    prefix = plaintext[:16]
    conn.execute(
        """
        INSERT INTO mcp_keys (id, partner_id, label, key_prefix, key_hash, scopes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (key_id, partner_id, label.strip() or "Default", prefix, _hash_token(plaintext), scopes, _iso()),
    )
    conn.commit()
    return {
        "id": key_id,
        "label": label,
        "prefix": prefix,
        "scopes": scopes,
        "apiKey": plaintext,
        "createdAt": _iso(),
        "note": "Copy now — GlowOps only stores a hash.",
    }


def list_mcp_keys(conn: sqlite3.Connection, partner_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, label, key_prefix, scopes, created_at, revoked_at, last_used_at
        FROM mcp_keys WHERE partner_id = ? ORDER BY created_at DESC
        """,
        (partner_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def revoke_mcp_key(conn: sqlite3.Connection, partner_id: str, key_id: str) -> bool:
    cur = conn.execute(
        "UPDATE mcp_keys SET revoked_at = ? WHERE id = ? AND partner_id = ? AND revoked_at IS NULL",
        (_iso(), key_id, partner_id),
    )
    conn.commit()
    return cur.rowcount > 0


def partner_from_mcp_key(conn: sqlite3.Connection, api_key: str | None) -> dict[str, Any] | None:
    if not api_key or not api_key.startswith("gow_mcp_"):
        return None
    key_hash = _hash_token(api_key)
    row = conn.execute(
        """
        SELECT k.id AS key_id, k.scopes, k.revoked_at, p.id, p.name, p.email
        FROM mcp_keys k
        JOIN partners p ON p.id = k.partner_id
        WHERE k.key_hash = ? AND p.active = 1
        """,
        (key_hash,),
    ).fetchone()
    if not row or row["revoked_at"]:
        return None
    conn.execute("UPDATE mcp_keys SET last_used_at = ? WHERE id = ?", (_iso(), row["key_id"]))
    conn.commit()
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "keyId": row["key_id"],
        "scopes": row["scopes"] or "read",
    }


def ensure_clerk_partner(
    conn: sqlite3.Connection,
    *,
    partner_id: str,
    name: str,
    email: str,
) -> dict[str, Any]:
    """Upsert a partner row for a Clerk user (password unused; auth is JWT)."""
    ensure_partner_schema(conn)
    email_n = (email or "").lower().strip()
    # Never invent clerk.local placeholders — they leaked into the Partner chrome as a "user id".
    if not email_n or email_n.endswith("@clerk.local"):
        email_n = f"partner+{secrets.token_hex(4)}@getglowop.internal"
    name_n = (name or "").strip() or "Partner"
    existing = conn.execute("SELECT id, name, email FROM partners WHERE id = ?", (partner_id,)).fetchone()
    if existing:
        conn.execute(
            "UPDATE partners SET name = ?, email = ?, active = 1 WHERE id = ?",
            (name_n, email_n, partner_id),
        )
        conn.commit()
        partner = {"id": partner_id, "name": name_n, "email": email_n, "auth": "clerk"}
    else:
        # Unique email: if another row owns it, keep that id's email suffix
        clash = conn.execute("SELECT id FROM partners WHERE email = ?", (email_n,)).fetchone()
        if clash and clash["id"] != partner_id:
            email_n = f"{partner_id[:12]}-{email_n}"
        pw = secrets.token_urlsafe(32)
        create_partner(conn, partner_id=partner_id, name=name_n, email=email_n, password=pw)
        partner = {"id": partner_id, "name": name_n, "email": email_n, "auth": "clerk"}
    # Every signed-in partner gets their own empty business — never the seeded demo fleet.
    ensure_partner_home_business(conn, partner)
    return partner


def new_business_id() -> str:
    """Opaque business/tenant id — never derived from Clerk user id or email."""
    return "biz_" + secrets.token_hex(8)


def is_legacy_clerk_business_id(business_id: str) -> bool:
    """Home fleets mistakenly named from Clerk email / user id (e.g. clerk-user-…)."""
    bid = (business_id or "").lower()
    if not bid or bid == "demo" or bid.startswith("biz_"):
        return False
    return bid.startswith("clerk-user") or bid.startswith("clerk_") or "@clerk" in bid


def rename_business_id(conn: sqlite3.Connection, old_id: str, new_id: str) -> str:
    """Rewrite a tenant id across inventory + partner + RBAC + enrollment tables."""
    if not old_id or not new_id or old_id == new_id:
        return old_id
    ensure_partner_schema(conn)
    # tenants
    row = conn.execute("SELECT name, created_at FROM tenants WHERE id = ?", (old_id,)).fetchone()
    if row:
        conn.execute(
            "INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)",
            (new_id, row["name"], row["created_at"]),
        )
        conn.execute("UPDATE tenants SET name = ? WHERE id = ?", (row["name"], new_id))
        conn.execute("DELETE FROM tenants WHERE id = ?", (old_id,))
    for table, col in (
        ("devices", "tenant_id"),
        ("ingest_events", "tenant_id"),
        ("agent_heartbeats", "tenant_id"),
        ("partner_businesses", "business_id"),
        ("enrollment_keys", "business_id"),
        ("business_memberships", "business_id"),
        ("business_invitations", "business_id"),
    ):
        try:
            conn.execute(f"UPDATE {table} SET {col} = ? WHERE {col} = ?", (new_id, old_id))
        except sqlite3.OperationalError:
            pass
    conn.commit()
    return new_id


def ensure_partner_home_business(conn: sqlite3.Connection, partner: dict[str, Any]) -> dict[str, Any]:
    """Ensure partner owns a non-demo business with an opaque biz_ id (not a Clerk user slug).

    Home = earliest bound non-demo business. Never overwrite an existing display name.
    """
    from db import ensure_tenant, get_tenant

    partner_id = partner["id"]
    businesses = [
        b for b in list_partner_businesses(conn, partner_id) if b.get("business_id") != "demo"
    ]
    if businesses:
        home = businesses[0]
        old_id = home.get("business_id") or ""
        if is_legacy_clerk_business_id(old_id):
            new_id = new_business_id()
            rename_business_id(conn, old_id, new_id)
            tenant = get_tenant(conn, new_id)
            return {
                "business_id": new_id,
                "business_name": tenant.get("name") or home.get("business_name") or "My business",
            }
        # Re-read tenant name so Partner MSP always mirrors Settings renames.
        tenant = get_tenant(conn, old_id)
        return {
            "business_id": old_id,
            "business_name": tenant.get("name") or home.get("business_name") or old_id,
        }

    business_id = new_business_id()
    name = "My business"
    ensure_tenant(conn, business_id, name)
    bind_business(conn, partner_id, business_id, name)
    return {"business_id": business_id, "business_name": name}


def seed_demo_partner(conn: sqlite3.Connection) -> dict[str, Any]:
    """Idempotent demo partner bound to business `demo`."""
    ensure_partner_schema(conn)
    existing = conn.execute("SELECT id FROM partners WHERE id = 'partner_demo'").fetchone()
    partner = create_partner(
        conn,
        partner_id="partner_demo",
        name="Demo Partner MSP",
        email="partner@getglowop.com",
        password="GlowOps-Partner-2026!",
    )
    bind_business(conn, "partner_demo", "demo", "Demo fleet")
    # Mint a key only if partner had none (so demos can call MCP immediately after first boot)
    keys = list_mcp_keys(conn, "partner_demo")
    minted = None
    if not keys and not existing:
        minted = mint_mcp_key(conn, "partner_demo", label="Bootstrap MCP", scopes="read")
    return {"partner": partner, "bootstrapKey": minted}
