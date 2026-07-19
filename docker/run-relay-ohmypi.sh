#!/usr/bin/env bash
#
# Launch STOCK oh-my-pi (omp) with the LOCAL
# `packages/relay` extension loaded and the `relay-claude/opus` model preselected,
# ready for the maintainer's LIVE subscription-Opus dispatch under omp (the human
# `claude-sub` gate). This script does NOT run the dispatch — the maintainer sends
# a prompt at the omp prompt and confirms Opus returns.
#
# What relay does: it registers pi PROVIDERS (`relay-claude`, `relay-grok`). With
# model `relay-claude/opus`, omp's `resolveModel` routes a turn to relay's
# `streamSimple`, which shells out to `claude -p <task> --output-format json
# --model opus` and streams the final assistant text back. relay passes NO auth —
# the `claude` CLI authenticates via its OWN login (subscription oauthAccount, D1)
# or `ANTHROPIC_API_KEY`. So this exercises the real omp -> relay -> `claude -p`
# path end-to-end.
#
# ── Auth (the `claude` CLI needs a Claude login; keep ~/.pi untouched) ──
# The container is op-less and uses a throwaway PI_CODING_AGENT_DIR (never ~/.pi).
# The ONLY extra state needed is a Claude login for the `claude` CLI. Pick ONE
# when you start the container:
#
#   (A) RECOMMENDED for the subscription (`claude-sub`) gate — mount your host
#       Claude login READ-ONLY (exposes only ~/.claude, never ~/.pi):
#         docker run --rm -it -v "$HOME/.claude:/root/.claude:ro" \
#           pi-ext-interactive:latest bash docker/run-relay-ohmypi.sh
#
#   (B) Fresh login inside the container (no host mount): run `claude login` in the
#       container first, then this script.
#
#   (C) API-key path (lower friction, proves the SAME omp/relay mechanics but NOT
#       the subscription oauthAccount specifically — see the results doc):
#         docker run --rm -it -e ANTHROPIC_API_KEY=sk-ant-... \
#           pi-ext-interactive:latest bash docker/run-relay-ohmypi.sh
#
# NO `--no-extensions`: omp DISCARDS explicit `-e` paths when that flag is set
# (`cliExtensionPaths = noExtensions ? [] : extensions`, omp src/cli/models-cli.ts);
# the throwaway empty agent dir means discovery finds nothing else, so only relay
# loads.
set -uo pipefail

export PATH="/app/node_modules/.bin:/usr/local/bun/bin:$PATH"
export PI_OFFLINE=1
export OMP_SKIP_SETUP=1
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-/tmp/relay-omp-agent}"
mkdir -p "$PI_CODING_AGENT_DIR"

# Ensure the `claude` CLI is present (needs network the first time).
if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found — installing @anthropic-ai/claude-code globally…"
  npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || {
    echo "FAILED to install the claude CLI. Install it manually:" >&2
    echo "  npm install -g @anthropic-ai/claude-code" >&2
    exit 1
  }
fi

# Report the auth posture (never prints secrets).
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  AUTH="ANTHROPIC_API_KEY set (API-key path — NOT the subscription gate)"
elif [ -d "${HOME:-/root}/.claude" ] || [ -d /root/.claude ]; then
  AUTH="~/.claude present (subscription oauthAccount path — the claude-sub gate)"
else
  AUTH="NONE detected — run 'claude login' or mount ~/.claude:ro or set ANTHROPIC_API_KEY"
fi

echo "omp $(omp --version)  |  claude $(claude --version 2>/dev/null | head -1)"
echo "agent dir: $PI_CODING_AGENT_DIR  |  op: $(command -v op || echo ABSENT)  |  auth: $AUTH"
echo "Loaded extension (LOCAL workspace copy): /app/packages/relay/index.ts"
echo "Model preselected: relay-claude/opus (Relay Claude Opus)."
echo
echo "TO DISPATCH: press enter to skip the intro, then just type a prompt and submit"
echo "  (e.g. 'Reply with exactly: RELAY-OMP-OK'). The turn routes through relay to"
echo "  'claude -p' and the final Opus text streams back. If the model isn't active,"
echo "  open the model picker (Ctrl+P) and choose 'Relay Claude Opus'."
echo

exec omp \
  -e /app/packages/relay/index.ts \
  --model relay-claude/opus \
  --no-session \
  "$@"
