#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_REPOSITORY:?缺少 SOURCE_REPOSITORY}" "${UPSTREAM_REPOSITORY:?缺少 UPSTREAM_REPOSITORY}" \
  "${DEPLOY_WORKFLOW:?缺少 DEPLOY_WORKFLOW}" "${CI_TOKEN:?缺少 CI_TOKEN}" "${GITHUB_TOKEN:?缺少 GITHUB_TOKEN}"

src_branch="${SOURCE_BRANCH:-main}"
up_branch="${UPSTREAM_BRANCH:-main}"
upstream_token="${UPSTREAM_TOKEN:-$CI_TOKEN}"
log_dir="${PRIVATE_LOG_DIR:-${RUNNER_TEMP:-/tmp}/private-logs}"
mkdir -p "$log_dir"
log="$log_dir/sync-upstream.log"

auth_header() {
  printf 'AUTHORIZATION: basic %s' "$(printf 'x-access-token:%s' "$1" | base64 -w0)"
}

cd src
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

git -c "http.extraheader=$(auth_header "$upstream_token")" fetch --no-tags \
  "https://github.com/$UPSTREAM_REPOSITORY.git" \
  "$up_branch:refs/remotes/upstream/$up_branch" >>"$log" 2>&1

if git merge-base --is-ancestor "upstream/$up_branch" HEAD; then
  echo "上游没有新提交"
  exit 0
fi

behind="$(git rev-list --count "HEAD..upstream/$up_branch")"
echo "上游有 $behind 个新提交，开始合并"
before="$(git rev-parse HEAD)"

if ! git merge "upstream/$up_branch" --no-edit \
  -m "chore: 通过工作流自动同步上游仓库（$(date +'%Y-%m-%d')）" >>"$log" 2>&1; then
  git merge --abort >>"$log" 2>&1 || true
  echo "::error::合并上游时发生冲突，需要手动处理"
  exit 1
fi

git -c "http.extraheader=$(auth_header "$CI_TOKEN")" push \
  "https://github.com/$SOURCE_REPOSITORY.git" "HEAD:$src_branch" >>"$log" 2>&1

sha="$(git rev-parse HEAD)"
echo "已推送合并提交 ${sha:0:7}"

excludes=()
read -ra patterns <<<"${DEPLOY_EXCLUDE_PATTERNS:-}"
for pattern in "${patterns[@]}"; do
  excludes+=(":(exclude)$pattern")
done
if [[ ${#excludes[@]} -gt 0 ]] && git diff --quiet "$before" HEAD -- . "${excludes[@]}"; then
  echo "合并的变更未命中部署路径，不触发部署"
  exit 0
fi

echo "触发 $DEPLOY_WORKFLOW 部署 ${sha:0:7}"
GH_TOKEN="$GITHUB_TOKEN" gh workflow run "$DEPLOY_WORKFLOW" -R "$GITHUB_REPOSITORY" -f "ref=$sha"
