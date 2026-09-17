#!/usr/bin/env bash
set -euo pipefail

trap 'docker logout "$ACR_REGISTRY" >/dev/null 2>&1 || true' EXIT

echo "$ACR_PASSWORD" | docker login "$ACR_REGISTRY" \
  --username "$ACR_USERNAME" --password-stdin

cd "$HOME/astrionyx"

export API_IMAGE
echo "部署镜像: $API_IMAGE"

docker compose pull
docker compose up -d --remove-orphans

running_image=$(docker inspect --format='{{.Config.Image}}' astrionyx-api)
if [ "$running_image" != "$API_IMAGE" ]; then
  echo "镜像校验失败: 期望 $API_IMAGE，实际 $running_image"
  exit 1
fi
echo "镜像校验通过: $running_image"

docker image prune -f
