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

# Bun — the runtime oh-my-pi declares (engines.bun) — then oh-my-pi itself (pinned).
ENV BUN_INSTALL=/usr/local/bun
RUN npm install -g bun \
  && bun install -g @oh-my-pi/pi-coding-agent@17.0.5

# Container-only resolution fix (ADR 0008): omp hard-remaps every
# `@earendil-works/pi-coding-agent` import to its own legacy-pi-coding-agent-shim
# via a process-global Bun.plugin onResolve hook (no env/flag override), so plugins
# share omp's single runtime. That shim re-exports `createBashTool` + `getAgentDir`
# but OMITS `createLocalBashOperations`, which `@jmcombs/pi-1password` imports at
# top level — so headroom fails to link under omp. We surface the REAL symbol from
# the genuine `@earendil-works/pi-coding-agent@0.80.9` already installed in
# node_modules by appending an exports override to omp's shim (absolute-path import,
# so it is NOT re-intercepted by the bare-specifier filter). This patches only the
# third-party omp shim IN THE IMAGE — no product source (`packages/**`) is changed.
RUN set -eux; \
  REAL="/app/node_modules/@earendil-works/pi-coding-agent"; \
  SHIM="$BUN_INSTALL/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts"; \
  test -f "$SHIM"; \
  test -f "$REAL/dist/core/tools/index.js"; \
  grep -q "createLocalBashOperations" "$SHIM" && { echo "shim already has export; omp changed" >&2; exit 1; }; \
  printf '\n// [container-only, ADR 0008] surface the real pi export omp'"'"'s shim omits.\nexport { createLocalBashOperations } from "%s/dist/core/tools/index.js";\n' "$REAL" >> "$SHIM"; \
  grep -q "createLocalBashOperations" "$SHIM"

# Put the local pi bin and the Bun-global omp bin on PATH.
ENV PATH=/app/node_modules/.bin:/usr/local/bun/bin:$PATH

# Throwaway agent dir default (never the host ~/.pi). Launch scripts also set it.
ENV PI_CODING_AGENT_DIR=/tmp/pi-agent

# Default: run the non-interactive smoke proofs for BOTH agents. Interactive
# onboarding is driven with docker/run-pi.sh / docker/run-ohmypi.sh.
CMD ["bash", "docker/smoke-both.sh"]
