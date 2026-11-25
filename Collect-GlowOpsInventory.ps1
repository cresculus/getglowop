#Requires -Version 5.1
<#
.SYNOPSIS
  GlowOps one-shot Windows inventory collector (no MDM required).

.DESCRIPTION
  Reads local hardware/OS signals and writes glowops-inventory.json
  matching packages/glowops-schema. Does not install a service.
#>
[CmdletBinding()]
param(
  [string]$OutDir = (Join-Path $env:USERPROFILE "Desktop"),
  [string]$BusinessId,
  [string]$CustomerId,
  [string]$SiteId,
  [switch]$AlsoCsv,
  [string]$CollectorVersion = "0.1.0"
)

# ConnectWise-style: BusinessId is canonical; CustomerId is a legacy alias.
if (-not $BusinessId -and $CustomerId) { $BusinessId = $CustomerId }
if ($BusinessId -and -not $CustomerId) { $CustomerId = $BusinessId }

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Get-CimSafe {
  param([string]$Class, [string]$Namespace = "root/cimv2", [string]$Filter)
  try {
    if ($Filter) { return @(Get-CimInstance -Namespace $Namespace -ClassName $Class -Filter $Filter -ErrorAction Stop) }
    return @(Get-CimInstance -Namespace $Namespace -ClassName $Class -ErrorAction Stop)
  } catch {
    return @()
  }
}

function Get-Sha256Hex([string]$Text) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
  $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  -join ($hash | ForEach-Object { $_.ToString("x2") })
}

function Convert-WmiDate {
  param($Raw)
  if ($null -eq $Raw -or $Raw -eq "") { return $null }
  # Get-CimInstance returns System.DateTime; Get-WmiObject returns DMTF strings.
  if ($Raw -is [datetime]) {
    return ([datetime]$Raw).ToUniversalTime().ToString("o")
  }
  $text = [string]$Raw
  if (-not $text) { return $null }
  try {
    return [System.Management.ManagementDateTimeConverter]::ToDateTime($text).ToUniversalTime().ToString("o")
  } catch {
    try { return ([datetime]::Parse($text, [Globalization.CultureInfo]::InvariantCulture)).ToUniversalTime().ToString("o") }
    catch {
      try { return ([datetime]::Parse($text)).ToUniversalTime().ToString("o") }
      catch { return $null }
    }
  }
}

function Test-IsElevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Path -LiteralPath $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$cs = Get-CimSafe Win32_ComputerSystem | Select-Object -First 1
$bios = Get-CimSafe Win32_BIOS | Select-Object -First 1
$bb = Get-CimSafe Win32_BaseBoard | Select-Object -First 1
$os = Get-CimSafe Win32_OperatingSystem | Select-Object -First 1
$enclosure = Get-CimSafe Win32_SystemEnclosure | Select-Object -First 1
$diskDrives = Get-CimSafe Win32_DiskDrive
$logical = Get-CimSafe Win32_LogicalDisk -Filter "DriveType=3"
$batteries = Get-CimSafe Win32_Battery
$tpm = Get-CimSafe -Namespace "root/cimv2/Security/MicrosoftTpm" -Class Win32_Tpm | Select-Object -First 1
$nic = @(Get-CimSafe Win32_NetworkAdapterConfiguration -Filter "IPEnabled=TRUE") |
  Where-Object { $_.MACAddress } |
  Select-Object -First 1

# Prefer Win32_ComputerSystemProduct UUID / IdentifyingNumber for serial quality
$csp = Get-CimSafe Win32_ComputerSystemProduct | Select-Object -First 1

$manufacturer = [string]($cs.Manufacturer)
$model = [string]($cs.Model)
if (-not $model -and $csp) { $model = [string]$csp.Name }
$serial = $null
foreach ($candidate in @($bios.SerialNumber, $csp.IdentifyingNumber, $bb.SerialNumber)) {
  $c = ([string]$candidate).Trim()
  if ($c -and $c -notmatch '(?i)^(To be filled|None|Default string|System Serial Number|System Serial|0+|N/?A)$') {
    $serial = $c
    break
  }
}

