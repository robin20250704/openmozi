@echo off
chcp 65001 >nul
rem ============================================================
rem  AI customer-service entry "Xiaotian" - one-key launcher
rem   1) start Xiaotian (openmozi gateway 33000 + KB backend 53112)
rem   2) start local relay 33030 (for WSL containers / UAT tunnel)
rem   3) build + self-check the reverse SSH tunnel to UAT
rem   4) print local / LAN / public egress IP (IP changes must be visible)
rem
rem  Usage: double-click = full one-key bring-up. Or pass an argument:
rem    start-tiangong.bat status               status only (no changes)
rem    start-tiangong.bat tunnel-only          rebuild the UAT tunnel only
rem    start-tiangong.bat local-only           local machine only (no UAT)
rem    start-tiangong.bat install-autostart    register auto-reconnect task (admin)
rem    start-tiangong.bat uninstall-autostart  remove that scheduled task
rem
rem  NOTE: this file is deliberately pure ASCII.
rem    Why (measured 2026-09-28): cmd.exe parses .bat line by line using the
rem    OEM code page. UTF-8 Chinese bytes inside a "rem" line get re-read as
rem    GBK, the line no longer parses as a comment, and cmd tries to EXECUTE
rem    the garbage - the user sees e.g.
rem        '<garbled>' is not recognized as an internal or external command
rem    and (with @echo off) no clue which line caused it.
rem    So: keep every byte here < 0x80. Chinese help text lives in the
rem    PowerShell script (start-tiangong.ps1), which is UTF-8 with BOM and
rem    therefore decoded correctly by powershell.exe.
rem ============================================================
setlocal
set PS1=%~dp0start-tiangong.ps1

if /i "%~1"=="status"              goto :status
if /i "%~1"=="tunnel-only"         goto :tunnelonly
if /i "%~1"=="local-only"          goto :localonly
if /i "%~1"=="install-autostart"   goto :install
if /i "%~1"=="uninstall-autostart" goto :uninstall
goto :default

:status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Status
goto :end

:tunnelonly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -TunnelOnly
goto :end

:localonly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -SkipTunnel
goto :end

:install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -TunnelOnly -InstallAutoStart
goto :end

:uninstall
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -UninstallAutoStart
goto :end

:default
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
goto :end

:end
echo.
pause
endlocal
