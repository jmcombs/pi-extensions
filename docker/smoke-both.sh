#!/usr/bin/env bash
#
# Non-interactive smoke proofs for the interactive onboarding rig (ADR 0008).
# Both are GATES: each agent's OWN real extension loader must load the LOCAL
# headroom extension (+ its LOCAL @jmcombs/pi-1password) with `op` absent and
# register headroom_setup / headroom_retrieve / session_start from the workspace.
#
#   - pi:       pi's real loader (@earendil-works/pi-coding-agent).
#   - oh-my-pi: omp's real loader, with the container-only exports override that
#               surfaces the real createLocalBashOperations (see docker/README.md).
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

echo "== pi (GATE): real pi loads the LOCAL headroom extension, op absent =="
tsx /app/docker/pi-smoke.mts
PI_EXIT=$?
echo

echo "== oh-my-pi (GATE): omp real loader loads the LOCAL headroom extension, op absent =="
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
echo "RESULT: both gates PASSED — real pi and real oh-my-pi load the LOCAL headroom extension with op absent."
