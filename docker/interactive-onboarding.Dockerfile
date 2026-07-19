# Interactive onboarding rig — real pi + oh-my-pi, `op` absent (ADR 0008).
#
# A node:22 image where the maintainer can launch REAL pi and REAL oh-my-pi with
# the LOCAL workspace headroom extension loaded and walk `/headroom_setup`
# onboarding with the 1Password CLI (`op`) genuinely absent. The container has no
# `op`, no access to the host `~/.pi`, and its own throwaway agent dir.
#
# - pi:       installed as the root devDependency `@earendil-works/pi-coding-agent`
#             (pinned in package.json) via `npm ci`; the `pi` bin is on PATH.
# - oh-my-pi: `@oh-my-pi/pi-coding-agent` (bin `omp`), a Bun-targeted pi fork;
#             installed globally with Bun (the engine it declares).
# - extension: the LOCAL monorepo is COPY'd and `npm ci` symlinks the workspace
#             `@jmcombs/pi-headroom` / `@jmcombs/pi-1password` into node_modules,
#             so both agents load the branch code we are validating — NOT the
#             npm-published packages.
FROM node:22

# This image MUST be op-less — fail the build if the base ever ships `op`.
RUN if command -v op >/dev/null 2>&1; then echo "FATAL: op unexpectedly present" >&2; exit 1; fi

WORKDIR /app

# Host node_modules / .git excluded via the sibling .dockerignore.
COPY . .

# Fresh, platform-correct install (installs pi + tsx + the workspace packages).
# HUSKY=0 skips the git-hooks prepare step (no .git in the build context).
RUN HUSKY=0 npm ci

# Bun — the runtime oh-my-pi declares (engines.bun) — then oh-my-pi itself.
ENV BUN_INSTALL=/usr/local/bun
RUN npm install -g bun \
  && bun install -g @oh-my-pi/pi-coding-agent

# Put the local pi bin and the Bun-global omp bin on PATH.
ENV PATH=/app/node_modules/.bin:/usr/local/bun/bin:$PATH

# Throwaway agent dir default (never the host ~/.pi). Launch scripts also set it.
ENV PI_CODING_AGENT_DIR=/tmp/pi-agent

# Default: run the non-interactive smoke proofs for BOTH agents. Interactive
# onboarding is driven with docker/run-pi.sh / docker/run-ohmypi.sh.
CMD ["bash", "docker/smoke-both.sh"]
