#!/usr/bin/env bash
set -euo pipefail

trap 'docker logout "$ACR_REGISTRY" >/dev/null 2>&1 || true' EXIT

echo "$ACR_PASSWORD" | docker login "$ACR_REGISTRY" \
  --username "$ACR_USERNAME" --password-stdin

cd "$HOME/astrionyx"

export API_IMAGE
echo "部署镜像: $API_IMAGE"

docker compose pull
if ! docker compose up -d --remove-orphans --wait --wait-timeout 120; then
  docker logs --tail 100 astrionyx-api || true
  echo "部署失败: 容器未在 120 秒内达到健康状态"
  exit 1
fi

running_image=$(docker inspect --format='{{.Config.Image}}' astrionyx-api)
if [ "$running_image" != "$API_IMAGE" ]; then
  echo "镜像校验失败: 期望 $API_IMAGE，实际 $running_image"
  exit 1
fi
echo "镜像校验通过: $running_image"

if ! docker exec astrionyx-api wget -qO- -T 5 http://127.0.0.1:8523/api/ready; then
  docker logs --tail 100 astrionyx-api || true
  echo "部署失败: 数据库或迁移未就绪"
  exit 1
fi
echo "后端就绪检查通过"

docker image prune -f
