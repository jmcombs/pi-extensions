# 0009 — Cross-platform contributor validation (pi + stock oh-my-pi)

- Status: Accepted
- Phase: 11 (Contributor cross-platform validation) — supersedes Phase 8's automated portion
- Date: 2026-07-19

> Note: like the other ADRs in this directory, this ADR's number is scoped to the
> `docs/1p-credential-api/` plan's Appendix A decision log (which numbers from
> `0001`); the filename slug disambiguates it from any unrelated repo ADR sharing
> the number.

## Context

Phase 6 (ADR 0008) proved, for `context7` + `headroom`, that our extensions load
and register on **real pi** and **stock oh-my-pi** with `op` absent — after a
product-level feature-detect in `@jmcombs/pi-1password` and an omp launch-flag fix
(`--no-extensions` discards explicit `-e` paths on omp; kept only on pi). That
validation was extension-specific and Docker-only.

A regression on any of the other shipped packages (a new static import of a symbol
omp's compat shim omits, a provider that stops registering, etc.) would ship
silently. We want a **repeatable, package-agnostic** guard that a contributor and CI
can run, proving every shipped extension still loads + registers on both runtimes.

Empirical baseline (researcher, verified today): **all 10 shipped packages load
clean on both pi and stock oh-my-pi** — including `relay`, which registers its
providers cleanly under omp and needs **no** feature-detect. So Phase 11 is a
**regression guard, not a red→green fix.**

## Decision

The maintainer approved the following approach.

### Per-package contract: "loads + registers its own DECLARED surface, platform-aware"

The harness asserts, per in-scope package, that it **loads without error** and
**registers its own expected surface** — *not* a blanket "registers ≥1 command and
≥1 tool", and *not* "identical on both runtimes". The expected surface is
**enumerated per package** and may be **platform-conditional**:

- `context7` / `grok-search` / `tavily-search` / `headroom` — a setup command + at
  least its tool(s) (e.g. `context7_setup` + `context7_search`/`context7_get_docs`).
- `1password` — tools (`bash` injection + `1p_diagnose`) + a `session_start`
  handler; **plus the `user_bash` hook on pi ONLY** (feature-detect, ADR 0008) — so
  the expected surface for `1password` is platform-conditional (`user_bash` expected
  on pi, expected-absent on omp).
- `relay` — **providers only** (it registers no commands/tools). The loader result
  exposes **no `providers` field**, so relay is verified through a **stub
  `ExtensionAPI` that captures `registerProvider`** (mirror
  `packages/relay/index.test.ts:42-45`), not via the loader's `commands`/`tools`
  maps.
- `better-toolsy` — tools only.
- `prompt-enhancer` — commands + event handlers + **shortcuts**, **no** tools.
- `blue-psl-10k` / `notify` — event handlers (+ possibly one command).

An **UNEXPECTED non-load** (a package that fails to load, or registers nothing when
its enumerated surface says it should) is a **failure, not a skip**. The skip set is
an allowlisted, enumerated set (see exclusion below) — never "skip anything that
looks empty".

### Scope selection: exclude `private:true`

In-scope packages are discovered from `packages/*` and each package's
`package.json`, **excluding `private:true`** — which today drops **only**
`packages/_template` (verified: it is the sole `private` package; the other 10 are
`private:false`). The exclusion is **logged** so a future `private` package is
visibly skipped rather than silently missed.

### Provider-only extensions (relay) via a stub API

Because pi's / omp's loader `Extension` result has `commands` / `tools` / `handlers`
maps but **no `providers` map**, provider-only packages are loaded through the real
loader for the "loads without error" assertion **and** invoked with a stub
`ExtensionAPI` (capturing `registerProvider`) to assert the provider surface —
mirroring the existing `packages/relay/index.test.ts` pattern, using pi's public
API shape (no hand-rolled internals).

### CI: runner-native, advisory-first

CI runs the smokes **runner-native**, not by building the ~4 GB Docker image per PR:

- Hosted GitHub runners already have **no `op`** and **no `~/.pi`** — the exact
  op-absent, no-host-secret-state condition ADR 0008 requires (a repo checkout on a
  runner is fine; "no volume mounts" in ADR 0008 is about host secret state, not
  runners).
- pi path: `npm ci` → run the pi-loader smoke.
- omp path: `setup-bun` (**pinned** Bun) + `bun install -g @oh-my-pi/pi-coding-agent`
  (**pinned `@17.0.5`**) → run the omp-loader smoke.
- The Docker image (`docker/interactive-onboarding.Dockerfile`) is retained for the
  **local** `npm run validate:cross-platform` command, which guarantees op-absence
  on a contributor machine that may have `op` installed.

The CI job is **advisory (informational) in Phase 11** — it is **NOT** added to the
branch-protection required-check set. Promoting it to a 4th **required** check is
deferred to a **future ADR** that must update `CONTRIBUTING.md` (Branch Protection),
`AGENTS.md`, and the "Protect main" ruleset **together** — never silently. Phase 11
therefore does **not** alter the required-check contract (Appendix C item 7).

### Pinning

Bun is pinned in the runner setup; oh-my-pi is already pinned `@17.0.5` (ADR 0008).
Pinning keeps the omp compat-shim path + behavior stable across runs.

## Consequences

- Phase 11 generalizes the ADR-0008 smokes (`docker/pi-smoke.mts`,
  `docker/ohmypi-smoke.mts`, `docker/smoke-both.sh`) into a package-agnostic harness;
  it authors **no net-new rig** and changes **no product source**.
- Phase 8 is **narrowed**: its automated relay-load/registration assertion is
  superseded here (relay is one of P11's auto-discovered packages). Phase 8 retains
  only its unique value — the human `claude-sub` live-dispatch check (Opus under
  oh-my-pi) and `docs/1p-credential-api/relay-ohmypi-results.md`.
- The interactive onboarding PTY walkthrough and `op`-available paths remain
  **human** gates (ADR 0008); they are out of P11's automated scope.
- No `~/.pi` access and no `op`: the harness runs op-absent with a throwaway agent
  dir (D14 / ADR 0008), on a Docker container locally and natively on a hosted runner.
