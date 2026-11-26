"""Postgres connection for GLOWOpsDB. The live app does not store fleet data on disk."""
from __future__ import annotations

import os
import re
import sqlite3
import threading
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlparse, urlunparse

import psycopg
from psycopg.rows import dict_row


def database_url() -> str:
    url = (os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL") or "").strip()
    if not url:
        raise RuntimeError(
            "DATABASE_URL is required. GlowOps stores customer data in Supabase, not on the Railway disk."
        )
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://") :]
    url = _use_ipv4_pooler(url)
    if "sslmode=" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    host = urlparse(url).hostname or ""
    print(f"database host={host}", flush=True)
    return url


def _use_ipv4_pooler(url: str) -> str:
    """Direct db.<ref>.supabase.co is IPv6-only. Railway cannot reach it.

    Session pooler on aws-0-us-east-2 is IPv4. Username must be postgres.<ref>.
    """
    parsed = urlparse(url)
    host = parsed.hostname or ""
    match = re.fullmatch(r"db\.([a-z0-9]+)\.supabase\.co", host)
    if not match:
        return url
    ref = match.group(1)
    pooler = (os.environ.get("SUPABASE_POOLER_HOST") or "aws-0-us-east-2.pooler.supabase.com").strip()
    user = unquote(parsed.username or "postgres")
    if "." not in user:
        user = f"{user}.{ref}"
    password = unquote(parsed.password or "")
    port = parsed.port or 5432
    netloc = f"{quote(user, safe='')}:{quote(password, safe='')}@{pooler}:{port}"
    return urlunparse(parsed._replace(netloc=netloc))


def adapt_sql(sql: str) -> str:
    """SQLite spellings still in the app, aimed at the Supabase column names."""
    original = sql
    sql = re.sub(r"\bINSERT\s+OR\s+IGNORE\s+INTO\b", "INSERT INTO", sql, flags=re.I)
    if "OR IGNORE" in original.upper() and "ON CONFLICT" not in sql.upper():
        sql = sql.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"
    sql = re.sub(r"\btenants\b", "businesses", sql)
    sql = sql.replace("tenant_id", "business_id")
    sql = re.sub(r"\s+COLLATE\s+NOCASE", "", sql, flags=re.I)
    sql = re.sub(r"\bactive\s*=\s*1\b", "active = true", sql, flags=re.I)
    return sql.replace("?", "%s")


class _Result:
    def __init__(self, rows: list[dict[str, Any]], rowcount: int) -> None:
        self._rows = rows
        self.rowcount = rowcount

    def fetchall(self) -> list[dict[str, Any]]:
        return self._rows

    def fetchone(self) -> dict[str, Any] | None:
        return self._rows[0] if self._rows else None


class PgConn:
    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn
        self._lock = threading.Lock()

    def execute(self, sql: str, params: tuple | list = ()) -> _Result:
        statement = adapt_sql(sql)
        values = tuple(params or ())
        with self._lock:
            try:
                cur = self._conn.execute(statement, values)
            except psycopg.Error:
                self._reconnect()
                cur = self._conn.execute(statement, values)
            if cur.description:
                rows = [dict(row) for row in cur.fetchall()]
            else:
                rows = []
            return _Result(rows, cur.rowcount)

    def execute_native(self, sql: str, params: tuple | list = ()) -> _Result:
        """Postgres SQL with %s placeholders, no SQLite rewrites."""
        values = tuple(params or ())
        with self._lock:
            try:
                cur = self._conn.execute(sql, values)
            except psycopg.OperationalError:
                self._reconnect()
                cur = self._conn.execute(sql, values)
            rows = [dict(row) for row in cur.fetchall()] if cur.description else []
            return _Result(rows, cur.rowcount)

    def executescript(self, _sql: str) -> None:
        """Schema lives in supabase/migrations. Do not create tables from the app."""
        return None

    def commit(self) -> None:
        return None

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _reconnect(self) -> None:
        try:
            self._conn.close()
        except Exception:
            pass
        self._conn = _connect()


def _connect() -> psycopg.Connection:
    return psycopg.connect(
        database_url(),
        autocommit=True,
        prepare_threshold=None,
        row_factory=dict_row,
        connect_timeout=15,
    )


def connect_postgres() -> PgConn:
    pg = PgConn(_connect())
    pg.execute("SELECT 1 AS ok").fetchone()
    print("database=supabase", flush=True)
    return pg


def import_sqlite_if_present(pg: PgConn) -> None:
    """One-time copy of the Railway sqlite file into Supabase, if that file is still mounted."""
    candidates = []
    raw = (os.environ.get("GLOWOPS_DATA") or "").strip()
    if raw:
        candidates.append(Path(raw) / "glowops.db")
    candidates.append(Path("/data/glowops.db"))
    src_path = next((p for p in candidates if p.is_file() and p.stat().st_size > 0), None)
    if src_path is None:
        return
    flag = src_path.with_name("glowops.supabase-imported")
    if flag.is_file():
        return
    src = sqlite3.connect(src_path)
    src.row_factory = sqlite3.Row
    try:
        _copy_sqlite(pg, src)
    finally:
        src.close()
    try:
        flag.write_text("ok", encoding="utf-8")
    except OSError as exc:
        print(f"sqlite import done but flag not written: {exc}", flush=True)
    print(f"imported sqlite {src_path} into supabase", flush=True)


def _tables(src: sqlite3.Connection) -> set[str]:
    rows = src.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    return {row["name"] for row in rows}


def _cols(src: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in src.execute(f"PRAGMA table_info({table})").fetchall()}


def _put(pg: PgConn, sql: str, params: tuple) -> None:
    try:
        pg.execute(sql, params)
    except Exception as exc:
        print(f"sqlite import skipped a row: {exc}", flush=True)


def _copy_sqlite(pg: PgConn, src: sqlite3.Connection) -> None:
    tables = _tables(src)
    if "tenants" in tables:
        for row in src.execute("SELECT id, name, created_at FROM tenants"):
            _put(pg, 
                """
                INSERT INTO businesses (id, name, created_at)
                VALUES (%s, %s, %s)
                ON CONFLICT (id) DO NOTHING
                """,
                (row["id"], row["name"] or row["id"], row["created_at"]),
            )
    if "partners" in tables:
        have = _cols(src, "partners")
        for row in src.execute("SELECT * FROM partners"):
            _put(pg, 
                """
                INSERT INTO partners (id, clerk_user_id, name, email, password_hash, password_salt, created_at, active)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO NOTHING
                """,
                (
                    row["id"],
                    row["clerk_user_id"] if "clerk_user_id" in have else None,
                    row["name"],
                    row["email"],
                    row["password_hash"] if "password_hash" in have else None,
                    row["password_salt"] if "password_salt" in have else None,
                    row["created_at"],
                    bool(row["active"]) if "active" in have else True,
                ),
            )
    if "partner_businesses" in tables:
        for row in src.execute("SELECT * FROM partner_businesses"):
            _put(pg, 
                """
                INSERT INTO partner_businesses (partner_id, business_id, business_name)
                VALUES (%s, %s, %s)
                ON CONFLICT (partner_id, business_id) DO NOTHING
                """,
                (row["partner_id"], row["business_id"], row["business_name"] if "business_name" in row.keys() else None),
            )
    if "devices" in tables:
        for row in src.execute("SELECT * FROM devices"):
            raw = row["raw_json"]
            biz = row["tenant_id"] if "tenant_id" in row.keys() else row["business_id"]
            _put(pg, 
                """
                INSERT INTO devices (
                  id, business_id, source, device_name, manufacturer, model, serial_number,
                  operating_system, os_version, compliance_state, enrolled_at, last_sync_at,
                  battery_health, warranty_end, user_upn, persona, device_class, health_notes,
                  azure_device_id, intune_device_id, raw_json, call_label, glow_score, rationale,
                  age_years, check_in_days, mfg_kg, updated_at
                ) VALUES (
                  %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s,%s,%s
                )
                ON CONFLICT (id) DO NOTHING
                """,
                (
                    row["id"],
                    biz,
                    row["source"],
                    row["device_name"],
                    row["manufacturer"],
                    row["model"],
                    row["serial_number"],
                    row["operating_system"],
                    row["os_version"],
                    row["compliance_state"],
                    row["enrolled_at"],
                    row["last_sync_at"],
                    row["battery_health"],
                    row["warranty_end"],
                    row["user_upn"],
                    row["persona"],
                    row["device_class"],
                    row["health_notes"],
                    row["azure_device_id"],
                    row["intune_device_id"],
                    raw if raw else None,
                    row["call_label"],
                    row["glow_score"],
                    row["rationale"],
                    row["age_years"],
                    row["check_in_days"],
                    row["mfg_kg"],
                    row["updated_at"],
                ),
            )
    for table in ("partner_sessions", "mcp_keys", "enrollment_keys", "business_memberships", "business_invitations"):
        if table not in tables:
            continue
        rows = src.execute(f"SELECT * FROM {table}").fetchall()
        if not rows:
            continue
        cols = list(rows[0].keys())
        if table == "business_memberships" and "revoked_at" not in cols:
            continue
        collist = ", ".join(cols)
        placeholders = ", ".join(["%s"] * len(cols))
        for row in rows:
            _put(pg, 
                f"INSERT INTO {table} ({collist}) VALUES ({placeholders}) ON CONFLICT DO NOTHING",
                tuple(row[c] for c in cols),
            )
