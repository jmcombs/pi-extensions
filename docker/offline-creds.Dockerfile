# Offline (no-`op`) credential validation image.
#
# A node:22 base with the 1Password CLI (`op`) intentionally NOT installed and no
# access to the host `~/.pi`. The workspace is installed fresh on Linux (macOS
# host node_modules never port in — see the .dockerignore) and the offline
# credential check runs entirely inside the container against a throwaway
# `PI_CODING_AGENT_DIR` chosen per scenario by the check itself.
FROM node:22

# Fail the build if the base image ever ships `op` — this image MUST be op-less.
RUN if command -v op >/dev/null 2>&1; then echo "FATAL: op unexpectedly present" >&2; exit 1; fi

WORKDIR /app

# Host node_modules / .git are excluded via docker/offline-creds.Dockerfile.dockerignore.
COPY . .

# Fresh, platform-correct install. HUSKY=0 skips the git-hooks prepare step
# (there is no .git in the build context).
RUN HUSKY=0 npm ci

# The container never mounts or reads the host ~/.pi. The default command runs
# the validation and prints a single machine-checkable OFFLINE-CREDS line.
CMD ["npx", "tsx", "docker/offline-creds-check.mts"]
