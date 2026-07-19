#!/usr/bin/env bash
#
# Launch REAL oh-my-pi (omp) with the LOCAL workspace headroom extension
# (ADR 0008 interactive rig).
#
# KNOWN BLOCKER (as of omp 17.0.5): omp cannot load our extension. Its
# legacy-pi-coding-agent-shim exports `createBashTool` and `getAgentDir` but NOT
# `createLocalBashOperations`, which `@jmcombs/pi-1password/index.ts` imports at
# module top-level (for its `1p_run` bash tool). The ESM link fails, so headroom
# — any consumer of @jmcombs/pi-1password — does not load under omp, and
# `/headroom_setup` will not be available. This is a real oh-my-pi compatibility
# finding, escalated for a decision (a lazy import in @jmcombs/pi-1password would
# unblock it). See docker/README.md and docs/decisions/0008-*.md.
#
# This script first RE-PROVES the blocker via omp's own loader, then launches omp
# so you can observe its behavior firsthand. Run INSIDE the container:
#   docker run --rm -it pi-ext-interactive:latest bash docker/run-ohmypi.sh
set -uo pipefail

export PATH="/app/node_modules/.bin:/usr/local/bun/bin:$PATH"
export PI_OFFLINE=1
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-/tmp/omp-agent}"
mkdir -p "$PI_CODING_AGENT_DIR"

echo "omp $(omp --version)  |  agent dir: $PI_CODING_AGENT_DIR  |  op: $(command -v op || echo ABSENT)"
echo
echo "== Reproducing the known oh-my-pi load blocker via omp's own loader =="
OMP_PKG="${BUN_INSTALL:-/usr/local/bun}/install/global/node_modules/@oh-my-pi/pi-coding-agent"
export OMP_LOADER="$OMP_PKG/src/extensibility/extensions/loader.ts"
export OMP_VERSION="$(omp --version 2>/dev/null | tr -d '\n')"
bun /app/docker/ohmypi-smoke.mts || true
echo
echo "== Launching omp with -e headroom anyway (expect headroom NOT loaded until the"
echo "   @jmcombs/pi-1password compat gap is fixed; /headroom_setup will be absent) =="
echo

exec omp \
  --no-extensions \
  -e /app/packages/headroom/index.ts \
  --provider openai --model gpt-4o --api-key placeholder-not-used-for-onboarding \
  --no-session \
  "$@"
