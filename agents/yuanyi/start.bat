@echo off
chcp 65001 >nul
cd /d %~dp0
echo 启动元一电子业务后端（回环 127.0.0.1:53100）...
node business-server.mjs
pause
