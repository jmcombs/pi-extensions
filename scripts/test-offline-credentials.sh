#!/usr/bin/env bash
#
# Offline (no-`op`) credential validation harness.
#
# Builds an op-less Docker image and runs the offline credential check inside it,
# asserting the single OFFLINE-CREDS line reports all-ok. The container has NO
# `op` binary and NO access to the host ~/.pi — it uses its own throwaway agent
# dir (PI_CODING_AGENT_DIR) chosen per scenario by the check. No volumes are
# mounted, so the host ~/.pi is unreachable from the container.
#
# Usage: bash scripts/test-offline-credentials.sh
# Exits non-zero on any failed assertion.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="pi-ext-offline-creds:latest"
DOCKERFILE="docker/offline-creds.Dockerfile"
EXPECTED="OFFLINE-CREDS: op-absent=ok available=false add-key=ok resolve-literal=ok resolve-opref=undefined loads=ok keyless=ok"

export DOCKER_BUILDKIT=1

if ! command -v docker >/dev/null 2>&1; then
  echo "FAIL: docker is not available in PATH" >&2
  exit 1
fi

echo "==> Building $IMAGE (no op binary, isolated)…"
docker build -f "$REPO_ROOT/$DOCKERFILE" -t "$IMAGE" "$REPO_ROOT"

echo "==> Running offline credential check (no host ~/.pi mounted, no volumes)…"
set +e
OUTPUT="$(docker run --rm "$IMAGE" 2>&1)"
RUN_EXIT=$?
set -e

echo "$OUTPUT"

LINE="$(printf '%s\n' "$OUTPUT" | grep '^OFFLINE-CREDS:' || true)"
if [ -z "$LINE" ]; then
  echo "FAIL: no OFFLINE-CREDS line emitted (container exit $RUN_EXIT)" >&2
  exit 1
fi

if [ "$RUN_EXIT" -ne 0 ]; then
  echo "FAIL: offline credential check exited $RUN_EXIT" >&2
  exit 1
fi

if [ "$LINE" != "$EXPECTED" ]; then
  echo "FAIL: unexpected result line" >&2
  echo "  expected: $EXPECTED" >&2
  echo "  actual:   $LINE" >&2
  exit 1
fi

echo "PASS: offline credential path validated with op absent."
