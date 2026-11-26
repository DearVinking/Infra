#!/usr/bin/env bash
set -euo pipefail

sha="${1:?source SHA required}"
depth="${2:?history depth required}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
[[ -n "${CI_TOKEN:-}" ]]
history=(--no-tags)
case "$depth" in
  0) ;;
  1) history+=(--depth=1) ;;
  *) exit 1 ;;
esac

export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=http.https://github.com/.extraheader
export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$CI_TOKEN" | base64 | tr -d '\r\n')"
export GIT_CONFIG_KEY_1=http.followRedirects
export GIT_CONFIG_VALUE_1=false

source_dir="$GITHUB_WORKSPACE/src"
git init "$source_dir"
git -C "$source_dir" remote add origin https://github.com/DearVinking/Astrionyx.git
git -C "$source_dir" fetch "${history[@]}" origin "$sha"
git -C "$source_dir" checkout --force --detach "$sha"
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$sha" ]]
