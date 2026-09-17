#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

ENVIRONMENTS=(yohaku astrionyx daymark streak)

repo="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
echo "目标仓库: $repo"

if [[ ! -d .secrets ]]; then
  cp -r secrets.example .secrets
  echo "已从 secrets.example 生成 .secrets/，请填写其中的值后重新运行本脚本。"
  exit 0
fi

if [[ -f .secrets/daymark.env ]] && grep -qE '^ENCRYPTION_PASSPHRASE=\s*$' .secrets/daymark.env; then
  passphrase="$(openssl rand -base64 36 | tr -d '\n')"
  sed -i.bak -E "s|^ENCRYPTION_PASSPHRASE=\s*$|ENCRYPTION_PASSPHRASE=$passphrase|" .secrets/daymark.env
  rm -f .secrets/daymark.env.bak
  echo "已生成 ENCRYPTION_PASSPHRASE 并写入 .secrets/daymark.env，请妥善备份。"
fi

apply_env_file() {
  local file="$1" env="${2:-}" line key value set_count=0 skip=()
  local -a scope=()
  [[ -n "$env" ]] && scope=(--env "$env")

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key//[[:space:]]/}"
    if [[ -z "$value" ]]; then
      skip+=("$key")
      continue
    fi
    if [[ "$value" == @* ]]; then
      if [[ ! -f "${value#@}" ]]; then
        echo "  [警告] $key 指向的文件不存在，跳过: ${value#@}" >&2
        skip+=("$key")
        continue
      fi
      gh secret set "$key" -R "$repo" "${scope[@]}" < "${value#@}"
    else
      printf '%s' "$value" | gh secret set "$key" -R "$repo" "${scope[@]}"
    fi
    set_count=$((set_count + 1))
  done < "$file"

  echo "  已写入 $set_count 个 secret${skip[*]:+；留空跳过: ${skip[*]}}"
}

echo "创建 environments..."
for env in "${ENVIRONMENTS[@]}"; do
  gh api -X PUT "repos/$repo/environments/$env" --silent
done

echo "仓库级 secrets（.secrets/repo.env）"
apply_env_file .secrets/repo.env

for env in "${ENVIRONMENTS[@]}"; do
  file=".secrets/$env.env"
  if [[ ! -f "$file" ]]; then
    echo "environment $env：没有 $file，跳过"
    continue
  fi
  echo "environment $env（$file）"
  apply_env_file "$file" "$env"
done

echo
echo "当前 secrets："
gh secret list -R "$repo"
for env in "${ENVIRONMENTS[@]}"; do
  echo "--- $env ---"
  gh secret list -R "$repo" --env "$env"
done
