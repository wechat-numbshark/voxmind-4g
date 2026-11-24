#!/usr/bin/env bash
# VoxMind 备份：数据库整库 + 音频卷。
#
# 保留策略由 /opt/voxmind/deploy/backup.env 决定（没有这个文件就用下面的默认值）：
#   KEEP_DAYS=0            0＝永久保留，从不自动删（默认）；>0＝只保留这么多天
#   KEEP_MIN=7             即使设了 KEEP_DAYS，也至少留这么多份，防止误设把备份删光
#   OFFSITE_TARGET=""      设了就在本地备份完成后 rsync 到异地（如 user@host:/path 或挂载点）
#
# 注意：这个脚本必须是可执行的。它曾经因为丢了执行位导致 systemd 报 203/EXEC，
# 备份连续失败 8 天都没人发现（20260912–20260920）——部署后请确认 `ls -l` 有 x 位。
set -euo pipefail

backup_root="/opt/voxmind/backups"
env_file="$(dirname "$0")/backup.env"
KEEP_DAYS=0
KEEP_MIN=7
OFFSITE_TARGET=""
# shellcheck source=/dev/null
[ -f "$env_file" ] && . "$env_file"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_root"
work_dir="$(mktemp -d "${backup_root}/.pending-${stamp}-XXXX")"
final_dir="${backup_root}/${stamp}"
trap 'rm -rf -- "$work_dir"' EXIT
docker exec voxmind-postgres-1 pg_dump -U voxmind -d voxmind -Fc > "${work_dir}/postgres.dump"
docker run --rm \
  -v voxmind_audio-data:/audio:ro \
  -v "${work_dir}:/backup" \
  alpine:3.22 tar -czf /backup/audio.tar.gz -C /audio .
sha256sum "${work_dir}/postgres.dump" "${work_dir}/audio.tar.gz" > "${work_dir}/SHA256SUMS"
mv "$work_dir" "$final_dir"
trap - EXIT

# 清理：KEEP_DAYS=0 时什么都不删。删之前先数一下还剩几份，少于 KEEP_MIN 就不动手。
if [ "${KEEP_DAYS}" -gt 0 ]; then
  mapfile -t old < <(find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name '20????????T??????Z' -mtime "+${KEEP_DAYS}" | sort)
  total=$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name '20????????T??????Z' | wc -l)
  for dir in "${old[@]:-}"; do
    [ -z "$dir" ] && continue
    [ "$total" -le "${KEEP_MIN}" ] && break
    rm -rf -- "$dir"
    total=$((total - 1))
    echo "已删除过期备份：$dir"
  done
fi

# 异地同步：本机磁盘坏了、机器没了，这一份才是真的保险
if [ -n "${OFFSITE_TARGET}" ]; then
  rsync -a --delete "$backup_root/" "${OFFSITE_TARGET}/" && echo "已同步到异地：${OFFSITE_TARGET}"
fi

du_total="$(du -sh "$backup_root" | cut -f1)"
count="$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name '20????????T??????Z' | wc -l)"
echo "VoxMind backup complete: ${final_dir}（共 ${count} 份，占用 ${du_total}，KEEP_DAYS=${KEEP_DAYS}）"
