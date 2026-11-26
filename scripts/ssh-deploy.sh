#!/usr/bin/env bash
set -euo pipefail

script="${1:?缺少远程脚本路径}"
shift
: "${SSH_HOST:?缺少 SSH_HOST}" "${SSH_USER:?缺少 SSH_USER}" "${SSH_KEY:?缺少 SSH_KEY}"
port="${SSH_PORT:-22}"
timeout_s="${SSH_TIMEOUT:-600}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
key="$work/id"
printf '%s\n' "$SSH_KEY" > "$key"
chmod 600 "$key"

ssh_opts=(
  -i "$key"
  -p "$port"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o ConnectTimeout=30
  -o ServerAliveInterval=30
  -o UserKnownHostsFile="$work/known_hosts"
)
if [[ -n "${SSH_KNOWN_HOSTS:-}" ]]; then
  printf '%s\n' "$SSH_KNOWN_HOSTS" > "$work/known_hosts"
  ssh_opts+=(-o StrictHostKeyChecking=yes)
else
  ssh_opts+=(-o StrictHostKeyChecking=accept-new)
fi

{
  echo 'set -euo pipefail'
  for name in "$@"; do
    printf 'export %s=%q\n' "$name" "${!name:-}"
  done
  cat "$script"
} | timeout "$timeout_s" ssh "${ssh_opts[@]}" "$SSH_USER@$SSH_HOST" 'bash -s'
