#!/usr/bin/env bash
# ==========================================================================
# uat-bridge-call.sh —— 把值安全地交给 uat-bridge.sh（**由脚本生成**，不进仓库）
#
# 为什么需要"生成一个脚本"这种笨办法（2026-09-27 实测，两轮踩坑的结论）：
#   ① 环境变量不可靠：PowerShell `Set-Item env:…` 后调 wsl.exe，WSL 侧读到空值
#      （明明 PowerShell 侧有值）⇒ 报"缺少 UAT_IP"，且错误被 wsl 启动告警盖住。
#   ② 命令行参数也不可靠：**wsl.exe 会把参数拼成一条 shell 命令**再交给 bash，
#      于是含特殊字符的口令（实测 UAT root 口令里有 `(`）直接把 bash 语法打崩：
#      `bash: -c: line 1: syntax error near unexpected token '('`。
#
# 结论：口令这类"含任意字符的值"必须**以带引号的赋值语句形式写进一个文件**，再执行该文件。
#   —— 本脚本就是这个"文件"的模板：${UAT_PWD_Q} 等占位符由调用方替换成**已单引号转义**的字面量。
#   （占位符写法刻意用 ${…} 而不是 heredoc，避免模板自身被 shell 提前展开。）
#
# 调用方（start-tiangong.ps1）负责：
#   · 把值做 shell 单引号转义（' → '\''）后填入；
#   · 把生成的文件放在状态目录（已被 .gitignore 覆盖），执行完立即删除；
#   · 不把口令写进日志。
# ==========================================================================
set -uo pipefail
# 只导出"调用方确实给了值"的变量。
# 为什么必须加这层判断（2026-09-27 实测）：早先无条件 `export KEY_FILE=${KEY_FILE_Q}`，
# 当调用方没传该键时，模板占位符（形如 ${KEY_FILE_Q}）会被原样留下 ⇒ 变成**非空的字面量**
# ⇒ uat-bridge.sh 里 `[ -n "${KEY_FILE:-}" ]` 判定为已提供，转而检查文件是否存在，
# 结果报「缺少 KEY_FILE」，看起来像参数没传，实际是我把占位符当成了值。
# 这属于"空值 vs 未提供"被混淆的通用形态：未提供就不能导出，否则下游无法区分。
# 判据：值为空、或仍是未替换的占位符（以 ${ 开头、以 _Q} 结尾）⇒ 一律视为未提供。
set_if_given() {
  local _name="$1" _val="$2"
  # 调用方用哨兵 __UNSET__ 表示"这个键没给"（为什么不直接留空或留占位符：
  #   留空 ⇒ 下游无法区分"没给"和"给了空"；留形如 ${KEY_FILE_Q} 的占位符 ⇒ 本文件开 `set -u`，
  #   那不是变量而是**未定义变量**，bash 直接报 unbound variable 退出——实测踩过）。
  [ -n "$_val" ] || return 0
  [ "$_val" = "__UNSET__" ] && return 0
  case "$_val" in
    '${'*'_Q}') return 0 ;;
  esac
  export "$_name=$_val"
}
# 注意每个取值都写成 ${X:-}：本文件开 `set -u`，而"未提供"时**变量根本不存在**
# （生成器保留占位符就是为了这个）⇒ 直接写 ${KEY_FILE_Q} 会触发 unbound variable 直接退出。
# `:-` 把"未定义"归一成空串，再由 set_if_given 区分"未提供"，语义更清楚。
set_if_given UAT_IP       "${UAT_IP_Q:-}"
set_if_given UAT_PWD      "${UAT_PWD_Q:-}"
set_if_given KEY_FILE     "${KEY_FILE_Q:-}"
set_if_given KEY_FILE_PUB "${KEY_FILE_PUB_Q:-}"
set_if_given RELAY_PORT   "${RELAY_PORT_Q:-}"
exec bash ${BRIDGE_Q} ${ACTION_Q}
