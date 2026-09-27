@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  openmozi multi-agent deploy (one click / double click)
rem    Agents: Junwuyou (junwuyou) + Yuanyi Electronics (yuanyi)
rem            + Tiangong PLM assistant (tiangong)
rem    Steps : build -> syntax check -> gateway -> yuanyi backend
rem            -> tiangong backend -> health assertions -> status summary
rem
rem  Usage (this .bat is ASCII-only on purpose: cmd.exe decodes .bat
rem  with the console code page, so non-ASCII text here would break):
rem    deploy-agents.bat            full deploy (with build)
rem    deploy-agents.bat status     show current state only (read-only)
rem    deploy-agents.bat fast       skip build (restart only)
rem    deploy-agents.bat yuanyi     ensure yuanyi-related services are up
rem    deploy-agents.bat tiangong   ensure tiangong PLM services are up
rem    deploy-agents.bat junwuyou   restart gateway only
rem  Web UI: gateway root = default agent (junwuyou)
rem          http://127.0.0.1:33000/tiangong = Tiangong PLM assistant
rem  Full options: powershell -File deploy-agents.ps1 -h
rem ============================================================
set SCRIPT=%~dp0deploy-agents.ps1
set MODE=%~1

if /i "%MODE%"=="status"   goto :status
if /i "%MODE%"=="fast"     goto :fast
if /i "%MODE%"=="yuanyi"   goto :yuanyi
if /i "%MODE%"=="tiangong" goto :tiangong
if /i "%MODE%"=="junwuyou" goto :junwuyou
goto :default

:status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Status
goto :end

:fast
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -SkipBuild
goto :end

:yuanyi
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Only yuanyi
goto :end

:tiangong
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Only tiangong
goto :end

:junwuyou
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Only junwuyou
goto :end

:default
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
goto :end

:end
echo.
pause
