"""One-click Intune deploy: admin consent per customer, then upload a Win32 app through Graph.

Needs one multi-tenant Entra app registration owned by GlowOps:
  GLOWOPS_INTUNE_CLIENT_ID / GLOWOPS_INTUNE_CLIENT_SECRET
  Application permission: DeviceManagementApps.ReadWrite.All (admin consent per customer)
  Redirect URI: <public url>/partner/intune/callback

No customer tokens are stored. Each deploy asks Entra for a fresh app-only token.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from deploy_kits import INSTALL_COMMAND, UNINSTALL_COMMAND, DETECT_PS1, IntuneWin

GRAPH = "https://graph.microsoft.com/beta"
LOGIN = "https://login.microsoftonline.com"
STATE_TTL_SECONDS = 15 * 60
BLOCK_SIZE = 6 * 1024 * 1024


class IntuneError(RuntimeError):
    pass


def _client() -> tuple[str, str]:
    return (
        (os.environ.get("GLOWOPS_INTUNE_CLIENT_ID") or "").strip(),
        (os.environ.get("GLOWOPS_INTUNE_CLIENT_SECRET") or "").strip(),
    )


def configured() -> bool:
    cid, secret = _client()
    return bool(cid and secret)


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sign_state(partner_id: str, business_id: str) -> str:
    _, secret = _client()
    body = _b64url(
        json.dumps({"p": partner_id, "b": business_id, "exp": int(time.time()) + STATE_TTL_SECONDS}).encode()
    )
    sig = _b64url(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_state(state: str) -> dict[str, Any] | None:
    _, secret = _client()
    if not secret or "." not in (state or ""):
        return None
    body, sig = state.rsplit(".", 1)
    want = _b64url(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(want, sig):
        return None
    try:
        data = json.loads(_unb64url(body))
    except (ValueError, json.JSONDecodeError):
        return None
    if int(data.get("exp") or 0) < time.time():
        return None
    return data


def consent_url(state: str, redirect_uri: str) -> str:
    cid, _ = _client()
    q = urllib.parse.urlencode(
        {
            "client_id": cid,
            "scope": "https://graph.microsoft.com/.default",
            "redirect_uri": redirect_uri,
            "state": state,
        }
    )
    return f"{LOGIN}/organizations/v2.0/adminconsent?{q}"


# --- connection rows (connections_intune). Native SQL: the column is tenant_id. ---

def _native(conn):
    fn = getattr(conn, "execute_native", None)
    if fn is None:
        raise IntuneError("Intune connections need the Supabase database.")
    return fn


def get_connection(conn, business_id: str) -> dict[str, Any] | None:
    row = _native(conn)(
        "SELECT tenant_id, status, consent_at FROM connections_intune WHERE business_id = %s",
        (business_id,),
    ).fetchone()
    if not row or row.get("status") != "connected" or not row.get("tenant_id"):
        return None
    return {"directoryId": row["tenant_id"], "connectedAt": str(row.get("consent_at") or "")}


def save_connection(conn, business_id: str, directory_id: str) -> None:
    _native(conn)(
        """
        INSERT INTO connections_intune (business_id, tenant_id, status, consent_at, scopes, updated_at)
        VALUES (%s, %s, 'connected', now(), 'DeviceManagementApps.ReadWrite.All', now())
        ON CONFLICT (business_id) DO UPDATE
          SET tenant_id = EXCLUDED.tenant_id, status = 'connected',
              consent_at = now(), scopes = EXCLUDED.scopes, updated_at = now()
        """,
        (business_id, directory_id),
    )


def clear_connection(conn, business_id: str) -> None:
    _native(conn)(
        "UPDATE connections_intune SET status = 'disconnected', updated_at = now() WHERE business_id = %s",
        (business_id,),
    )


# --- HTTP ---

def _request(method: str, url: str, *, token: str | None = None, body: Any = None,
             raw: bytes | None = None, headers: dict | None = None, timeout: int = 60) -> Any:
    h = dict(headers or {})
    data = raw
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        h["Content-Type"] = "application/json"
    if token:
        h["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise IntuneError(f"{method} {url.split('?')[0]} failed ({exc.code}): {detail}") from None
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {}


def app_token(directory_id: str) -> str:
    cid, secret = _client()
    form = urllib.parse.urlencode(
        {
            "client_id": cid,
            "client_secret": secret,
            "grant_type": "client_credentials",
            "scope": "https://graph.microsoft.com/.default",
        }
    ).encode()
    data = _request(
        "POST",
        f"{LOGIN}/{urllib.parse.quote(directory_id)}/oauth2/v2.0/token",
        raw=form,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    token = data.get("access_token")
    if not token:
        raise IntuneError("Entra did not return a token. Re-run Connect Intune.")
    return token


def _wait_file(token: str, file_url: str, want: str, timeout: int = 120) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        f = _request("GET", file_url, token=token)
        state = f.get("uploadState") or ""
        if state == want:
            return f
        if state.endswith("Failed") or state.endswith("TimedOut"):
            raise IntuneError(f"Intune upload stopped at {state}.")
        time.sleep(3)
    raise IntuneError(f"Intune did not reach {want} in {timeout}s.")


def _find_app(token: str, display_name: str) -> str | None:
    q = urllib.parse.quote(f"displayName eq '{display_name.replace(chr(39), chr(39) * 2)}'")
    data = _request("GET", f"{GRAPH}/deviceAppManagement/mobileApps?$filter={q}", token=token)
    for app in data.get("value") or []:
        if app.get("@odata.type") == "#microsoft.graph.win32LobApp":
            return app.get("id")
    return None


def _app_body(display_name: str, description: str) -> dict:
    return {
        "@odata.type": "#microsoft.graph.win32LobApp",
        "displayName": display_name,
        "description": description,
        "publisher": "GlowOps",
        "fileName": "GlowOpsAgent.intunewin",
        "setupFilePath": "Install.ps1",
        "installCommandLine": INSTALL_COMMAND,
        "uninstallCommandLine": UNINSTALL_COMMAND,
        "applicableArchitectures": "x64,x86",
        "minimumSupportedOperatingSystem": {"v10_1607": True},
        "installExperience": {"runAsAccount": "system", "deviceRestartBehavior": "suppress"},
        "rules": [
            {
                "@odata.type": "#microsoft.graph.win32LobAppPowerShellScriptRule",
                "ruleType": "detection",
                "enforceSignatureCheck": False,
                "runAs32Bit": False,
                "scriptContent": base64.b64encode(DETECT_PS1.encode("utf-8")).decode("ascii"),
                "operationType": "notConfigured",
                "operator": "notConfigured",
            }
        ],
        "returnCodes": [
            {"returnCode": 0, "type": "success"},
            {"returnCode": 1707, "type": "success"},
            {"returnCode": 3010, "type": "softReboot"},
            {"returnCode": 1641, "type": "hardReboot"},
            {"returnCode": 1618, "type": "retry"},
        ],
    }


def deploy_win32(directory_id: str, *, business_name: str, win: IntuneWin, expires: str,
                 assign: str = "none", group_id: str = "") -> dict[str, Any]:
    """Create or refresh the GlowOps Win32 app in the customer's Intune.

    Re-deploying keeps the same app and swaps its content, so devices that already
    passed detection are left alone and new devices get the fresh join key.
    """
    token = app_token(directory_id)
    display_name = f"GlowOps Agent - {business_name}"[:120]
    description = (
        f"Joins devices to {business_name} in GlowOps. Join key inside expires {expires}. "
        "Pushed from the GlowOps partner console."
    )
    app_id = _find_app(token, display_name)
    created = app_id is None
    if created:
        app = _request("POST", f"{GRAPH}/deviceAppManagement/mobileApps", token=token,
                       body=_app_body(display_name, description))
        app_id = app.get("id")
        if not app_id:
            raise IntuneError("Intune did not return an app id.")

    app_url = f"{GRAPH}/deviceAppManagement/mobileApps/{app_id}"
    lob = f"{app_url}/microsoft.graph.win32LobApp"
    version = _request("POST", f"{lob}/contentVersions", token=token, body={})
    vid = version.get("id")
    file_meta = _request(
        "POST",
        f"{lob}/contentVersions/{vid}/files",
        token=token,
        body={
            "@odata.type": "#microsoft.graph.mobileAppContentFile",
            "name": "IntunePackage.intunewin",
            "size": win.unencrypted_size,
            "sizeEncrypted": len(win.encrypted),
            "manifest": None,
            "isDependency": False,
        },
    )
    file_url = f"{lob}/contentVersions/{vid}/files/{file_meta.get('id')}"
    sas = _wait_file(token, file_url, "azureStorageUriRequestSuccess").get("azureStorageUri")
    if not sas:
        raise IntuneError("Intune did not return an upload URL.")

    block_ids = []
    for i in range(0, len(win.encrypted), BLOCK_SIZE):
        bid = base64.b64encode(f"{len(block_ids):04d}".encode()).decode()
        _request("PUT", f"{sas}&comp=block&blockid={urllib.parse.quote(bid)}",
                 raw=win.encrypted[i:i + BLOCK_SIZE], headers={"x-ms-blob-type": "BlockBlob"}, timeout=120)
        block_ids.append(bid)
    block_list = (
        '<?xml version="1.0" encoding="utf-8"?><BlockList>'
        + "".join(f"<Latest>{b}</Latest>" for b in block_ids)
        + "</BlockList>"
    ).encode()
    _request("PUT", f"{sas}&comp=blocklist", raw=block_list, headers={"Content-Type": "application/xml"})

    _request("POST", f"{file_url}/commit", token=token, body={"fileEncryptionInfo": win.encryption_info})
    _wait_file(token, file_url, "commitFileSuccess")
    _request("PATCH", app_url, token=token, body={
        "@odata.type": "#microsoft.graph.win32LobApp",
        "committedContentVersion": vid,
        "description": description,
    })

    assigned = None
    if assign in ("all", "group"):
        if assign == "group" and not group_id:
            raise IntuneError("Group id required to assign to a group.")
        target = (
            {"@odata.type": "#microsoft.graph.allDevicesAssignmentTarget"}
            if assign == "all"
            else {"@odata.type": "#microsoft.graph.groupAssignmentTarget", "groupId": group_id}
        )
        _request("POST", f"{app_url}/assign", token=token, body={
            "mobileAppAssignments": [
                {
                    "@odata.type": "#microsoft.graph.mobileAppAssignment",
                    "intent": "required",
                    "target": target,
                    "settings": {
                        "@odata.type": "#microsoft.graph.win32LobAppAssignmentSettings",
                        "notifications": "hideAll",
                        "deliveryOptimizationPriority": "notConfigured",
                    },
                }
            ]
        })
        assigned = "All devices" if assign == "all" else f"Group {group_id}"

    return {
        "appId": app_id,
        "created": created,
        "assigned": assigned,
        "portalUrl": f"https://intune.microsoft.com/#view/Microsoft_Intune_Apps/SettingsMenu/~/0/appId/{app_id}",
    }
