#!/usr/bin/env bash
#
# Launch REAL pi with the LOCAL workspace context7 + headroom extensions so you can
# walk `/context7_setup` and `/headroom_setup` onboarding with `op` absent
# (interactive rig).
#
# Run this INSIDE the interactive container:
#   docker run --rm -it pi-ext-interactive:latest bash docker/run-pi.sh
#
# Why the placeholder model flags: pi needs a model selected to start its TUI, but
# the setup commands never call the model — onboarding is pure UI. So we pass a
# throwaway provider/model/key purely to get past model selection; you never hit a
# "configure a model" wall. PI_OFFLINE=1 skips startup network. Swap in a real
# --api-key if you also want the model to answer.
#
# `--no-extensions` is SAFE on pi: it disables discovery but still loads explicit
# `-e` paths, so only these two extensions load and `/context7_setup` /
# `/headroom_setup` are invocable in the TUI. (omp differs — see run-ohmypi.sh.)
set -euo pipefail

# Keep pi + bun bins on PATH even under a login shell.
export PATH="/app/node_modules/.bin:/usr/local/bun/bin:$PATH"

export PI_OFFLINE=1
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-/tmp/pi-agent}"
mkdir -p "$PI_CODING_AGENT_DIR"

echo "pi $(pi --version)  |  agent dir: $PI_CODING_AGENT_DIR  |  op: $(command -v op || echo ABSENT)"
echo "Loaded extensions (LOCAL workspace copies):"
echo "  /app/packages/context7/index.ts"
echo "  /app/packages/headroom/index.ts"
echo "At the prompt, run:  /context7_setup   and/or   /headroom_setup"
echo "   (op is absent → masked manual key entry; the key is never shown to the agent)"
echo

exec pi \
  --no-extensions \
  -e /app/packages/context7/index.ts \
  -e /app/packages/headroom/index.ts \
  --provider openai --model gpt-4o --api-key placeholder-not-used-for-onboarding \
  --no-session \
  "$@"
