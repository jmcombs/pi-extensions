# Docker harnesses

Isolated container harnesses for validations that must run away from the
maintainer's real environment.

## Offline (no-`op`) credential validation — ADR 0008

Proves the `@jmcombs/pi-1password` credential API and the `headroom` consumer work
when the 1Password CLI (`op`) is **absent**: the extension loads, a key can be
added and resolved without `op`, an `!op read` reference degrades to `undefined`
gracefully, and keyless local proxies still function.

- `offline-creds.Dockerfile` — a `node:22` image with **no `op` binary** (the build
  fails if the base ever ships one) and **no access to the host `~/.pi`**. The
  workspace is installed fresh on Linux (`npm ci`); macOS host `node_modules` are
  excluded via `offline-creds.Dockerfile.dockerignore`.
- `offline-creds-check.mts` — the headless check, run inside the container against a
  throwaway `PI_CODING_AGENT_DIR` chosen per scenario (never `~/.pi`).
- `../scripts/test-offline-credentials.sh` — builds the image, runs the check, and
  asserts the single result line.

### Run the automated check

```bash
bash scripts/test-offline-credentials.sh
# → OFFLINE-CREDS: op-absent=ok available=false add-key=ok resolve-literal=ok \
#   resolve-opref=undefined loads=ok keyless=ok
# → PASS: offline credential path validated with op absent.
```

No volumes are mounted (`docker run --rm` with no `-v`), so the host `~/.pi` is
unreachable from the container.

### Drive `headroom_setup` interactively (eyeball the real TUI, no `op`)

To confirm the manual/masked-entry onboarding branch by hand in the same op-less,
isolated container, open an interactive shell in the image and point pi at a
throwaway agent dir (never `~/.pi`):

```bash
# Build the image first (or let the script above build it):
docker build -f docker/offline-creds.Dockerfile -t pi-ext-offline-creds:latest .

# Open a shell in the op-less container:
docker run --rm -it --entrypoint bash pi-ext-offline-creds:latest

# ── inside the container ──────────────────────────────────────────────
command -v op            # empty → op is genuinely absent
export PI_CODING_AGENT_DIR=/tmp/agent   # throwaway; the check never touches ~/.pi
mkdir -p "$PI_CODING_AGENT_DIR"

# Launch pi with the headroom extension loaded (install pi in the container first
# if it is not already on PATH, e.g. `npm i -g @earendil-works/pi-coding-agent`
# per that package's CLI docs), then run the setup command:
pi -ne -e packages/headroom/index.ts
#   /headroom_setup
#   → because op is absent, onboarding goes straight to the MASKED manual key
#     entry (no vault picker); the typed key is drawn as bullets and never shown
#     to the agent, and is written to $PI_CODING_AGENT_DIR/auth.json.
#   Re-run /headroom-status to confirm the extension is healthy/keyless.
```

The exact pi launch flags follow the `@earendil-works/pi-coding-agent` CLI; the key
points for this validation are that `op` is absent and `PI_CODING_AGENT_DIR` is a
throwaway directory, so the real TUI can be eyeballed without any 1Password session
and without touching the maintainer's `~/.pi`.
