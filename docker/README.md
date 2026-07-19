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
docker run --rm pi-ext-interactive:latest        # or: npm run validate:extension-load
# == pi extension load check (op absent) ==
# SKIP: packages/_template (@jmcombs/pi-EXTENSION_NAME) — private:true
# PASS pi 1password: tools[bash,1p_diagnose] handlers[session_start,user_bash]
# PASS pi context7: tools[context7_search,context7_get_docs] commands[context7_setup]
# … (one PASS line per non-private package) …
# PASS pi relay: providers[relay-claude,relay-grok]
# PI-SMOKE: platform=pi packages=10 pass=10 fail=0 skipped=1
# == oh-my-pi extension load check (op absent) ==
# PASS oh-my-pi 1password: tools[bash,1p_diagnose] handlers[session_start,!user_bash]
# … (user_bash is pi-only: asserted ABSENT on oh-my-pi, shown as !user_bash) …
# OHMYPI-SMOKE: platform=oh-my-pi omp-version=omp/17.0.5 packages=10 pass=10 fail=0 skipped=1
```

Each smoke drives that agent's **own** real extension loader (not a stub) and both
are gates: they prove real pi and **stock** oh-my-pi load **every** non-private
`packages/*` extension (+ their LOCAL `@jmcombs/pi-1password`) with `op` absent and
register each package's expected, platform-aware surface from the workspace copies.
Discovery + the expected-surface table live in `docker/smoke-harness.mts`.

> **Registration ≠ TUI routing.** These smokes prove the commands *register*; they
> do not prove the running TUI *surfaces and routes* them. That is the interactive
> walkthrough below (PTY-verified: `/context7_setup` + `/headroom_setup` open the
> masked manual-entry UI on both agents). A launch-flag gotcha matters here — see
> the omp note below.

### Walk `/context7_setup` + `/headroom_setup` in real pi (op absent)

```bash
docker run --rm -it pi-ext-interactive:latest bash docker/run-pi.sh
# Inside: pi's TUI starts (placeholder model, PI_OFFLINE=1 — no "configure a model"
# wall). [Extensions] shows `context7, headroom`. At the prompt:
#   /context7_setup   and/or   /headroom_setup
# → op is absent, so onboarding goes straight to MASKED manual key entry (no vault
#   picker); the typed key is drawn as bullets, never shown to the agent, and is
#   written to $PI_CODING_AGENT_DIR/auth.json (a throwaway dir, never ~/.pi).
```

`run-pi.sh` passes `--provider openai --model gpt-4o --api-key placeholder` purely
to get past model selection; the setup commands never call the model. Swap in a
real `--api-key` if you also want the model to answer.

### Walk `/context7_setup` + `/headroom_setup` in STOCK oh-my-pi (op absent)

```bash
docker run --rm -it pi-ext-interactive:latest bash docker/run-ohmypi.sh
# Inside: press enter to skip omp's intro; omp reaches the prompt (OMP_SKIP_SETUP=1
# skips its first-run wizard). At the prompt:
#   /context7_setup  and/or  /headroom_setup   → masked manual key entry (op absent),
#   written to the throwaway $PI_CODING_AGENT_DIR/auth.json (never ~/.pi).
```

> **omp launch-flag gotcha.** `run-ohmypi.sh` must **not** pass `--no-extensions`.
> Unlike pi (where `-ne` keeps explicit `-e` paths), omp *discards* the `-e` paths
> when `--no-extensions` is set (`cliExtensionPaths = noExtensions ? [] : extensions`,
> omp `src/cli/models-cli.ts`) — so the extensions never load and `/context7_setup` /
> `/headroom_setup` fall through to the model as chat. The script omits the flag; the
> empty throwaway agent dir means discovery finds nothing else, so only the two `-e`
> extensions load. (`run-pi.sh` keeps `--no-extensions` — correct on pi.)

**Why this works on STOCK (unpatched) oh-my-pi.** omp registers a process-global
`Bun.plugin` `onResolve` hook that **hard-remaps** every
`@earendil-works/pi-coding-agent` import to its own `legacy-pi-coding-agent-shim.ts`
(so plugins share omp's single runtime) — with no env/flag/config override. That shim
re-exports `createBashTool` + `getAgentDir` but has **no `createLocalBashOperations`**.
Originally `@jmcombs/pi-1password` imported that symbol as a static named import, so
the ESM link failed and every consumer (context7, headroom) failed to load under omp.

The fix is **in the product, not the container**: `@jmcombs/pi-1password` accesses
`createLocalBashOperations` through a **namespace import**
(`import * as piRuntime from "@earendil-works/pi-coding-agent"`) and registers the
`user_bash` hook only when the member is present. A missing member is then `undefined`
at runtime instead of a link error, so the module loads on omp's shim unmodified. On
real pi the member exists, the hook registers, and `!`-injection is unchanged. The
image installs **stock omp** (pinned `17.0.5`) with **no shim patch**. See
`docs/decisions/0008-offline-credential-validation.md`.
