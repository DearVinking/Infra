#!/usr/bin/env bash
set -euo pipefail
umask 077

name="${1:?report name required}"
[[ "$name" =~ ^[a-z0-9_-]+$ ]]
paths=()
if [[ -n "${REPORT_PATHS:-}" ]]; then
  read -r -a requested <<< "$REPORT_PATHS"
  for path in "${requested[@]}"; do
    case "$path" in
      coverage/lcov.info|coverage/macos|coverage/go-tests|apps/api/coverage.out|apps/api/coverage-shared.out|apps/api/coverage-desktop.out) ;;
      *) exit 1 ;;
    esac
    if [[ -e "$GITHUB_WORKSPACE/src/$path" ]]; then
      paths+=("$path")
    elif [[ "${CI_JOB_RESULT:?job result required}" == "success" ]]; then
      exit 1
    fi
  done
fi

mkdir -p "$RUNNER_TEMP/private-logs" "$RUNNER_TEMP/ci-reports"
archive="$(mktemp "$RUNNER_TEMP/ci-report.XXXXXXXX")"
trap 'rm -f "$archive"' EXIT
args=(-C "$RUNNER_TEMP" private-logs)
if [[ ${#paths[@]} -gt 0 ]]; then
  args+=(-C "$GITHUB_WORKSPACE/src" "${paths[@]}")
fi
tar -czf "$archive" "${args[@]}"
node "$(dirname "$0")/ci-artifacts.mjs" seal "$archive" "$RUNNER_TEMP/ci-reports/$name.enc"
