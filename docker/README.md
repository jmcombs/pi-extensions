# Docker harnesses

Isolated container harnesses for validations that must run away from the
maintainer's real environment. Both harnesses run with the 1Password CLI (`op`)
**absent** and **no access to the host `~/.pi`** (throwaway `PI_CODING_AGENT_DIR`,
no volume mounts). See `docs/decisions/0008-offline-credential-validation.md`.

There are **two levels** of validation:

| Level | Image | Proves |
| --- | --- | --- |
| Credential **logic** (fast, automated gate) | `offline-creds.Dockerfile` | The credential API degrades correctly with `op` absent — by calling the functions directly (stubbed UI). |
| **Real pi + oh-my-pi onboarding** | `interactive-onboarding.Dockerfile` | Real pi **and** real oh-my-pi load the **LOCAL** headroom extension and a human can complete `/headroom_setup` with `op` absent. |

---

## 1. Credential-logic gate (`offline-creds.Dockerfile`)

```bash
bash scripts/test-offline-credentials.sh
# → OFFLINE-CREDS: op-absent=ok available=false add-key=ok resolve-literal=ok \
#   resolve-opref=undefined loads=ok keyless=ok
# → PASS: offline credential path validated with op absent.
```

This validates the *logic* (`is1PasswordAvailable`, `onboardSecret`,
`resolveSecret`, keyless `resolveConfig`) with `op` absent. It does **not** launch
real pi — use the interactive rig below for that.

---

## 2. Interactive onboarding rig (`interactive-onboarding.Dockerfile`)

A `node:22` image with **no `op`**, **no host `~/.pi`**, that installs **real pi**
(`@earendil-works/pi-coding-agent`, the pinned root devDep) and **real oh-my-pi**
(`@oh-my-pi/pi-coding-agent`, run under Bun), COPYs the **LOCAL** monorepo, and
`npm ci`s it — so both agents load the **workspace** `packages/headroom` and its
workspace `@jmcombs/pi-1password`, NOT the npm-published packages.

### Build

```bash
docker build -f docker/interactive-onboarding.Dockerfile -t pi-ext-interactive:latest .
```

### Non-interactive smoke proofs (both agents)

```bash
docker run --rm pi-ext-interactive:latest
# == pi (GATE) ==
# PI-SMOKE: agent=pi op-absent=ok headroom-loaded=ok setup=ok retrieve=ok \
#   session_start=ok local-headroom=/app/packages/headroom/index.ts \
#   local-1password=/app/packages/1password/index.ts
# == oh-my-pi (GATE) ==
# OHMYPI-SMOKE: agent=oh-my-pi omp-version=omp/17.0.5 op-absent=ok ext-load=ok setup=ok \
#   retrieve=ok session_start=ok local-headroom=/app/packages/headroom/index.ts \
#   local-1password=/app/packages/1password/index.ts
```

Each smoke drives that agent's **own** real extension loader (not a stub) and both
are gates: they prove real pi and real oh-my-pi load the LOCAL headroom extension
(+ LOCAL `@jmcombs/pi-1password`) with `op` absent and register `headroom_setup` /
`headroom_retrieve` / `session_start` from the workspace copies.

### Walk `/headroom_setup` in real pi (op absent)

```bash
docker run --rm -it pi-ext-interactive:latest bash docker/run-pi.sh
# Inside: pi's TUI starts (placeholder model, PI_OFFLINE=1 — no "configure a model"
# wall). [Extensions] shows `headroom`. At the prompt:
#   /headroom_setup
# → op is absent, so onboarding goes straight to MASKED manual key entry (no vault
#   picker); the typed key is drawn as bullets, never shown to the agent, and is
#   written to $PI_CODING_AGENT_DIR/auth.json (a throwaway dir, never ~/.pi).
```

`run-pi.sh` passes `--provider openai --model gpt-4o --api-key placeholder` purely
to get past model selection; `/headroom_setup` never calls the model. Swap in a
real `--api-key` if you also want the model to answer.

### Walk `/headroom_setup` in real oh-my-pi (op absent)

```bash
docker run --rm -it pi-ext-interactive:latest bash docker/run-ohmypi.sh
# Inside: press enter to skip omp's intro; omp reaches the prompt (OMP_SKIP_SETUP=1
# skips its first-run wizard). At the prompt:
#   /headroom_setup   → masked manual key entry (op absent), written to the
#   throwaway $PI_CODING_AGENT_DIR/auth.json (never ~/.pi).
```

**How oh-my-pi is made to load our LOCAL extension (container-level, no product
change).** omp registers a process-global `Bun.plugin` `onResolve` hook that
**hard-remaps** every `@earendil-works/pi-coding-agent` import to its own
`legacy-pi-coding-agent-shim.ts` (so plugins share omp's single runtime) — with no
env/flag/config override. That shim re-exports `createBashTool` + `getAgentDir` but
has **no `createLocalBashOperations`**, which `@jmcombs/pi-1password` imports at
top level, so headroom could not link under omp. Pinning/deduping/symlinking the
real package can't help — the hook intercepts before filesystem resolution.

The image therefore appends a **container-only exports override** to omp's shim,
re-exporting the **REAL** symbol from the genuine
`@earendil-works/pi-coding-agent@0.80.9` already in `node_modules` via an
**absolute-path import** (which the bare-specifier filter does not intercept):

```ts
export { createLocalBashOperations } from "/app/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js";
```

This surfaces the real symbol from the real runtime (not a stub) and patches only
the third-party omp shim in the image — `packages/**` is untouched. omp is pinned to
`17.0.5`; the build fails if omp ever ships the export itself (drop the override
then). See `docs/decisions/0008-offline-credential-validation.md`.
