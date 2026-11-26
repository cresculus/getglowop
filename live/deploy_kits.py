"""Per-business deploy packages: Intune (.intunewin), RMM script, single-device installer.

Every package carries a join key minted for that one business at download time.
The agent EXE is not bundled; Install.ps1 pulls it from the dashboard's download route.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import os
import re
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

CHANNELS = ("intune", "rmm", "device")
DEFAULT_TTL_HOURS = {"intune": 24 * 30, "rmm": 24 * 30, "device": 24 * 7}

INSTALL_COMMAND = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File Install.ps1"
UNINSTALL_COMMAND = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File Uninstall.ps1"

INSTALL_PS1 = r"""#Requires -Version 5.1
<#
  GlowOps Agent installer for __BUSINESS__.
  Joins this device to that business. Run as SYSTEM or an administrator.

  Credentials come from, in order: the values below, glowops.join.json next to
  this script, or GLOWOPS_URL / GLOWOPS_JOIN_KEY / GLOWOPS_JOIN_PASSWORD.
  Join key expires __EXPIRES__. Devices that joined keep reporting after that.
#>
[CmdletBinding()]
param(
  [string]$DashboardUrl = '__URL__',
  [string]$JoinKey = '__JOIN_KEY__',
  [string]$JoinPassword = '__JOIN_PASSWORD__',
  [int]$IntervalHours = 6,
  [int]$HeartbeatMinutes = 15,
  [string]$InstallDir = "C:\ProgramData\GlowOps"
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Run as SYSTEM or an administrator." }

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
try { Start-Transcript -Path (Join-Path $InstallDir "install.log") -Append | Out-Null } catch {}

$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }

$sidecar = if ($here) { Join-Path $here "glowops.join.json" } else { "" }
if ($sidecar -and (Test-Path -LiteralPath $sidecar)) {
  $enroll = Get-Content -LiteralPath $sidecar -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $JoinKey -and $enroll.joinKey) { $JoinKey = [string]$enroll.joinKey }
  if (-not $JoinPassword -and $enroll.joinPassword) { $JoinPassword = [string]$enroll.joinPassword }
  if ($enroll.url) { $DashboardUrl = [string]$enroll.url }
}
if (-not $JoinKey -and $env:GLOWOPS_JOIN_KEY) { $JoinKey = $env:GLOWOPS_JOIN_KEY }
if (-not $JoinPassword -and $env:GLOWOPS_JOIN_PASSWORD) { $JoinPassword = $env:GLOWOPS_JOIN_PASSWORD }
if ($env:GLOWOPS_URL) { $DashboardUrl = $env:GLOWOPS_URL }
if (-not $DashboardUrl) { $DashboardUrl = "https://getglowop.com" }

$JoinKey = ([string]$JoinKey).Trim()
$DashboardUrl = ([string]$DashboardUrl).Trim().TrimEnd('/')
if (-not $JoinKey) { throw "Join key missing." }
if (-not $JoinPassword) { throw "Join password missing." }

$exeDst = Join-Path $InstallDir "GlowOpsAgent.exe"
$exeSrc = if ($here) { Join-Path $here "GlowOpsAgent.exe" } else { "" }
if ($exeSrc -and (Test-Path -LiteralPath $exeSrc)) {
  Copy-Item -LiteralPath $exeSrc -Destination $exeDst -Force
} else {
  Write-Host "Downloading GlowOps Agent from $DashboardUrl"
  $tmp = Join-Path $InstallDir "GlowOpsAgent.download"
  Invoke-WebRequest -Uri "$DashboardUrl/download/GlowOpsAgent.exe" -OutFile $tmp -UseBasicParsing
  if ((Get-Item -LiteralPath $tmp).Length -lt 1MB) { throw "Agent download looks wrong (too small)." }
  Move-Item -LiteralPath $tmp -Destination $exeDst -Force
}
Unblock-File -LiteralPath $exeDst -ErrorAction SilentlyContinue

