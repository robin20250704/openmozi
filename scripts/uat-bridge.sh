#!/usr/bin/env bash
# ==========================================================================
# uat-bridge.sh —— 从 WSL 侧完成"开发机 ↔ UAT"的两件需要口令/网络的事
#
# 为什么单独一个 .sh（而不是在 PowerShell 里拼 bash 串）：
#   本仓已登记的教训 L-840：PowerShell 命令串里的 `$` 会被 PowerShell 抢先插值
#   （**单引号也不免疫**），结果是整条命令静默无输出或 bash 语法错。
#   凡是带变量/管道的 shell 逻辑，一律落到 .sh 文件里执行。
#
# 口令与地址**不经命令行**（argv 会出现在进程列表里）：由调用方经环境变量传入
#   UAT_IP / UAT_PWD / KEY_FILE / KEY_FILE_PUB / RELAY_PORT
#
# 子命令：
#   key-auth-check   —— 免密是否已就绪（判据：免密跑一条无害命令成功，而不是"文件存在"）
#   install-key      —— 用口令装一次公钥（幂等：已存在则不重复追加）
#   tunnel-check     —— 从 UAT 宿主看本机服务（经反向隧道）是否可达
#
# 用法（由 start-tiangong.ps1 调用，也可手工调用）：
#   UAT_IP=x UAT_PWD=y KEY_FILE_PUB=z bash uat-bridge.sh install-key
# ==========================================================================
set -uo pipefail

CMD="${1:-}"
UAT_IP="${UAT_IP:-}"
UAT_PWD="${UAT_PWD:-}"
KEY_FILE="${KEY_FILE:-}"
KEY_FILE_PUB="${KEY_FILE_PUB:-}"
RELAY_PORT="${RELAY_PORT:-33030}"

die() { echo "ERR $*"; exit 1; }

[ -n "$UAT_IP" ] || die "缺少 UAT_IP"

# sshpass 是本仓 UAT 侧既有的传输口径（见 ipd/deploy/uat/lib/common.sh：口令含特殊字符，
# 禁止拼进命令行，统一走 sshpass -f/-p 或经环境变量）。
have_sshpass() { command -v sshpass >/dev/null 2>&1; }

need_pwd() {
  [ -n "$UAT_PWD" ] || die "缺少 UAT_PWD"
  have_sshpass || die "WSL 里没有 sshpass（sudo apt-get install -y sshpass）"
}

# 口令经环境变量给 sshpass（-e 读 SSHPASS），避免出现在 argv / 进程列表里
with_pass() { SSHPASS="$UAT_PWD" sshpass -e "$@"; }

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o LogLevel=ERROR)

case "$CMD" in
  key-auth-check)
    [ -n "$KEY_FILE" ] || die "缺少 KEY_FILE"
    [ -f "$KEY_FILE" ] || die "私钥不存在：$KEY_FILE"
    # BatchMode=yes：任何需要交互（含口令提示）都会直接失败 ⇒ 这条判据只可能在"免密可用"时通过
    if out=$(ssh -i "$KEY_FILE" -o BatchMode=yes "${SSH_OPTS[@]}" "root@$UAT_IP" "echo KEYAUTH_OK" 2>&1) \
       && printf '%s' "$out" | grep -q KEYAUTH_OK; then
      echo "KEYAUTH_OK"
      exit 0
    fi
    echo "KEYAUTH_FAIL ${out//$'\n'/ }"
    exit 1
    ;;

  install-key)
    need_pwd
    [ -n "$KEY_FILE_PUB" ] || die "缺少 KEY_FILE_PUB"
    [ -f "$KEY_FILE_PUB" ] || die "公钥不存在：$KEY_FILE_PUB"
    PUB="$(tr -d '\r\n' < "$KEY_FILE_PUB")"
    # 幂等：先查 authorized_keys 里有没有这枚公钥（按"密钥体"比对，忽略注释后缀），
    # 否则每次跑都会追加一行 ⇒ 文件无限增长（且让人以为"配了很多次"）。
    BODY="$(printf '%s' "$PUB" | awk '{print $2}')"
    REMOTE=$(cat <<'EOS'
set -e
mkdir -p /root/.ssh
chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
if grep -qF "$BODY" /root/.ssh/authorized_keys 2>/dev/null; then
  echo ALREADY
else
  printf '%s\n' "$PUBKEY" >> /root/.ssh/authorized_keys
  echo INSTALLED
fi
EOS
)
    # BODY/PUBKEY 经环境变量进入远端 bash（远端用 bash -s 读脚本，避免引号拼接）
    out=$(with_pass ssh "${SSH_OPTS[@]}" "root@$UAT_IP" "BODY='$BODY' PUBKEY='$PUB' bash -s" <<<"$REMOTE" 2>&1) \
      || die "装公钥失败：$out"
    printf '%s\n' "$out"
    ;;

  tunnel-check)
    # 从 UAT 宿主看 127.0.0.1:$RELAY_PORT（= 反向隧道的落点）：
    # 这是"UAT 网页入口能不能用"的唯一有意义的判据 —— 本机"起了个 ssh 进程"不算证据。
    #
    # ⚠ 必须和 key-auth-check 用同一套认证口径（`-i` + `BatchMode=yes`）。
    #   实测踩过：这里原先既没给 `-i` 也没给 `BatchMode=yes`，于是在免密不通时 ssh 会
    #   **停在口令提示上**；而调用方把 stdin 关了 ⇒ 它不报错、不退出，**静默挂住**
    #   （实测直接调用时挂了 5 分钟以上，脚本侧只表现为"超时 60 秒"）。
    #   形态记牢：`ConnectTimeout` 只管 TCP 连接，**管不到认证阶段**；要防认证挂起，
    #   唯一可靠的是 `BatchMode=yes`（任何需要交互的情形一律立刻失败）。
    #   附带的好处：跑通的这条就是"免密真的可用"的独立证据，而不是"文件在那儿"。
    [ -n "$KEY_FILE" ] || die "缺少 KEY_FILE"
    [ -f "$KEY_FILE" ] || die "私钥不存在：$KEY_FILE"
    CURL_CMD="curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:${RELAY_PORT}/health"
    if out=$(ssh -i "$KEY_FILE" -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR \
               "root@$UAT_IP" "$CURL_CMD" 2>&1); then
      echo "$out"
      [ "$out" = "200" ] && exit 0 || exit 1
    fi
    echo "ERR $out"
    exit 1
    ;;

  *)
    echo "用法: bash uat-bridge.sh {key-auth-check|install-key|tunnel-check}"
    exit 2
    ;;
esac
