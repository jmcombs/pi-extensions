# 0008 — Offline (no-`op`) credential validation

- Status: Accepted
- Phase: 6 (headroom → 1Password credential API; full-repo green) — gates the merge
- Date: 2026-07-19

> Note: like the other ADRs in this directory, this ADR's number is scoped to the
> `docs/1p-credential-api/` plan's Appendix A decision log (which numbers from
> `0001`); the filename slug disambiguates it from any unrelated repo ADR sharing
> the number.

## Context

The 1Password credential API (`@jmcombs/pi-1password`) and its consumers are
designed to degrade gracefully when the 1Password CLI (`op`) is **not installed**:

- `is1PasswordAvailable()` returns `false` (op is not on PATH), so onboarding takes
  the **manual / masked literal-entry** branch instead of the vault picker (D6).
- `resolveSecret` returns a stored **literal** key directly (no `op` needed) and
  **fails closed to `undefined`** for an `!op read 'op://…'` reference it cannot
  resolve — never throwing, never leaking the raw reference (D5).
- Consumers that front a **keyless** local service (e.g. `headroom`'s local proxy)
  keep working with `apiKey: undefined`.

These behaviors were covered by unit tests that steer availability by manipulating
`PATH`, but there was no end-to-end proof in a **genuinely op-less environment** —
a machine where the `op` binary truly does not exist and there is no host `~/.pi`
to accidentally read. The maintainer requested a real offline validation —
"add an API key without `op`" — as a **must-pass gate on the Phase 6 merge**.

## Decision

The maintainer approved a **Docker-based offline validation** (must-pass, gates the
Phase 6 merge). It runs in a container built from `node:22` with:

- **No `op` binary** — the image build fails if the base ever ships one
  (`command -v op` must be empty), so the check exercises the real op-absent path.
- **No access to the host `~/.pi`** — no volumes are mounted; the check writes to a
  throwaway `PI_CODING_AGENT_DIR` (a fresh `mkdtemp` dir) chosen per scenario, which
  `getAgentDir()` honors. The maintainer's real agent directory is never read or
  written.

The check (`docker/offline-creds-check.mts`), run inside the container, asserts:

1. `command -v op` → empty (op is genuinely absent).
2. `is1PasswordAvailable()` → **false**.
3. **Add a key without `op`:** `onboardSecret(ctx, { name: "headroom", label:
   "Headroom" })`, driven by a `{ ui }` double that takes the manual/literal-entry
   branch, writes `{"headroom":{"type":"api_key","key":"<literal>"}}` to `auth.json`.
4. `resolveSecret("headroom")` → returns the literal (no `op` needed).
5. An entry whose key is `!op read op://Vault/Item/field` → `resolveSecret` →
   **`undefined`** (graceful fail-closed, no throw with `op` absent).
6. **Extension loads without `op`:** importing `packages/headroom/index.ts` and
   invoking its factory against a stub `ExtensionAPI` registers `headroom_setup`
   and `headroom_retrieve` (and the `session_start` handler) without throwing.
7. **headroom keyless:** `resolveConfig()` → `apiKey: undefined`, and `getClient()`
   constructs a `fallback: true` client — no crash.

It prints a single machine-checkable line and exits non-zero on any failed
assertion:

```
OFFLINE-CREDS: op-absent=ok available=false add-key=ok resolve-literal=ok resolve-opref=undefined loads=ok keyless=ok
```

Artifacts:

- `docker/offline-creds.Dockerfile` (+ `docker/offline-creds.Dockerfile.dockerignore`)
- `docker/offline-creds-check.mts`
- `scripts/test-offline-credentials.sh` (build + run + assert)

## Two levels of validation (honesty note)

The headless check above is a **fast automated gate on the credential LOGIC**. It
does **not** launch real pi or let a human complete onboarding — it stubs the TUI
and calls the credential functions directly. It answers "does the credential logic
degrade correctly with `op` absent?", not "does real pi, with our extension
installed, actually onboard with `op` absent?".

For the second question we add a **separate interactive rig**
(`docker/interactive-onboarding.Dockerfile`) — a `node:22` image, still with **no
`op`** and **no host `~/.pi`**, that installs **real pi**
(`@earendil-works/pi-coding-agent`, the pinned root devDep) and **real oh-my-pi**
(`@oh-my-pi/pi-coding-agent`, run under Bun, the engine it declares), COPYs the
**LOCAL** monorepo, and `npm ci`s it so both agents load the **workspace**
`packages/headroom` + `@jmcombs/pi-1password` (the branch code), not the
npm-published packages. The maintainer can then walk `/headroom_setup` in the real
TUI with `op` absent via `docker/run-pi.sh` / `docker/run-ohmypi.sh`.

Two non-interactive smoke proofs guard against handing over another false positive
(they drive each agent's OWN real extension loader, not a stub):

```
PI-SMOKE: agent=pi op-absent=ok context7=ok context7_setup=ok context7_search=ok context7_get_docs=ok headroom=ok headroom_setup=ok headroom_retrieve=ok session_start=ok local-context7=/app/packages/context7/index.ts local-headroom=/app/packages/headroom/index.ts local-1password=/app/packages/1password/index.ts
OHMYPI-SMOKE: agent=oh-my-pi omp-version=omp/17.0.5 op-absent=ok context7=ok context7_setup=ok context7_search=ok context7_get_docs=ok headroom=ok headroom_setup=ok headroom_retrieve=ok session_start=ok local-context7=/app/packages/context7/index.ts local-headroom=/app/packages/headroom/index.ts local-1password=/app/packages/1password/index.ts
```

Both agents load the LOCAL `context7` + `headroom` extensions (+ LOCAL
`@jmcombs/pi-1password`) with `op` absent, register their setup commands + tools,
and their interactive TUIs start to a usable prompt with a **placeholder model**
(`--provider openai --model gpt-4o --api-key placeholder` + `PI_OFFLINE=1`; omp
additionally needs `OMP_SKIP_SETUP=1` to skip its first-run wizard) — the setup
commands never call the model, so there is no "configure a model" wall.

### oh-my-pi compatibility — product-level feature-detect (STOCK omp, no image patch)

omp does **not** resolve `@earendil-works/pi-coding-agent` to the real npm package.
Its `installLegacyPiSpecifierShim` registers a **process-global `Bun.plugin`
`onResolve` hook** (`extensibility/plugins/legacy-pi-compat.ts`) that matches every
`@{oh-my-pi,mariozechner,earendil-works}/pi-{coding-agent,tui,ai,…}` specifier and
remaps it to omp's own `legacy-pi-coding-agent-shim.ts` — **by design**, so plugins
share omp's single module/tool registry. There is **no env/flag/config override**,
and the hook intercepts before filesystem resolution, so pinning/deduping/symlinking
the real package cannot win. omp's shim re-exports `createBashTool` + `getAgentDir`
but has **no `createLocalBashOperations` at all** (omp exposes no equivalent), which
`@jmcombs/pi-1password` originally imported as a **static named import** at module
top-level — so the ESM link failed and every consumer of `@jmcombs/pi-1password`
(context7, headroom, …) could not load under omp.

**The fix is in the product, at the resolution layer, not in the container.**
`@jmcombs/pi-1password` keeps `createBashTool`/`getAgentDir` as static named imports
(present on omp's shim) but accesses `createLocalBashOperations` through a
**namespace import** (`import * as piRuntime from "@earendil-works/pi-coding-agent"`),
so a missing member is `undefined` at runtime rather than a hard link error. The
`user_bash` hook (transparent 1P injection for user `!bash`) is registered **only
when the member is present**:

```ts
if (typeof piRuntime.createLocalBashOperations === "function") {
  pi.on("user_bash", () => ({ operations: piRuntime.createLocalBashOperations() }));
}
```

This is behaviour-preserving on real pi (hook registers, `!`-injection works —
verified `user_bash=true`) and lets the module link + load on stock omp, where the
hook is simply skipped (`user_bash=false`) while the transparent agent-bash
injection (`createBashTool`) and `1p_diagnose` remain. The rig therefore validates
against **stock, unpatched omp** — the real-world proof — with **no image-level shim
patch**. As part of the same change the LLM-facing **`1p_run` tool was retired** (the
transparent `createBashTool` injection covers running commands under 1P), removing
the last non-load-critical consumer of `createLocalBashOperations`.

Interactive-rig artifacts:

- `docker/interactive-onboarding.Dockerfile` (+ `.dockerignore`) — installs real pi
  and **stock** oh-my-pi; no shim patch.
- `docker/pi-smoke.mts`, `docker/ohmypi-smoke.mts`, `docker/smoke-both.sh`
- `docker/run-pi.sh`, `docker/run-ohmypi.sh` — load context7 + headroom on each agent.
- `docker/README.md` — build/run/onboard steps for both agents.

## Consequences

- Phase 6 gains a **must-pass automated** Testing Gate on the credential logic
  (`bash scripts/test-offline-credentials.sh`, capability `docker-offline`) that
  must be green before the migration merges.
- The **real-pi / real-oh-my-pi interactive onboarding** validation is a
  **human-verify** gate (capability `pi-onboard-offline`, like `pi-onboard-tui` /
  `op-live`): the maintainer walks `/context7_setup` and `/headroom_setup` in the
  op-less container via `docker/run-pi.sh` / `docker/run-ohmypi.sh`. Its
  non-interactive companions (`PI-SMOKE` / `OHMYPI-SMOKE`) are automated and prove
  both agents load the LOCAL extensions.
- The offline/degraded path is proven at two levels: the credential LOGIC (headless
  check) and BOTH real agents loading the workspace extensions, not just via `PATH`
  manipulation in unit tests.
- **Stock oh-my-pi now loads our extensions** thanks to the product-level
  feature-detect in `@jmcombs/pi-1password` (no image-level shim patch).
- **`1p_run` retired** from `@jmcombs/pi-1password` (transparent `createBashTool`
  injection supersedes it); its tests + the `1p_diagnose` description / docs are
  updated. Historical records (ADR 0003, Phase 2 scope, CHANGELOG) are left intact.
- The only product change is `packages/1password/index.ts` (feature-detect +
  `1p_run` retirement). Neither container touches the host `~/.pi` (throwaway
  `PI_CODING_AGENT_DIR`, no volume mounts), consistent with the isolation posture of
  D14.
