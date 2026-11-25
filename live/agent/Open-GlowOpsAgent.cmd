@echo off
title GlowOps Agent
cd /d "%~dp0"
REM Clears Mark-of-the-Web so SmartScreen does not silently block a downloaded EXE.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-ChildItem -LiteralPath '%~dp0' -Include GlowOpsAgent.exe,*.dll -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue"
if not exist "%~dp0GlowOpsAgent.exe" (
  echo GlowOpsAgent.exe not found next to this script.
  pause
  exit /b 1
)
start "" "%~dp0GlowOpsAgent.exe"
exit /b 0
