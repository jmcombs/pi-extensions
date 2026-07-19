#!/usr/bin/env bash
#
# Non-interactive smoke proofs for the interactive onboarding rig (ADR 0008).
#
#   - pi  (GATE):        pi's real loader loads the LOCAL headroom extension with
#                        `op` absent and registers headroom_setup / headroom_retrieve
#                        / session_start from the workspace copy. Must pass.
#   - oh-my-pi (REPORT): omp's real loader attempted against the same extension.
#                        Reported honestly — currently BLOCKED by a compat gap in
#                        @jmcombs/pi-1password (see docker/README.md / ADR 0008).
#
# Overall exit status reflects the pi gate. The oh-my-pi line is informational.
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

echo "== oh-my-pi (REPORT): omp real loader vs the LOCAL headroom extension =="
OMP_PKG="${BUN_INSTALL:-/usr/local/bun}/install/global/node_modules/@oh-my-pi/pi-coding-agent"
export OMP_LOADER="$OMP_PKG/src/extensibility/extensions/loader.ts"
export OMP_VERSION="$(omp --version 2>/dev/null | tr -d '\n')"
bun /app/docker/ohmypi-smoke.mts || true
echo

if [ "$PI_EXIT" -ne 0 ]; then
  echo "RESULT: pi gate FAILED (exit $PI_EXIT)" >&2
  exit "$PI_EXIT"
fi
echo "RESULT: pi gate PASSED. oh-my-pi result reported above (see docker/README.md for the known blocker)."
