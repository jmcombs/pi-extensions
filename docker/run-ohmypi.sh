#!/usr/bin/env bash
#
# Launch REAL oh-my-pi (omp) with the LOCAL workspace headroom extension so you
# can walk `/headroom_setup` onboarding with `op` absent (ADR 0008 interactive rig).
#
# Two pieces of omp-specific launch friction are handled here + in the image:
#   1. omp hard-remaps `@earendil-works/pi-coding-agent` to its own legacy shim,
#      which omits `createLocalBashOperations` (imported by @jmcombs/pi-1password).
#      The IMAGE BUILD adds a container-only exports override that surfaces the REAL
#      symbol from @earendil-works/pi-coding-agent@0.80.9 — see the Dockerfile /
#      docker/README.md. No product source is changed.
#   2. omp's first-run setup wizard is skipped with OMP_SKIP_SETUP=1, and a
#      placeholder model + PI_OFFLINE=1 get past model selection. `/headroom_setup`
#      never calls the model, so there is no "configure a model / provider" wall.
#
# Run INSIDE the container:
#   docker run --rm -it pi-ext-interactive:latest bash docker/run-ohmypi.sh
set -uo pipefail

export PATH="/app/node_modules/.bin:/usr/local/bun/bin:$PATH"
export PI_OFFLINE=1
export OMP_SKIP_SETUP=1
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-/tmp/omp-agent}"
mkdir -p "$PI_CODING_AGENT_DIR"

echo "omp $(omp --version)  |  agent dir: $PI_CODING_AGENT_DIR  |  op: $(command -v op || echo ABSENT)"
echo "Loaded extension: /app/packages/headroom/index.ts (LOCAL workspace copy)"
echo "At the prompt (press enter to skip the intro), run:  /headroom_setup"
echo "   (op is absent → masked manual key entry; the key is never shown to the agent)"
echo

exec omp \
  --no-extensions \
  -e /app/packages/headroom/index.ts \
  --provider openai --model gpt-4o --api-key placeholder-not-used-for-onboarding \
  --no-session \
  "$@"
