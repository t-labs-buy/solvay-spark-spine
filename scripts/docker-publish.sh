#!/usr/bin/env bash
# Build an image for linux/amd64 and push it to the ivolve registry, tagged
# with the current commit and "latest". Log in first:
#
#   docker login reg.ivolve.cloud     (a GitLab token with write_registry)
#
#   ./scripts/docker-publish.sh              the app (Dockerfile)
#   ./scripts/docker-publish.sh hindsight    the memory server (Dockerfile.hindsight)
#   TAG=v1 ./scripts/docker-publish.sh       a tag of your own instead of the commit
#
# On an Apple-silicon Mac the amd64 build runs under emulation: expect
# 20-40 minutes the first time.
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-app}" in
  app)       DOCKERFILE=Dockerfile;           NAME=solvay-spark-spine ;;
  hindsight) DOCKERFILE=Dockerfile.hindsight; NAME=solvay-spark-spine-hindsight ;;
  *) echo "Usage: $0 [app|hindsight]" >&2; exit 1 ;;
esac
IMAGE="${IMAGE:-reg.ivolve.cloud/ivolve/$NAME}"
SHA="$(git rev-parse --short HEAD)"
TAG="${TAG:-$SHA}"
PLATFORM="${PLATFORM:-linux/amd64}"

if [ -n "$(git status --porcelain)" ]; then
  echo "Note: uncommitted changes are included in the image tagged $TAG."
fi

if docker buildx version >/dev/null 2>&1; then
  docker buildx build -f "$DOCKERFILE" --platform "$PLATFORM" --build-arg GIT_SHA="$SHA" \
    -t "$IMAGE:$TAG" -t "$IMAGE:latest" --push .
elif command -v podman >/dev/null 2>&1; then
  # docker on this Mac is Podman, which has no buildx. Docker format keeps
  # the HEALTHCHECK, which the OCI format drops.
  podman build -f "$DOCKERFILE" --format docker --platform "$PLATFORM" --build-arg GIT_SHA="$SHA" \
    -t "$IMAGE:$TAG" -t "$IMAGE:latest" .
  podman push "$IMAGE:$TAG"
  podman push "$IMAGE:latest"
else
  echo "Neither docker buildx nor podman is available." >&2
  exit 1
fi

echo "Pushed $IMAGE:$TAG and $IMAGE:latest"
