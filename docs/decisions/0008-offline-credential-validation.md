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
PI-SMOKE: agent=pi op-absent=ok headroom-loaded=ok setup=ok retrieve=ok session_start=ok local-headroom=/app/packages/headroom/index.ts local-1password=/app/packages/1password/index.ts
OHMYPI-SMOKE: agent=oh-my-pi omp-version=omp/17.0.5 op-absent=ok ext-load=ok setup=ok retrieve=ok session_start=ok local-headroom=/app/packages/headroom/index.ts local-1password=/app/packages/1password/index.ts
```

Both agents load the LOCAL headroom extension (+ LOCAL `@jmcombs/pi-1password`)
with `op` absent, register `headroom_setup` / `headroom_retrieve` /
`session_start`, and their interactive TUIs start to a usable prompt with a
**placeholder model** (`--provider openai --model gpt-4o --api-key placeholder` +
`PI_OFFLINE=1`; omp additionally needs `OMP_SKIP_SETUP=1` to skip its first-run
wizard) — `/headroom_setup` never calls the model, so there is no "configure a
model" wall.

### oh-my-pi resolution mechanism (container-level, no product change)

omp does **not** resolve `@earendil-works/pi-coding-agent` to the real npm package.
Its `installLegacyPiSpecifierShim` registers a **process-global `Bun.plugin`
`onResolve` hook** (`extensibility/plugins/legacy-pi-compat.ts`) that matches every
`@{oh-my-pi,mariozechner,earendil-works}/pi-{coding-agent,tui,ai,…}` specifier and
remaps it to omp's own `legacy-pi-coding-agent-shim.ts` — **by design**, so plugins
share omp's single module/tool registry. There is **no env/flag/config override**,
and the hook intercepts before filesystem resolution, so pinning/deduping/symlinking
the real package cannot win (maintainer Options 1 & 2 are impossible). omp's shim
re-exports `createBashTool` + `getAgentDir` but has **no `createLocalBashOperations`
at all** (omp exposes no equivalent), which `@jmcombs/pi-1password` imports at module
top-level for its `1p_run` bash tool — so the ESM link failed and headroom could not
load under omp.

The fix is **container-level only** (maintainer Option 3 — "exports override in the
container image build"): the image appends one line to omp's shim re-exporting the
**REAL** `createLocalBashOperations` from the genuine
`@earendil-works/pi-coding-agent@0.80.9` already installed in `node_modules`, using
an **absolute-path import** (which the bare-specifier filter does not intercept):

```ts
// [container-only, ADR 0008] surface the real pi export omp's shim omits.
export { createLocalBashOperations } from "/app/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js";
```

This surfaces the real symbol from the real runtime — not a stub — and touches
**only** the third-party omp shim inside the image. `packages/**` product source is
unchanged; everything else still resolves through omp's shim, preserving its
single-runtime invariant. omp is pinned (`@17.0.5`) so the shim path is stable, and
the build fails if omp ever ships the export itself (so the override can be dropped).

Interactive-rig artifacts:

- `docker/interactive-onboarding.Dockerfile` (+ `.dockerignore`)
- `docker/pi-smoke.mts`, `docker/ohmypi-smoke.mts`, `docker/smoke-both.sh`
- `docker/run-pi.sh`, `docker/run-ohmypi.sh`
- `docker/README.md` — build/run/onboard steps for both agents + the omp blocker.

## Consequences

- Phase 6 gains a **must-pass automated** Testing Gate on the credential logic
  (`bash scripts/test-offline-credentials.sh`, capability `docker-offline`) that
  must be green before the migration merges.
- The **real-pi / real-oh-my-pi interactive onboarding** validation is a
  **human-verify** gate (capability `pi-onboard-offline`, like `pi-onboard-tui` /
  `op-live`): the maintainer walks `/headroom_setup` in the op-less container via
  `docker/run-pi.sh` / `docker/run-ohmypi.sh`. Its non-interactive companions
  (`PI-SMOKE` / `OHMYPI-SMOKE`) are automated and prove both agents load the LOCAL
  extension.
- The offline/degraded path is proven at two levels: the credential LOGIC (headless
  check) and BOTH real agents loading the workspace extension, not just via `PATH`
  manipulation in unit tests.
- **oh-my-pi now loads the extension** via a container-only exports override (above),
  surfacing the real `createLocalBashOperations`. No `packages/**` product source is
  changed — the override lives only in the image build.
- No product code changed: this ADR adds validation + a container-image resolution
  override only. Neither container touches the host `~/.pi` (throwaway
  `PI_CODING_AGENT_DIR`, no volume mounts), consistent with the isolation posture of
  D14.
