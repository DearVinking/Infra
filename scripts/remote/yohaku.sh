#!/usr/bin/env bash
set -euo pipefail

trap 'docker logout "$ACR_REGISTRY" >/dev/null 2>&1 || true' EXIT

echo "$ACR_PASSWORD" | docker login "$ACR_REGISTRY" \
  --username "$ACR_USERNAME" --password-stdin

cd "$HOME/yohaku"

docker compose pull
docker compose up -d

ready() { curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:2323/api/healthz; }
wait_ready() { for _ in $(seq 1 "$1"); do ready && return 0; sleep 5; done; return 1; }

if wait_ready 12; then
  echo "部署后已就绪"
else
  echo "约 60s 仍未就绪，自动重启一次容器后重试…"
  docker restart yohaku
  if wait_ready 12; then
    echo "重启后已就绪"
  else
    echo "重启后仍不可用，部署失败"
    docker logs --tail 120 yohaku
    exit 1
  fi
fi

docker image prune -f
