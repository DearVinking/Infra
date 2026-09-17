#!/usr/bin/env bash
set -uo pipefail

if [[ $# -lt 2 ]]; then
  echo "用法: quiet.sh <日志名> <命令> [参数...]" >&2
  exit 64
fi

name="$1"
shift

log_dir="${PRIVATE_LOG_DIR:-${RUNNER_TEMP:-/tmp}/private-logs}"
mkdir -p "$log_dir"
log_file="$log_dir/$name.log"

{
  echo "===== [$name] $(date -u +'%Y-%m-%dT%H:%M:%SZ') ====="
  printf '$'
  printf ' %q' "$@"
  echo
} >> "$log_file"

start=$(date +%s)
"$@" >> "$log_file" 2>&1
code=$?
elapsed=$(( $(date +%s) - start ))

echo "===== [$name] exit=$code elapsed=${elapsed}s =====" >> "$log_file"

if [[ $code -eq 0 ]]; then
  echo "[$name] 完成（${elapsed}s）"
else
  echo "::error::[$name] 失败，退出码 $code（${elapsed}s）"
fi
exit "$code"
