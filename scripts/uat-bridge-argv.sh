#!/usr/bin/env bash
# ==========================================================================
# uat-bridge-argv.sh —— 把值**当命令行参数**转交给 uat-bridge.sh
#
# 为什么需要这一层（2026-09-27 实测）：
#   从 PowerShell 里 `Set-Item env:UAT_IP …` 再 `wsl.exe bash uat-bridge.sh`，
#   **变量并没有传到 WSL 进程里**（实测 bash 侧读到空值，报"缺少 UAT_IP"；
#   同一时刻 PowerShell 侧 `$env:UAT_IP` 明明有值，且 `Test-Path`/`$LASTEXITCODE` 都正常）。
#   也就是说：这条链路上"设了环境变量"与"子进程收得到"不是同一件事。
#   反之，**命令行参数**是必然到达的（同一个 wsl.exe 调用方式下实测可用）。
#
# 做法：这里只做"参数 → 环境变量"的搬运，然后把真正的逻辑交给 uat-bridge.sh
#      （判定逻辑仍只有一份实现，这一层不掺任何判断）。
#
# 用法：bash uat-bridge-argv.sh <action> [KEY=VALUE ...]
# ==========================================================================
set -uo pipefail

ACTION="${1:-}"
[ -n "$ACTION" ] || { echo "ERR 用法: uat-bridge-argv.sh <action> [KEY=VALUE ...]"; exit 2; }
shift || true

for kv in "$@"; do
  key="${kv%%=*}"
  val="${kv#*=}"
  case "$key" in
    UAT_IP|UAT_PWD|KEY_FILE|KEY_FILE_PUB|RELAY_PORT|PLM_NET) export "$key=$val" ;;
    *) echo "ERR 不接受的参数名（白名单外）：$key"; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
exec bash "$HERE/uat-bridge.sh" "$ACTION"
