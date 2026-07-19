#!/usr/bin/env bash
#
# Non-interactive cross-platform validation for the op-absent rig (ADR 0008/0009).
# Both are GATES: each agent's OWN real extension loader must load EVERY
# auto-discovered, non-private packages/* extension (+ their LOCAL
# @jmcombs/pi-1password) with `op` absent and register each package's expected,
# platform-aware surface from the workspace copies. Discovery + the expected-surface
# table live in the shared harness (docker/smoke-harness.mts); private packages
# (e.g. _template) are excluded and logged.
#
#   - pi:       pi's real loader (@earendil-works/pi-coding-agent).
#   - oh-my-pi: STOCK omp's real loader — unpatched. Loading works because the
#               extensions feature-detect optional pi host APIs (createLocalBash-
#               Operations et al.); see docker/README.md / ADR 0008/0009.
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

echo "== pi (GATE): real pi loads every non-private packages/* extension, op absent =="
tsx /app/docker/pi-smoke.mts
PI_EXIT=$?
echo

echo "== oh-my-pi (GATE): STOCK omp real loader loads every non-private packages/* extension, op absent =="
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
echo "RESULT: both gates PASSED — real pi and stock oh-my-pi load every non-private packages/* extension and register its expected surface with op absent."