$machineGuid = $null
try {
  $machineGuid = (Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Cryptography" -Name MachineGuid -ErrorAction Stop).MachineGuid
} catch { }

$deviceKeySeed = if ($serial) {
  ("{0}|{1}" -f $manufacturer.ToLowerInvariant(), $serial.ToLowerInvariant())
} else {
  ("guid|{0}" -f $machineGuid)
}
$deviceKey = Get-Sha256Hex $deviceKeySeed

$chassisMap = @{
  3 = "Desktop"; 4 = "Low Profile Desktop"; 6 = "Mini Tower"; 7 = "Tower"
  8 = "Portable"; 9 = "Laptop"; 10 = "Notebook"; 11 = "Hand Held"
  14 = "Sub Notebook"; 15 = "Space-saving"; 31 = "Convertible"; 32 = "Detachable"
}
$chassis = $null
if ($enclosure -and $enclosure.ChassisTypes) {
  $code = @($enclosure.ChassisTypes)[0]
  if ($chassisMap.ContainsKey([int]$code)) { $chassis = $chassisMap[[int]$code] }
  else { $chassis = "Type $code" }
}

$lastUser = $null
try {
  $lastUser = (Get-CimSafe Win32_ComputerSystem | Select-Object -First 1).UserName
} catch { }
if (-not $lastUser) {
  try { $lastUser = $env:USERDOMAIN + "\" + $env:USERNAME } catch { }
}

$pendingReboot = $null
try {
  $pendingReboot = [bool](
    (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending") -or
    (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired")
  )
} catch { $pendingReboot = $null }

$storage = @()
foreach ($d in $diskDrives) {
  $pred = $null
  try {
    $status = Get-CimSafe -Namespace "root/wmi" -Class MSStorageDriver_FailurePredictStatus -Filter ("InstanceName LIKE '%{0}%'" -f ($d.PNPDeviceID -replace '\\','\\'))
    if ($status -and $status[0].PredictFailure -ne $null) { $pred = [bool]$status[0].PredictFailure }
  } catch { }
  $storage += [ordered]@{
    name              = [string]$d.Model
    mediaType         = [string]$d.MediaType
    busType           = [string]$d.InterfaceType
    sizeBytes         = if ($d.Size) { [int64]$d.Size } else { $null }
    predictiveFailure = $pred
  }
}

# Prefer Get-PhysicalDisk media type when available
try {
  $phys = @(Get-PhysicalDisk -ErrorAction Stop)
  if ($phys.Count -gt 0) {
    $storage = @()
    foreach ($p in $phys) {
      $storage += [ordered]@{
        name              = [string]$p.FriendlyName
        mediaType         = [string]$p.MediaType
        busType           = [string]$p.BusType
        sizeBytes         = if ($p.Size) { [int64]$p.Size } else { $null }
        predictiveFailure = if ($p.HealthStatus) { $p.HealthStatus -ne "Healthy" } else { $null }
      }
    }
  }
} catch { }

$volumes = @()
foreach ($v in $logical) {
  $volumes += [ordered]@{
    drive      = [string]$v.DeviceID
    fileSystem = [string]$v.FileSystem
    sizeBytes  = if ($v.Size) { [int64]$v.Size } else { $null }
    freeBytes  = if ($v.FreeSpace) { [int64]$v.FreeSpace } else { $null }
  }
}

$battery = $null
if ($batteries -and $batteries.Count -gt 0) {
  $designed = 0.0
  $full = 0.0
  foreach ($b in $batteries) {
    # Win32_Battery DesignCapacity / FullChargeCapacity are often mWh or relative; also try BatteryStaticData
    if ($b.DesignCapacity) { $designed += [double]$b.DesignCapacity }
    if ($b.FullChargeCapacity) { $full += [double]$b.FullChargeCapacity }
  }
  # MSBatteryClass sometimes richer
  try {
    $static = Get-CimSafe -Namespace "root/wmi" -Class BatteryStaticData
    $fullData = Get-CimSafe -Namespace "root/wmi" -Class BatteryFullChargedCapacity
    if ($static) {
      $designed = 0.0
      foreach ($s in $static) { if ($s.DesignedCapacity) { $designed += [double]$s.DesignedCapacity } }
    }
    if ($fullData) {
      $full = 0.0
      foreach ($f in $fullData) { if ($f.FullChargedCapacity) { $full += [double]$f.FullChargedCapacity } }
    }
  } catch { }

  $health = $null
  if ($designed -gt 0 -and $full -gt 0) {
    $health = [math]::Round(100.0 * $full / $designed, 1)
    if ($health -gt 100) { $health = 100.0 }
  } elseif ($batteries[0].EstimatedChargeRemaining -ne $null) {
    # last resort: charge remaining is not health, leave health null and note it
    $health = $null
  }

  $battery = [ordered]@{
    present                 = $true
    healthPercent           = $health
    designedCapacityMWh     = if ($designed -gt 0) { $designed } else { $null }
    fullChargeCapacityMWh   = if ($full -gt 0) { $full } else { $null }
    cycleCount              = $null
  }
} else {
  $battery = [ordered]@{ present = $false; healthPercent = $null; designedCapacityMWh = $null; fullChargeCapacityMWh = $null; cycleCount = $null }
}

$bitlocker = $null
try {
  if (Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue) {
    $sys = Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction SilentlyContinue
    if ($sys) { $bitlocker = $sys.ProtectionStatus -eq "On" }
  }
} catch { }

$notes = @()
if (-not $serial) { $notes += "Serial number unavailable; deviceKey uses MachineGuid fallback." }
if ($battery.present -and $null -eq $battery.healthPercent) { $notes += "Battery present but health percent could not be computed." }
if ($battery.present -and $battery.healthPercent -ne $null -and [double]$battery.healthPercent -lt 70) {
  $notes += ("Battery health {0}% — repair candidate before refresh." -f $battery.healthPercent)
}
foreach ($s in $storage) {
  if ($s.predictiveFailure -eq $true) {
    $notes += ("Disk predictive failure / unhealthy: {0}" -f $s.name)
  }
}
foreach ($v in $volumes) {
  if ($v.sizeBytes -and $v.freeBytes -ne $null -and $v.sizeBytes -gt 0) {
    $pct = 100.0 * [double]$v.freeBytes / [double]$v.sizeBytes
    if ($pct -lt 10) { $notes += ("Low free space on {0}: {1:N1}% free." -f $v.drive, $pct) }
  }
}
if ($pendingReboot -eq $true) { $notes += "Pending reboot (CBS/WU)." }
if ($bitlocker -eq $false) { $notes += "BitLocker protection off on system drive." }

$doc = [ordered]@{
  schemaVersion = "0.1.0"
  collectedAt   = (Get-Date).ToUniversalTime().ToString("o")
  source        = "collector"
  businessId    = $(if ($BusinessId) { $BusinessId } else { $null })
  customerId    = $(if ($CustomerId) { $CustomerId } else { $null })
  siteId        = $(if ($SiteId) { $SiteId } else { $null })
  dashboardSlug = $null
  deviceKey     = $deviceKey
  device        = [ordered]@{
    manufacturer = $manufacturer
    model        = $model
    serialNumber = $serial
    chassis      = $chassis
    biosVersion  = [string]$bios.SMBIOSBIOSVersion
    machineGuid  = $machineGuid
    hostname     = [string]$env:COMPUTERNAME
    domain       = [string]$cs.Domain
  }
  system = [ordered]@{
    osCaption           = [string]$os.Caption
    osVersion           = [string]$os.Version
    osBuild             = [string]$os.BuildNumber
    osInstallDate       = Convert-WmiDate ([string]$os.InstallDate)
    lastInteractiveUser = $lastUser
    pendingReboot       = $pendingReboot
  }
  resources = $(
    $cpu = Get-CimSafe Win32_Processor | Select-Object -First 1
    $cpuLoad = $null
    if ($cpu -and $null -ne $cpu.LoadPercentage) { $cpuLoad = [int]$cpu.LoadPercentage }
    $ramTotalMB = $null; $ramFreeMB = $null; $ramUsedPct = $null
    if ($os -and $os.TotalVisibleMemorySize) {
      $ramTotalMB = [math]::Round([double]$os.TotalVisibleMemorySize / 1024.0, 0)
      if ($null -ne $os.FreePhysicalMemory) {
        $ramFreeMB = [math]::Round([double]$os.FreePhysicalMemory / 1024.0, 0)
        if ($ramTotalMB -gt 0) {
          $ramUsedPct = [math]::Round(100.0 * (1.0 - ([double]$os.FreePhysicalMemory / [double]$os.TotalVisibleMemorySize)), 1)
        }
      }
    }
    [ordered]@{
      cpuName        = if ($cpu) { [string]$cpu.Name.Trim() } else { $null }
      cpuCores       = if ($cpu -and $cpu.NumberOfCores) { [int]$cpu.NumberOfCores } else { $null }
      cpuLogical     = if ($cpu -and $cpu.NumberOfLogicalProcessors) { [int]$cpu.NumberOfLogicalProcessors } else { $null }
      cpuLoadPercent = $cpuLoad
      ramTotalMB     = $ramTotalMB
      ramFreeMB      = $ramFreeMB
      ramUsedPercent = $ramUsedPct
    }
  )
  storage  = $storage
  volumes  = $volumes
  battery  = $battery
  network  = [ordered]@{ primaryMac = if ($nic) { [string]$nic.MACAddress } else { $null } }
  signals  = [ordered]@{
    bitlockerEnabled = $bitlocker
    tpmPresent       = if ($tpm) { $true } else { $null }
    notes            = $notes
  }
  collector = [ordered]@{
    name      = "glowops-collector-win"
    version   = $CollectorVersion
    platform  = "windows"
    elevated  = Test-IsElevated
    hostOs    = [string]$os.Caption
  }
}

$jsonPath = Join-Path $OutDir "glowops-inventory.json"
$json = $doc | ConvertTo-Json -Depth 8
# ConvertTo-Json can mangle ordered depth; force UTF8 no BOM for cross-platform ingest
[IO.File]::WriteAllText($jsonPath, $json, [Text.UTF8Encoding]::new($false))
Write-Host "Wrote $jsonPath"

if ($AlsoCsv) {
  $csvPath = Join-Path $OutDir "glowops-inventory.csv"
  $row = [pscustomobject]@{
    businessId       = $BusinessId
    siteId           = $SiteId
    deviceKey        = $deviceKey
    manufacturer     = $manufacturer
    model            = $model
    serialNumber     = $serial
    hostname         = $env:COMPUTERNAME
    osCaption        = [string]$os.Caption
    batteryHealthPct = $battery.healthPercent
    collectedAt      = $doc.collectedAt
  }
  $row | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
  Write-Host "Wrote $csvPath"
}

exit 0
