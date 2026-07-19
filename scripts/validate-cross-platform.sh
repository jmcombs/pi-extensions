#!/usr/bin/env bash
#
# Cross-platform contributor validation — the Docker path.
#
# Builds the op-less interactive-onboarding image and runs the non-interactive
# cross-platform smokes inside it, proving that EVERY non-private packages/*
# extension loads and registers its expected, platform-aware surface on BOTH real
# pi AND stock oh-my-pi with the 1Password CLI (`op`) absent.
#
# The Docker path is used deliberately: a contributor machine may have `op`
# installed, but the container has NO `op` binary and NO access to the host
# ~/.pi (its own throwaway PI_CODING_AGENT_DIR; no volumes are mounted), so
# op-absence is guaranteed regardless of the host. The runner-native CI job
# proves the same two loaders on a runner where `op` is already absent.
#
# Usage: npm run validate:cross-platform   (or: bash scripts/validate-cross-platform.sh)
# Exits non-zero if either loader fails to load a package or register its surface.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="pi-ext-cross-platform:latest"
DOCKERFILE="docker/interactive-onboarding.Dockerfile"

export DOCKER_BUILDKIT=1

if ! command -v docker >/dev/null 2>&1; then
  echo "FAIL: docker is not available in PATH" >&2
  exit 1
fi

echo "==> Building $IMAGE (no op binary, isolated)…"
docker build -f "$REPO_ROOT/$DOCKERFILE" -t "$IMAGE" "$REPO_ROOT"

echo "==> Running cross-platform validation (no host ~/.pi mounted, no volumes)…"
set +e
docker run --rm "$IMAGE" bash docker/smoke-both.sh
RUN_EXIT=$?
set -e

if [ "$RUN_EXIT" -ne 0 ]; then
  echo "FAIL: cross-platform validation exited $RUN_EXIT" >&2
  exit 1
fi

echo "PASS: every non-private extension loads + registers its expected surface on pi and stock oh-my-pi (op absent)."
