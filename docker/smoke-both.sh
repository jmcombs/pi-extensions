#!/usr/bin/env bash
#
# Non-interactive smoke proofs for the interactive onboarding rig (ADR 0008).
# Both are GATES: each agent's OWN real extension loader must load the LOCAL
# context7 + headroom extensions (+ their LOCAL @jmcombs/pi-1password) with `op`
# absent and register their setup commands + tools from the workspace copies.
#
#   - pi:       pi's real loader (@earendil-works/pi-coding-agent).
#   - oh-my-pi: STOCK omp's real loader — unpatched. Loading works because
#               @jmcombs/pi-1password feature-detects createLocalBashOperations
#               (see docker/README.md / ADR 0008).
#
# Overall exit status is non-zero if EITHER gate fails.
set -uo pipefail

export PATH="/app/node_modules/.bin:/usr/local/bun/bin:$PATH"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-/tmp/pi-agent}"
mkdir -p "$PI_CODING_AGENT_DIR"

echo "== op absence =="
if command -v op >/dev/null 2>&1; then
  echo "FAIL: op is present ($(command -v op)) — this image must be op-less" >&2
  exit 1
fi
echo "op ABSENT (good)"
echo

echo "== pi (GATE): real pi loads the LOCAL context7 + headroom extensions, op absent =="
tsx /app/docker/pi-smoke.mts
PI_EXIT=$?
echo

echo "== oh-my-pi (GATE): STOCK omp real loader loads the LOCAL context7 + headroom extensions, op absent =="
OMP_PKG="${BUN_INSTALL:-/usr/local/bun}/install/global/node_modules/@oh-my-pi/pi-coding-agent"
export OMP_LOADER="$OMP_PKG/src/extensibility/extensions/loader.ts"
export OMP_VERSION="$(omp --version 2>/dev/null | tr -d '\n')"
bun /app/docker/ohmypi-smoke.mts
OMP_EXIT=$?
echo

if [ "$PI_EXIT" -ne 0 ] || [ "$OMP_EXIT" -ne 0 ]; then
  echo "RESULT: FAILED (pi exit $PI_EXIT, oh-my-pi exit $OMP_EXIT)" >&2
  exit 1
fi
echo "RESULT: both gates PASSED — real pi and stock oh-my-pi load the LOCAL context7 + headroom extensions with op absent."
