#!/usr/bin/env bash
#
# Launch REAL (stock, unpatched) oh-my-pi (omp) with the LOCAL workspace context7 +
# headroom extensions so you can walk `/context7_setup` and `/headroom_setup`
# onboarding with `op` absent (ADR 0008 interactive rig).
#
# Why this works on STOCK omp: omp hard-remaps `@earendil-works/pi-coding-agent` to
# its own legacy shim, which omits `createLocalBashOperations`. `@jmcombs/pi-1password`
# now FEATURE-DETECTS that symbol (namespace import; registers the `user_bash` hook
# only when present), so it links + loads under omp's compat shim unmodified — no
# image-level shim patch. See docker/README.md / ADR 0008. No product source hack.
#
# omp's first-run setup wizard is skipped with OMP_SKIP_SETUP=1, and a placeholder
# model + PI_OFFLINE=1 get past model selection. The setup commands never call the
# model, so there is no "configure a model / provider" wall.
#
# IMPORTANT — do NOT pass `--no-extensions` here. Unlike pi (where `-ne` disables
# discovery but still loads explicit `-e` paths), omp DISCARDS the `-e` paths when
# `--no-extensions` is set: `cliExtensionPaths = noExtensions ? [] : extensions`
# (omp `src/cli/models-cli.ts`). With `--no-extensions`, our extensions never load
# and `/context7_setup` / `/headroom_setup` fall through to the model as chat. We
# omit the flag; the throwaway (empty) agent dir means discovery finds nothing else,
# so only these two `-e` extensions load.
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
echo "Loaded extensions (LOCAL workspace copies):"
echo "  /app/packages/context7/index.ts"
echo "  /app/packages/headroom/index.ts"
echo "At the prompt (press enter to skip the intro), run:  /context7_setup  and/or  /headroom_setup"
echo "   (op is absent → masked manual key entry; the key is never shown to the agent)"
echo

exec omp \
  -e /app/packages/context7/index.ts \
  -e /app/packages/headroom/index.ts \
  --provider openai --model gpt-4o --api-key placeholder-not-used-for-onboarding \
  --no-session \
  "$@"