$joinPath = Join-Path $InstallDir "glowops.join.json"
$join = [ordered]@{
  url          = $DashboardUrl
  joinKey      = $JoinKey
  joinPassword = $JoinPassword
  installedAt  = (Get-Date).ToUniversalTime().ToString("o")
  source       = "__SOURCE__"
}
[IO.File]::WriteAllText($joinPath, ($join | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
try {
  icacls $joinPath /inheritance:r | Out-Null
  icacls $joinPath /grant:r "SYSTEM:(F)" "Administrators:(F)" | Out-Null
} catch {
  Write-Warning "Could not tighten ACL on glowops.join.json: $($_.Exception.Message)"
}

Write-Host "Joining this device to __BUSINESS__"
$p = Start-Process -FilePath $exeDst -ArgumentList @(
  "join", "--url", $DashboardUrl, "--join-key", $JoinKey, "--password", $JoinPassword, "--quiet"
) -Wait -PassThru -NoNewWindow
if ($p.ExitCode -ne 0) { throw "GlowOps join failed with exit code $($p.ExitCode). The key may be expired or revoked." }

$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
function Register-GlowOpsTask([string]$Name, [string]$Argument, [TimeSpan]$Every, [int]$DelayMinutes) {
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
  $action = New-ScheduledTaskAction -Execute $exeDst -Argument $Argument
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes($DelayMinutes) `
    -RepetitionInterval $Every -RepetitionDuration ([TimeSpan]::MaxValue)
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}
Register-GlowOpsTask -Name "GlowOpsInventory" -Argument "inventory --quiet" -Every (New-TimeSpan -Hours $IntervalHours) -DelayMinutes 5
Register-GlowOpsTask -Name "GlowOpsHeartbeat" -Argument "heartbeat --quiet" -Every (New-TimeSpan -Minutes $HeartbeatMinutes) -DelayMinutes 2

$marker = [ordered]@{
  url              = $DashboardUrl
  business         = "__BUSINESS_ID__"
  joinKeyPrefix    = $JoinKey.Substring(0, [Math]::Min(8, $JoinKey.Length))
  installedAt      = (Get-Date).ToUniversalTime().ToString("o")
  inventoryHours   = $IntervalHours
  heartbeatMinutes = $HeartbeatMinutes
}
[IO.File]::WriteAllText((Join-Path $InstallDir "config.json"), ($marker | ConvertTo-Json), [Text.UTF8Encoding]::new($false))

Write-Host "GlowOps Agent installed and joined to __BUSINESS__"
try { Stop-Transcript | Out-Null } catch {}
exit 0
"""

UNINSTALL_PS1 = r"""#Requires -Version 5.1
$ErrorActionPreference = "Stop"
Unregister-ScheduledTask -TaskName "GlowOpsInventory" -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "GlowOpsHeartbeat" -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item "C:\ProgramData\GlowOps" -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "GlowOps Agent removed."
exit 0
"""

DETECT_PS1 = r"""#Requires -Version 5.1
$ErrorActionPreference = "SilentlyContinue"
$cfg = "C:\ProgramData\GlowOps\config.json"
$exe = "C:\ProgramData\GlowOps\GlowOpsAgent.exe"
$task = Get-ScheduledTask -TaskName "GlowOpsInventory" -ErrorAction SilentlyContinue
if (-not (Test-Path $cfg) -or -not (Test-Path $exe) -or -not $task) { exit 1 }
Write-Output "GlowOps Agent present"
exit 0
"""

DEVICE_CMD = """@echo off
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo Installing GlowOps Agent for __BUSINESS__ ...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1"
if errorlevel 1 (
  echo.
  echo Install failed. See C:\\ProgramData\\GlowOps\\install.log
) else (
  echo.
  echo Done. This PC now reports to __BUSINESS__.
)
pause
"""


def slug(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", name or "").strip("-")
    return (s or "Business")[:40]


def _ps_literal(value: str) -> str:
    return (value or "").replace("'", "''")


def _fill(template: str, *, business_name: str, business_id: str, expires: str,
          url: str = "", key: str = "", password: str = "", source: str = "") -> str:
    safe_name = re.sub(r"[\r\n\"`$<>]", "", business_name or "this business")
    return (
        template.replace("__URL__", _ps_literal(url))
        .replace("__JOIN_KEY__", _ps_literal(key))
        .replace("__JOIN_PASSWORD__", _ps_literal(password))
        .replace("__BUSINESS_ID__", re.sub(r"[^A-Za-z0-9_\-]", "", business_id))
        .replace("__BUSINESS__", safe_name)
        .replace("__EXPIRES__", expires)
        .replace("__SOURCE__", source)
    )


def _crlf(text: str) -> bytes:
    return text.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8")


def _join_json(minted: dict, source: str) -> bytes:
    return json.dumps(
        {
            "url": minted["dashboardUrl"],
            "joinKey": minted["joinKey"],
            "joinPassword": minted["joinPassword"],
            "businessId": minted["businessId"],
            "expiresAt": minted["expiresAt"],
            "packagedAt": datetime.now(timezone.utc).isoformat(),
            "source": source,
        },
        indent=2,
    ).encode("utf-8")


def payload_files(minted: dict, business_name: str, source: str) -> dict[str, bytes]:
    """Install/Uninstall/Detect + join file. Credentials live in the sidecar, not the script."""
    install = _fill(
        INSTALL_PS1,
        business_name=business_name,
        business_id=minted["businessId"],
        expires=minted["expiresAt"][:10],
        source=source,
    )
    return {
        "Install.ps1": _crlf(install),
        "Uninstall.ps1": _crlf(UNINSTALL_PS1),
        "Detect.ps1": _crlf(DETECT_PS1),
        "glowops.join.json": _join_json(minted, source),
    }


def rmm_script(minted: dict, business_name: str) -> bytes:
    text = _fill(
        INSTALL_PS1,
        business_name=business_name,
        business_id=minted["businessId"],
        expires=minted["expiresAt"][:10],
        url=minted["dashboardUrl"],
        key=minted["joinKey"],
        password=minted["joinPassword"],
        source="rmm",
    )
    return _crlf(text)


def device_zip(minted: dict, business_name: str) -> bytes:
    folder = f"GlowOps-{slug(business_name)}"
    files = payload_files(minted, business_name, "device")
    files.pop("Detect.ps1", None)
    files["Install GlowOps.cmd"] = _crlf(DEVICE_CMD.replace("__BUSINESS__", re.sub(r"[\r\n\"%&|<>^]", "", business_name)))
    files["README.txt"] = _crlf(
        f"GlowOps Agent for {business_name}\n\n"
        "1. Unzip this folder.\n"
        "2. Double-click \"Install GlowOps.cmd\" and approve the admin prompt.\n"
        "3. The PC downloads the agent, joins this business, and starts reporting.\n\n"
        f"This package works until {minted['expiresAt'][:10]}. Download a fresh one after that.\n"
        "glowops.join.json holds the join password. Do not email or post this folder.\n"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(f"{folder}/{name}", data)
    return buf.getvalue()


@dataclass
class IntuneWin:
    package: bytes
    encrypted: bytes
    unencrypted_size: int
    encryption_info: dict
    setup_file: str


def build_intunewin(files: dict[str, bytes], setup_file: str = "Install.ps1") -> IntuneWin:
    """Same layout Microsoft's Win32 Content Prep Tool writes.

    Inner zip of the files, AES-256-CBC with a random key and IV, HMAC-SHA256 over
    IV + ciphertext stored in the first 32 bytes, keys in Metadata/Detection.xml.
    """
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    plain = inner.getvalue()

    enc_key, mac_key, iv = os.urandom(32), os.urandom(32), os.urandom(16)
    padder = padding.PKCS7(128).padder()
    padded = padder.update(plain) + padder.finalize()
    encryptor = Cipher(algorithms.AES(enc_key), modes.CBC(iv)).encryptor()
    body = iv + encryptor.update(padded) + encryptor.finalize()
    mac = hmac.new(mac_key, body, hashlib.sha256).digest()
    encrypted = mac + body

    b64 = lambda b: base64.b64encode(b).decode("ascii")  # noqa: E731
    info = {
        "encryptionKey": b64(enc_key),
        "macKey": b64(mac_key),
        "initializationVector": b64(iv),
        "mac": b64(mac),
        "profileIdentifier": "ProfileVersion1",
        "fileDigest": b64(hashlib.sha256(plain).digest()),
        "fileDigestAlgorithm": "SHA256",
    }
    detection = (
        '<ApplicationInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ToolVersion="1.8.6.0">\r\n'
        f"  <Name>{setup_file}</Name>\r\n"
        f"  <UnencryptedContentSize>{len(plain)}</UnencryptedContentSize>\r\n"
        "  <FileName>IntunePackage.intunewin</FileName>\r\n"
        f"  <SetupFile>{setup_file}</SetupFile>\r\n"
        "  <EncryptionInfo>\r\n"
        f"    <EncryptionKey>{info['encryptionKey']}</EncryptionKey>\r\n"
        f"    <MacKey>{info['macKey']}</MacKey>\r\n"
        f"    <InitializationVector>{info['initializationVector']}</InitializationVector>\r\n"
        f"    <Mac>{info['mac']}</Mac>\r\n"
        "    <ProfileIdentifier>ProfileVersion1</ProfileIdentifier>\r\n"
        f"    <FileDigest>{info['fileDigest']}</FileDigest>\r\n"
        "    <FileDigestAlgorithm>SHA256</FileDigestAlgorithm>\r\n"
        "  </EncryptionInfo>\r\n"
        "</ApplicationInfo>"
    ).encode("utf-8")

    outer = io.BytesIO()
    with zipfile.ZipFile(outer, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("IntuneWinPackage/Contents/IntunePackage.intunewin", encrypted)
        zf.writestr("IntuneWinPackage/Metadata/Detection.xml", detection)
    return IntuneWin(outer.getvalue(), encrypted, len(plain), info, setup_file)


def intune_bundle(minted: dict, business_name: str) -> tuple[bytes, IntuneWin]:
    files = payload_files(minted, business_name, "intune")
    win = build_intunewin(files)
    name = slug(business_name)
    settings = (
        f"GlowOps Agent for {business_name}, Intune Win32 app\n\n"
        "Apps > Windows > Add > Windows app (Win32), then upload GlowOpsAgent.intunewin.\n\n"
        f"Install command:    {INSTALL_COMMAND}\n"
        f"Uninstall command:  {UNINSTALL_COMMAND}\n"
        "Install behavior:   System\n"
        "Restart:            No specific action\n"
        "Requirements:       Windows 10 1607+, 64-bit and 32-bit\n"
        "Detection rules:    Use a custom detection script, upload Detect.ps1 from this folder\n"
        "Assignments:        Required, to the device group you want reporting\n\n"
        f"The join key inside expires {minted['expiresAt'][:10]}. Devices that joined keep reporting.\n"
        "For devices added after that, download a fresh package and replace the app content.\n"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"GlowOps-{name}-Intune/GlowOpsAgent.intunewin", win.package)
        zf.writestr(f"GlowOps-{name}-Intune/Detect.ps1", _crlf(DETECT_PS1))
        zf.writestr(f"GlowOps-{name}-Intune/INTUNE-SETTINGS.txt", _crlf(settings))
    return buf.getvalue(), win
