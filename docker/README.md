# Docker harnesses

Isolated container harnesses for validations that must run away from the
maintainer's real environment. Both harnesses run with the 1Password CLI (`op`)
**absent** and **no access to the host `~/.pi`** (throwaway `PI_CODING_AGENT_DIR`,
no volume mounts). See `docs/decisions/0008-offline-credential-validation.md`.

There are **two levels** of validation:

| Level | Image | Proves |
| --- | --- | --- |
| Credential **logic** (fast, automated gate) | `offline-creds.Dockerfile` | The credential API degrades correctly with `op` absent — by calling the functions directly (stubbed UI). |
| **Real pi + oh-my-pi onboarding** | `interactive-onboarding.Dockerfile` | Real pi (and, when unblocked, oh-my-pi) loads the **LOCAL** headroom extension and a human can complete `/headroom_setup` with `op` absent. |

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
# == oh-my-pi (REPORT) ==
# OHMYPI-SMOKE: agent=oh-my-pi omp-version=omp/17.0.5 op-absent=ok ext-load=BLOCKED reason="… createLocalBashOperations not found …"
```

Each smoke drives that agent's **own** real extension loader (not a stub):
`PI-SMOKE` proves real pi loads the LOCAL headroom extension with `op` absent and
registers `headroom_setup` / `headroom_retrieve` / `session_start` from the
workspace copy. `OHMYPI-SMOKE` reports oh-my-pi's result honestly (see the blocker
below).

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

### oh-my-pi (known blocker — escalated)

oh-my-pi **installs and runs** cleanly under Bun, but currently **cannot load our
extension**. omp's `legacy-pi-coding-agent-shim.ts` re-exports `createBashTool` and
`getAgentDir` but **not `createLocalBashOperations`**, which
`@jmcombs/pi-1password/index.ts` imports at module top-level (for its `1p_run` bash
tool). The ESM link fails, so headroom — any consumer of `@jmcombs/pi-1password` —
does not load under omp and `/headroom_setup` is unavailable there.

This is a real oh-my-pi compatibility gap in the merged Phase-2 1Password package
(out of Phase 6 scope). A minimal fix: make `@jmcombs/pi-1password` import the bash
operations **lazily** (dynamic import inside the `1p_run` tool) so the credential
API loads without them. Reproduce and observe it:

```bash
docker run --rm -it pi-ext-interactive:latest bash docker/run-ohmypi.sh
# Re-proves the blocker via omp's own loader, then launches omp so you can see it.
```
