#!/usr/bin/env bash
set -euo pipefail

TASK="deploy:infra"
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"

cmd="${1:?缺少子命令}"
shift

case "$cmd" in
  resolve)
    repo="${1:?缺少仓库}"
    ref="${2:?缺少 ref}"
    gh api "repos/$repo/commits/$ref" --jq '.sha'
    ;;
  create)
    repo="${1:?缺少仓库}"
    env="${2:?缺少环境名}"
    sha="${3:?缺少 sha}"
    id="$(
      jq -n --arg ref "$sha" --arg env "$env" --arg task "$TASK" \
        --arg source "${GITHUB_REPOSITORY:-}" --arg run_url "$run_url" \
        '{
          ref: $ref,
          task: $task,
          environment: $env,
          production_environment: true,
          auto_merge: false,
          required_contexts: [],
          description: ("由 " + $source + " 部署"),
          payload: { source: $source, run_url: $run_url }
        }' \
        | gh api -X POST "repos/$repo/deployments" --input - --jq '.id'
    )"
    gh api -X POST "repos/$repo/deployments/$id/statuses" \
      -f state=in_progress -f log_url="$run_url" >/dev/null
    echo "$id"
    ;;
  status)
    repo="${1:?缺少仓库}"
    id="${2:?缺少 deployment id}"
    state="${3:?缺少状态}"
    gh api -X POST "repos/$repo/deployments/$id/statuses" \
      -f state="$state" -f log_url="$run_url" >/dev/null
    ;;
  *)
    echo "未知子命令: $cmd" >&2
    exit 64
    ;;
esac
