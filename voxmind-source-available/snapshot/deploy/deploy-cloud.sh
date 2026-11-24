#!/usr/bin/env bash
# 部署云端：只部署「已提交」的代码，不部署工作区。
#
#   deploy/deploy-cloud.sh            # 部署 HEAD
#   deploy/deploy-cloud.sh 301cc55    # 部署某个提交（回滚也用它）
#
# 为什么不直接 rsync cloud/：工作区里常有别的改动没提交（2026-10-01 就有一批 EVA 连接器
# 的半成品），直接 rsync 会把它们一起推上线。这里先 git archive 导出一份干净的，再传。
#
# 为什么要重试：服务器对 SSH 有限流，连着几条命令很容易被拒（"port 22 timed out"）。
# ~/.ssh/config 里给这台机器开了 ControlMaster，多条命令共用一条连接，重试只是兜底。
set -euo pipefail

HOST="${HOST:-EXAMPLE-DEMO-HOST.invalid}"
REF="${1:-HEAD}"
BASE_URL="${BASE_URL:-https://EXAMPLE-DEMO-HOST.invalid}"

repo="$(git rev-parse --show-toplevel)"
commit="$(git -C "$repo" rev-parse --short "$REF")"

if [ -n "$(git -C "$repo" status --porcelain -- cloud)" ]; then
  echo "提示：cloud/ 下有未提交的改动，它们不会被部署（只部署 $commit）。"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git -C "$repo" archive "$REF" cloud | tar -x -C "$tmp"

# 上传前在这份干净代码上把关：类型检查、全部测试、Hook 规则，有一项不过就不传。
# 以前部署一个测试都不跑——「我的」页面白屏（Hook 写在提前 return 后面）就是这么上线的。
# 依赖借用工作区里装好的 node_modules（只读），不在临时目录里重装。
if [ "${SKIP_CHECKS:-}" != "1" ]; then
  ln -s "$repo/cloud/node_modules" "$tmp/cloud/node_modules"
  echo "部署前检查 $commit（类型、测试、Hook 规则）"
  ( cd "$tmp/cloud" && npx tsc --noEmit -p . && npx tsc --noEmit -p web && npx vitest run --reporter=dot >/dev/null && npx eslint web/src ) \
    || { echo "检查没过，不部署。确认要跳过：SKIP_CHECKS=1 $0 $REF" >&2; exit 1; }
  rm "$tmp/cloud/node_modules"
fi
echo "$commit" > "$tmp/cloud/DEPLOYED_COMMIT"

retry() {
  local i
  for i in 1 2 3 4 5 6 7 8; do
    "$@" && return 0
    echo "  第 $i 次失败，$((i * 15)) 秒后重试…" >&2
    sleep $((i * 15))
  done
  return 1
}

echo "上传 $commit → $HOST"
# 不加 --delete：服务器上有些不在 git 里的东西（设计工具的元数据等），不该被删
retry rsync -az -e "ssh -o ConnectTimeout=60" \
  --exclude node_modules --exclude dist --exclude '.env*' --exclude models \
  "$tmp/cloud/" "$HOST:/opt/voxmind/cloud/"

echo "构建并重启"
retry ssh -o ConnectTimeout=60 "$HOST" \
  'cd /opt/voxmind/deploy && docker compose --env-file .env -f compose.yml up -d --build api 2>&1 | tail -2'

echo "核对线上版本"
live="$(retry ssh -o ConnectTimeout=60 "$HOST" 'cat /opt/voxmind/cloud/DEPLOYED_COMMIT')"
[ "$live" = "$commit" ] || { echo "线上是 $live，不是 $commit" >&2; exit 1; }
for i in $(seq 1 20); do
  curl -fsS --max-time 10 "$BASE_URL/health" >/dev/null 2>&1 && { echo "已上线：$commit，健康检查通过"; exit 0; }
  sleep 3
done
echo "代码已是 $commit，但健康检查 60 秒内没通过，去看容器日志" >&2
exit 1
