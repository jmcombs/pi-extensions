#!/usr/bin/env bash
#
# Launch REAL pi with the LOCAL workspace headroom extension so you can walk
# `/headroom_setup` onboarding with `op` absent (ADR 0008 interactive rig).
#
# Run this INSIDE the interactive container:
#   docker run --rm -it pi-ext-interactive:latest bash docker/run-pi.sh
#
# Why the placeholder model flags: pi needs a model selected to start its TUI,
# but `/headroom_setup` never calls the model — onboarding is pure UI. So we pass
# a throwaway provider/model/key purely to get past model selection; you never
# hit a "configure a model" wall. PI_OFFLINE=1 skips startup network. Swap in a
# real --api-key if you also want the model to answer.
set -euo pipefail

# Keep pi + bun bins on PATH even under a login shell.
export PATH="/app/node_modules/.bin:/usr/local/bun/bin:$PATH"

export PI_OFFLINE=1
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-/tmp/pi-agent}"
mkdir -p "$PI_CODING_AGENT_DIR"

echo "pi $(pi --version)  |  agent dir: $PI_CODING_AGENT_DIR  |  op: $(command -v op || echo ABSENT)"
echo "Loaded extension: /app/packages/headroom/index.ts (LOCAL workspace copy)"
echo "At the prompt, run:  /headroom_setup   (op is absent → masked manual key entry)"
echo

exec pi \
  --no-extensions \
  -e /app/packages/headroom/index.ts \
  --provider openai --model gpt-4o --api-key placeholder-not-used-for-onboarding \
  --no-session \
  "$@"
