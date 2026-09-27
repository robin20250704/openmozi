@echo off
REM ASCII-only on purpose: cmd.exe parses this file with the console code page,
REM so non-ASCII comments turn into "not recognized as a command" errors (L-113).
REM Usage: start.bat   (listens on 127.0.0.1:53112; override with TIANGONG_PORT)
node "%~dp0business-server.mjs"
