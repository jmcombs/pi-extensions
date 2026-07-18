# PLAN — 1Password credential API for pi extensions

> Phase-loop build spec. The builder implements one phase at a time from this file;
> the verifier proves each phase against it. Follow it **literally**. Not shipped in
> any npm tarball.
>
> **Authoritative context:** pi 0.80.8 removed the exported `AuthStorage` class
> (changelog: "AuthStorage and its storage backends are no longer exported"),
> breaking `context7`, `grok-search`, `tavily-search`, and `headroom`, all of which
> call `AuthStorage.create()`. This plan replaces that with a stateless credential
> API exported by the **`@jmcombs/pi-1password`** extension, which the other
> extensions take as a dependency and import. Research backing every decision below
> lives in `memory/pi-0808-auth-migration.md` and the maintainer decisions recorded
> in the design thread.

## Summary

Make the **1Password extension the credential authority**. It already contains, in
`packages/1password/index.ts`, a working `!op read` resolver (`resolveShellValue`,
line 194), a safe `auth.json` writer (`addAuthEntry`, line 294), a live 1Password
vault→item→field picker (`pickOpReferenceSimple`, line 541), and an `op` status
probe (`getOpStatus`, line 75). This plan promotes those internals to a **stateless,
importable public API** (`resolveSecret` / `onboardSecret` / `changeSecret` /
`verifySecret` / `deleteSecret` / `is1PasswordAvailable`), adds a **conditional
warm-on-load** unlock, and migrates the four broken consumer extensions onto it —
deleting all `AuthStorage` and `ModelRuntime` usage. Onboarding **branches on
1Password availability**: the vault picker when `op` is usable, manual key entry
otherwise. The API is **extensively documented for third-party developers**, with
mermaid diagrams. `relay` needs no functional change but is compat-tested against
oh-my-pi in isolation; `prompt-enhancer` needs only an unrelated
`@earendil-works/pi-ai/compat` import fix.

## How to use this document

- The loop is **build → verify** per phase: the builder implements one phase from
  its literal TODOs; the verifier re-runs that phase's Testing Gates against real
  output and ticks the checkboxes. **Only the verifier ticks checkboxes.**
- **TODOs are literal.** Every path named is a real file to create/edit at exactly
  that path. Gates are real, runnable commands with concrete expected results.
- **Locked Decisions are frozen.** A deviation requires an ADR in
  `docs/decisions/` and an Appendix A row before it is implemented.
- **Max 3 failed-gate fix loops** per phase, then escalate to the human.
- **One PR per phase.** Merges and checkbox ticks happen only in a separate,
  human-approved merger step (per `AGENTS.md` → Branch Protection; release PRs are
  merged manually by the maintainer).

## Locked Decisions (frozen)

| ID  | Decision | Value / Source |
| --- | --- | --- |
| D1  | Credential authority | The `@jmcombs/pi-1password` package **exports** the credential API; consumers **import** it. (Maintainer decision.) |
| D2  | Consumer dependency type | Consumers declare `@jmcombs/pi-1password` in **`dependencies`** (hard dependency), never `peerDependencies` — pi installs extensions with `--legacy-peer-deps` / `--omit=peer` (`package-manager.js:1462,1475`), so a peer would not be installed and the import would fail. The dependency auto-installs, so the 1p API code is always importable. |
| D3  | Stateless API | Exported functions read `auth.json` + run `op` **fresh** on every call; they must **not** rely on any module-level session state. pi loads each extension in its own jiti with `moduleCache: false` (`loader.js:314–315`), so a consumer's `import` is a fresh module instance. Verified empirically. |
| D4  | Storage shape | Provider-shaped entry keyed by **logical name**: `{"context7": {"type":"api_key","key":"!op read 'op://…'"}}`. Keeps existing `auth.json` entries working; stays out of the bash spawn-hook env. (Maintainer Q1.) |
| D5  | Read path | `resolveSecret(name)` = `readFile(auth.json)` → `parsed[name]` → `resolveShellValue(entry.key ?? entry)`. **No `ModelRuntime`, no `AuthStorage`, no `readStoredCredential`.** Reads couple only to the local file + the `op` CLI. Handles both provider-shaped objects and bare literal strings. |
| D6  | Onboarding = availability-branched | `onboardSecret` first runs an **upfront overwrite gate** (Replace / Keep) when the key already exists, then checks `is1PasswordAvailable()` (= `op` installed **and** an auth path **configured** — service-account token, Connect env, or a desktop/CLI account via `op account list`; **not** gated on `op whoami`/`signedIn`, which false-negatives under the desktop-app biometric integration — see ADR 0003). **Available →** a source menu with three options (UX redesign, ADR 0005): **Locate in 1Password** (the live vault→item→field picker `pickOpReferenceSimple`, with field-step auto-skip for single-credential items) or **Enter a 1Password reference** (validated `op://vault/item/field`) — both stored as `!op read`; or **Type or paste the key** — a **masked** literal entry (D4). **Not available →** the same **masked** literal entry, plus a nudge that installing the 1Password CLI keeps keys in the vault. After writing, a **post-save `verifySecret`** confirms the entry resolves. Existing literal + `!op read` keys already in `auth.json` resolve on read either way (D5). (Maintainer flowchart + ADR 0005; supersedes the earlier "1Password-only" answer.) |
| D7  | Warm-on-load | On `session_start`, scan **all** `auth.json` values (top-level strings **and** nested provider-shaped `.key`) for an `!op read` reference; if **any** exists, run **one** warm-up `op read` (value discarded) to unlock the account session; if none, stay silent. (Maintainer Q3.) |
| D8  | "Prompt once" property | The single-prompt-then-never-again behavior is the **1Password desktop-app biometric session** held by `op` — OS-level, process-independent. Preserved automatically by calling `op read`; D7 guarantees the prompt lands at startup. Verified. |
| D9  | pi peer ranges | pi-runtime peers stay `"*"`; **never pin a version floor there** — inert under pi's install (`--omit=peer`). No load-time version guard (reads use only `readFile` + `op`). |
| D10 | Use pi's public APIs | Never hand-roll or mirror pi internals. `op` is a stable external CLI contract; `auth.json` is per-key read-modify-write on pi's side (won't clobber our entries). (`memory/use-pi-public-apis`, `memory/pi-0808-auth-migration`.) |
| D11 | Out-of-scope for the migration | `relay` gets **no functional change** (owns no credentials) but IS compat-tested against oh-my-pi (Phase 8). `prompt-enhancer` needs only the `@earendil-works/pi-ai/compat` import fix (Phase 1). Verified. |
| D12 | grok-search provider keys | `grok-search` reads the **real** `xai` provider key plus `xai_search`/`grok` through the same `resolveSecret` — no special path. Verified (`packages/grok-search/index.ts:49,77–78,92`). |
| D13 | Release comms (NOT a hard breaking change) | Because existing keys resolve unchanged, the dependency auto-installs, and manual entry remains, a migrated consumer keeps working after upgrade — this is a **feature/enhancement, not a hard breaking change**. Use normal `feat(<pkg>):` / `refactor(<pkg>):` commits (no `!`). Release notes MUST still clearly describe: (a) the new 1Password integration; (b) that the onboarding UX changed (vault picker when `op` is available, manual entry otherwise); (c) existing keys keep working; (d) how to enable the 1Password extension for vault integration + startup warm-up. Consolidated guide: Phase 10. |
| D14 | oh-my-pi isolation | relay compatibility testing against oh-my-pi runs **only** in an isolated environment (Docker container, or brew + a throwaway HOME/config dir). It MUST NOT read or write the maintainer's `~/.pi`. relay code is not modified unless oh-my-pi surfaces a real break. (Maintainer decision.) |
| D15 | Developer documentation w/ mermaid | The API is **extensively documented for third-party developers**: JSDoc on every export + an API reference `docs/1p-credential-api/API.md` (Phase 2); a step-by-step developer integration guide `docs/1p-credential-api/INTEGRATION.md` (Phase 9) showing how to adopt the 1Password plugin in any extension, using context7 as the worked example. Documentation uses **mermaid diagrams** (```mermaid fenced blocks): at minimum an architecture diagram, the onboarding availability-branch flow, the resolve sequence, and the before/after (AuthStorage → 1p API). Migrated package READMEs embed the relevant diagram. (Maintainer decision.) |

## Environment capabilities

| Capability      | Available here? | Note |
| --------------- | --------------- | --- |
| node-toolchain  | yes    | `tsc -p <pkg>/tsconfig.json`, `biome check`, `vitest run` all run locally. |
| pi-ext-load     | yes    | Loading a factory via the vitest smoke-test stub (no model call) proves registration without throwing. |
| op-sentinel     | yes    | `resolveShellValue` with a `!echo …` sentinel exercises command resolution without 1Password. |
| ohmypi-env      | no     | oh-my-pi stood up in a throwaway Docker container (or brew + isolated HOME) per run; never touches `~/.pi`. Provisionable. |
| op-live         | human  | A live `op read` of a real 1Password vault ref needs the maintainer's authenticated 1Password session + Touch ID; not automatable. |
| pi-onboard-tui  | human  | The interactive onboarding TUI (vault picker / manual branch) can only be driven and reviewed by a person in a live pi session. |
| doc-render      | human  | A person confirms the mermaid diagrams render as intended and the guide reads correctly. |
| claude-sub      | human  | relay's live dispatch drives subscription Opus via `claude -p` (`oauthAccount`); a real Claude login is required, not automatable. |

## Git & PR conventions (PLAN-wide)

- **Integration branch (ADR 0001):** phase branches **P1–P9 PR into the
  long-lived `feat/1password-credential-api` branch, not `main`.** That branch is
  cut from `main`'s tip and absorbs the tracked baseline-red while the migration
  is in flight. Intermediate phase PRs (against the integration branch) **may show
  the baseline-red** for the not-yet-migrated `AuthStorage` consumers. The three
  required checks (`Quality Gate (Node 22)`, `Quality Gate (Node 24)`,
  `Commit Messages`) must be **green on the final
  `feat/1password-credential-api` → `main` PR** — by then P6 has migrated the last
  consumer and the full repo is green. **`main` stays green throughout.**
- **Branch per phase**, never the default branch. CI only runs on PRs (`AGENTS.md`).
- **Branch ↔ commit-type symmetry**, Conventional Commits scoped to the package.
  Consumer migrations are **not** breaking (D13) → no `!`:
  - P1 `chore/pi-0808-baseline` → `chore(deps):` / `fix(prompt-enhancer):`
  - P2 `feat/1password-api-exports` → `feat(1password):` (phase branch PRs into the long-lived `feat/1password-credential-api` integration branch; renamed from `feat/1password-credential-api` to avoid colliding with that integration-branch name)
  - P3 `refactor/context7-1password-api` → `refactor(context7):`
  - P4 `refactor/tavily-1password-api` → `refactor(tavily-search):`
  - P5 `refactor/grok-search-1password-api` → `refactor(grok-search):`
  - P6 `refactor/headroom-1password-api` → `refactor(headroom):`
  - P7 `docs/1password-api-template` → `docs:` / `chore(_template):`
  - P8 `test/relay-ohmypi-compat` → `test(relay):` / `chore(relay):`
  - P9 `docs/1password-integration-guide` → `docs:`
  - P10 `docs/1password-migration-guide` → `docs:`
- **One PR per phase**, targeting `feat/1password-credential-api` (ADR 0001). The
  `Commit Messages` check must be green on every phase PR; the two `Quality Gate`
  checks are required-green on the **final integration→`main` PR** and may carry
  the tracked baseline-red on intermediate phase PRs.
- **Merges and checkbox ticks happen only in a separate, human-approved merger
  step.** Do not self-merge; do not touch release-please manifests.

## Phase summary

| Phase | Scope | Entry | Branch type |
| --- | --- | --- | --- |
| P1 | Baseline: discard the abandoned `ModelRuntime` WIP; keep dep alignment + `prompt-enhancer` `/compat` fix | — | chore |
| P2 | Add + export the stateless 1Password credential API (incl. `is1PasswordAvailable`); warm-on-load; locked writer; **JSDoc + API.md** | P1 | feat |
| P3 | Migrate **context7** (reference impl); availability-branched onboarding; **live maintainer review of onboarding** | P2 | refactor |
| P4 | Migrate **tavily-search** | P2, P3 | refactor |
| P5 | Migrate **grok-search** (xai / xai_search / grok) | P2, P3 | refactor |
| P6 | Migrate **headroom**; full-repo green | P2, P3 | refactor |
| P7 | Update `_template` + `TEMPLATE.md` to teach the API pattern | P3 | docs |
| P8 | **relay ↔ oh-my-pi** compatibility test (isolated Docker/brew) | P1 | test |
| P9 | **Developer API documentation & integration guide** (mermaid diagrams) | P6 | docs |
| P10 | **Release notes & migration guide** | P6, P9 | docs |

---

## Phase 1 — Baseline reset & unrelated 0.80.8 fixes

**Entry:** none. **Shippable as:** a clean tree where `prompt-enhancer` and `relay`
build and test green on pi 0.80.9+, with the abandoned `ModelRuntime` experiment
removed. The four `AuthStorage` consumers remain red (pre-existing breakage this
plan fixes in P3–P6).

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

- **In:** discard all working-tree changes from the abandoned `ModelRuntime`
  approach; keep the two independent fixes (root pi dep alignment; `prompt-enhancer`
  `/compat` import). Confirm `relay` needs nothing.
- **Out:** any credential-API code (P2+); any consumer migration.

### Architectural Constraints

- Do **not** keep `packages/context7/auth.ts`, `packages/context7/auth.test.ts`,
  `packages/_template/auth.ts`, or any `ModelRuntime`/`>=0.80.8` peer-pin edits.
- Keep the root `package.json` pi dependency alignment — correct hygiene.

### Actionable TODOs

- [x] Discard `ModelRuntime` WIP: `git checkout -- packages/context7/index.ts packages/context7/package.json packages/context7/README.md packages/_template/package.json packages/_template/README.md TEMPLATE.md` and delete untracked `packages/context7/auth.ts`, `packages/context7/auth.test.ts`, `packages/_template/auth.ts` if present.
- [x] Confirm `packages/prompt-enhancer/index.ts` imports `complete` (and `Api`/`Message`/`Model`) from **`@earendil-works/pi-ai/compat`** (not the bare `@earendil-works/pi-ai`); pi's loader aliases the bare specifier to `compat`, so `/compat` is the same module at runtime and the only one that typechecks.
- [x] Keep root `package.json` + `package-lock.json` pi-version alignment; `npm install` to reconcile.

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| prompt-enhancer typechecks | `npx tsc -p packages/prompt-enhancer/tsconfig.json --noEmit` | exit 0 |
| prompt-enhancer + relay tests | `npx vitest run packages/prompt-enhancer packages/relay` | all pass |
| No `ModelRuntime`/`auth.ts` residue | `grep -rn "ModelRuntime\|context7/auth" packages/context7 packages/_template` | no matches |
| Consumers still on old API (baseline red expected) | `npx tsc -p packages/context7/tsconfig.json --noEmit` | fails with `AuthStorage` error (documents the P3 baseline) |

### Definition of Done — see Appendix C.

---

## Phase 2 — 1Password credential API + warm-on-load + API reference

**Entry:** P1. **Shippable as:** `@jmcombs/pi-1password` (minor bump, 1.0.2 → 1.1.0)
exposing a stateless, importable, **documented** credential API and a conditional
warm-on-load, existing 1p behavior unchanged.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

- **In:** `packages/1password/credential-api.ts` exporting the stateless API
  (incl. `is1PasswordAvailable`); re-export from `index.ts`; a **file-locked**
  provider-shaped writer; conditional warm-on-load; **JSDoc on every export** and a
  reference doc `docs/1p-credential-api/API.md`.
- **Out:** any consumer changes (P3+). Do not remove or alter the existing `1p_run`
  / `1password_setup` / diagnose tools or the spawn-hook env injection.
  **Carve-out (ADR 0003):** `1p_run`'s availability gating is corrected in this
  phase to stop hard-blocking on `op whoami`/`signedIn` (a false-negative under the
  desktop-app biometric integration) — it now gates on `configured` and attempts
  the run, same root-cause fix as `is1PasswordAvailable`. Onboarding/diagnose and
  the spawn-hook are otherwise unchanged (diagnose may still show `signedIn` as info).

### Architectural Constraints

- **D3 stateless / D5 read:** functions read `auth.json` / run `op` fresh;
  `resolveSecret` handles both a provider-shaped object (`.key`) and a bare string.
- **D4 shape:** writer produces `{[name]:{type:"api_key",key:"!op read '<ref>'"}}` (vault) or `{[name]:{type:"api_key",key:"<literal>"}}` (manual).
- **D6 onboarding:** `onboardSecret` branches on `is1PasswordAvailable()`
  (`getOpStatus` → available && configured, per ADR 0003): vault picker / manual
  `op://` when available; manual key entry + install-nudge when not.
- **Concurrency:** the provider-shaped writer serializes with a file lock
  (`proper-lockfile` declared in the 1p package `dependencies` if not resolvable,
  **or** an atomic temp-write+rename with an O_EXCL guard) — the existing
  `addAuthEntry` is unlocked; the new writer must not be.
- **D7:** the warm scan inspects nested `.key` values (`loadShellEnvMap` does not).

### Actionable TODOs

- [x] Create `packages/1password/credential-api.ts` exporting, each with JSDoc:
  - `is1PasswordAvailable(): Promise<boolean>` — `getOpStatus()` → `available && configured` (per ADR 0003).
  - `resolveSecret(name): Promise<string | undefined>` — `readFile(auth.json)`; `const e = parsed[name]; return resolveShellValue(typeof e === "string" ? e : e?.key)`.
  - `onboardSecret(ctx, opts: { name; label }): Promise<{ ok; message }>` — branch per D6; write via the locked provider-shaped writer.
  - `changeSecret(ctx, opts)` — as onboard with overwrite=true.
  - `verifySecret(name): Promise<{ ok; resolved; error? }>` — resolves and reports whether `op read` yields a value (never returns the value).
  - `deleteSecret(name): Promise<{ ok }>` — removes `parsed[name]` under the lock.
- [x] In `packages/1password/index.ts`, refactor `resolveShellValue` (L194), the writer (`addAuthEntry`, L294), `getOpStatus` (L75), and `pickOpReferenceSimple` (L541) so `credential-api.ts` reuses them; add the **locked** provider-shaped writer.
- [x] Add `warmOpSessionIfNeeded()` to `index.ts` and wire into `session_start` (L374) + initial load (L354): scan all values (top-level string OR nested `.key`) for `/^!op read /`; if any, one best-effort `op read '<firstRef>'` (try/catch, value discarded).
- [x] Re-export from `index.ts`: `export { resolveSecret, onboardSecret, changeSecret, verifySecret, deleteSecret, is1PasswordAvailable } from "./credential-api.js";`
- [x] Add `credential-api.ts` to `packages/1password/package.json` `files`.
- [x] Create `packages/1password/credential-api.test.ts`: non-mocking round-trip vs a **temp** `auth.json` — provider-shaped `!echo resolved-secret` → `resolveSecret` returns `resolved-secret`; `!exit 1` → `undefined`, never the raw string; `deleteSecret` removes; `warmOpSessionIfNeeded` selects a nested `.key`.
- [x] Create `docs/1p-credential-api/API.md`: reference for all six exports — signature, behavior, return shape, error/fail-closed semantics, and the D4 storage shape.

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| Typecheck 1p package | `npx tsc -p packages/1password/tsconfig.json --noEmit` | exit 0 |
| Lint 1p package | `npx biome check packages/1password` | no errors |
| API round-trip (needs: op-sentinel) | `npx vitest run packages/1password` | all pass, incl. `!echo`/`!exit 1`/delete/warm-scan |
| Secretlint clean | `npx secretlint "packages/1password/**"` | no findings |
| Cross-package import resolves | `npx tsx -e "import('@jmcombs/pi-1password').then(m=>console.log(typeof m.resolveSecret, typeof m.is1PasswordAvailable))"` (repo root) | prints `function function` |
| API.md documents all six exports | `for f in resolveSecret onboardSecret changeSecret verifySecret deleteSecret is1PasswordAvailable; do grep -q "$f" docs/1p-credential-api/API.md || echo MISSING $f; done` | no `MISSING` output |
| Live resolve of a real ref (needs: op-live) | maintainer runs `resolveSecret("context7")` in a pi session | returns the real key |

### Definition of Done — see Appendix C.

---

## Phase 3 — context7 → 1Password API (reference impl + live review)

**Entry:** P2. **Shippable as:** `context7` resolving and onboarding entirely
through the imported API, no `AuthStorage`/`ModelRuntime`, typecheck green, and the
onboarding flow **reviewed live and approved by the maintainer**.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

- **In:** add the dependency; import the API; rewrite `context7`'s onboarding
  command and both tools' auth paths; delete any local auth helper; **pause for a
  live maintainer walkthrough of onboarding** before closing the phase.
- **Out:** other consumers; tool behavior beyond the auth path.

### Architectural Constraints

- **D2:** `@jmcombs/pi-1password` in `dependencies`; peer `@earendil-works/*` stay `"*"` (D9).
- Onboarding is delegated to `onboardSecret` (which owns the D6 availability
  branch); the tool auto-invokes it when `resolveSecret` returns undefined,
  preserving today's "prompt on first use" UX.
- No user-entered value or resolved secret ever appears in LLM-visible text.
- **D13:** normal `refactor(context7):` commit (no `!`); README documents the change.
- **Live review (hard gate):** the phase is **not done** until the maintainer runs
  `/context7_setup` in a live pi session with the agent and approves the flow;
  apply any requested adjustments before merge.

### Actionable TODOs

- [x] `packages/context7/package.json`: add `"@jmcombs/pi-1password"` to `dependencies`; no `auth.ts` in `files`; peer `@earendil-works/pi-coding-agent` stays `"*"`.
- [x] `packages/context7/index.ts`: remove `AuthStorage`/`ModelRuntime`; `import { resolveSecret, onboardSecret } from "@jmcombs/pi-1password";`
  - `/context7_setup` → `await onboardSecret(ctx, { name: "context7", label: "Context7" })`; surface `{ ok, message }`.
  - both tools' `execute()` → `let apiKey = await resolveSecret("context7"); if (!apiKey) { const r = await onboardSecret(ctx, { name: "context7", label: "Context7" }); if (r.ok) apiKey = await resolveSecret("context7"); } if (!apiKey) return <isError missing_api_key>;`
- [x] Delete `packages/context7/auth.ts` / `auth.test.ts` if any remain.
- [x] `packages/context7/README.md`: **Requirements/What's new** — 1Password integration via `@jmcombs/pi-1password`; onboarding branches on `op` availability; existing keys still resolve. Embed the onboarding-flow mermaid (D15).

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| Typecheck context7 | `npx tsc -p packages/context7/tsconfig.json --noEmit` | exit 0 |
| Lint context7 | `npx biome check packages/context7` | no errors |
| Smoke test (needs: pi-ext-load) | `npx vitest run packages/context7` | passes; registers `context7_search`, `context7_get_docs`, `context7_setup` |
| No old-API residue | `grep -rn "AuthStorage\|ModelRuntime" packages/context7` | no matches |
| **Live onboarding review + approval (needs: pi-onboard-tui)** | maintainer runs `/context7_setup` live with the agent (both `op`-available and, if feasible, `op`-absent branches) | maintainer explicitly approves the flow; adjustments applied |
| Live search end-to-end (needs: op-live) | maintainer: `pi -ne -e packages/context7/index.ts --model <cloud> -p "context7_search for react; reply the first library id"` | returns a real library id |

### Definition of Done — see Appendix C.

---

## Phase 4 — tavily-search → 1Password API

**Entry:** P2, P3. **Shippable as:** `tavily-search` on the API, typecheck green.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

- **In:** apply the P3 pattern to `tavily-search` (key `tavily`; retains the
  `process.env.TAVILY_API_KEY` fallback).
- **Out:** other consumers.

### Architectural Constraints

- Preserve the env fallback: `const apiKey = (await resolveSecret("tavily")) ?? process.env.TAVILY_API_KEY;`
- Same dependency/import rules as P3 (D2, D9, D13).

### Actionable TODOs

- [x] `packages/tavily-search/package.json`: add `@jmcombs/pi-1password` to `dependencies`.
- [x] `packages/tavily-search/index.ts`: remove `AuthStorage`; import the API; onboarding → `onboardSecret(ctx, { name: "tavily", label: "Tavily" })`; tool auth → `resolveSecret("tavily")` with the env fallback.
- [x] `packages/tavily-search/README.md`: 1Password integration + retained env fallback; embed the onboarding mermaid (D15).

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| Typecheck tavily | `npx tsc -p packages/tavily-search/tsconfig.json --noEmit` | exit 0 |
| Lint tavily | `npx biome check packages/tavily-search` | no errors |
| Smoke test (needs: pi-ext-load) | `npx vitest run packages/tavily-search` | passes |
| No old-API residue | `grep -rn "AuthStorage" packages/tavily-search` | no matches |
| Live search (needs: op-live) | maintainer drives a tavily search in a pi session | returns results using the resolved key |

### Definition of Done — see Appendix C.

---

## Phase 5 — grok-search → 1Password API

**Entry:** P2, P3. **Shippable as:** `grok-search` on the API, typecheck green.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

- **In:** migrate `grok-search`, which reads three ids in precedence:
  `xai_search` → `xai` (real xAI provider key) → `grok` (D12).
- **Out:** other consumers.

### Architectural Constraints

- All three ids resolve through `resolveSecret` (D12); `xai` being a real provider
  id needs no special handling. Preserve precedence:
  `const apiKey = (await resolveSecret("xai_search")) ?? (await resolveSecret("xai")) ?? (await resolveSecret("grok"));`
- Onboarding writes the `grok` id — never overwrite the shared real `xai` key.

### Actionable TODOs

- [ ] `packages/grok-search/package.json`: add `@jmcombs/pi-1password` to `dependencies`.
- [ ] `packages/grok-search/index.ts`: remove `AuthStorage`; import the API; implement the three-id precedence; onboarding → `onboardSecret(ctx, { name: "grok", label: "Grok / xAI" })`.
- [ ] If the edited path touches the latent returned-`isError` no-op (relay D9 / `memory/pi-0808-auth-migration`), fix it; otherwise leave for its own issue.
- [ ] `packages/grok-search/README.md`: 1Password integration + xai/xai_search/grok precedence; embed the onboarding mermaid (D15).

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| Typecheck grok-search | `npx tsc -p packages/grok-search/tsconfig.json --noEmit` | exit 0 |
| Lint grok-search | `npx biome check packages/grok-search` | no errors |
| Smoke test (needs: pi-ext-load) | `npx vitest run packages/grok-search` | passes |
| No old-API residue | `grep -rn "AuthStorage" packages/grok-search` | no matches |
| Precedence resolves (needs: op-live) | maintainer: set only `xai`, confirm search works; then `xai_search`, confirm it wins | search succeeds with the expected key |

### Definition of Done — see Appendix C.

---

## Phase 6 — headroom → 1Password API (+ full-repo green)

**Entry:** P2, P3. **Shippable as:** `headroom` on the API and the **full repo
typecheck/test green** — the terminal consumer.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

- **In:** migrate `packages/headroom/index.ts` and `packages/headroom/client.ts`;
  rework the test seam that injects an `authStorage`.
- **Out:** headroom behavior beyond credential access.

### Architectural Constraints

- Replace the injected `AuthStorage` seam in `client.ts` with an injectable
  resolver (`resolveKey?: (name: string) => Promise<string | undefined>`, default
  `resolveSecret`) so tests pass a stub without `AuthStorage`. Preserve the
  documented precedence (arg → stored → env).
- Same dependency/import rules (D2, D9, D13).

### Actionable TODOs

- [ ] `packages/headroom/package.json`: add `@jmcombs/pi-1password` to `dependencies`.
- [ ] `packages/headroom/client.ts`: remove `AuthStorage`; replace the `authStorage` param with `resolveKey?` defaulting to `resolveSecret`; resolve `headroom` through it.
- [ ] `packages/headroom/index.ts`: remove `AuthStorage` usages (~L47, 520, 636, and `resolveConfig`/`isHealthy`/tool wiring); thread the resolver seam; onboarding → `onboardSecret(ctx, { name: "headroom", label: "Headroom" })`.
- [ ] Update `packages/headroom/*.test.ts` to inject a stub `resolveKey` (the 9 failing tests).
- [ ] `packages/headroom/README.md` / `docs/headroom/PLAN.md`: update the auth-source description; embed the onboarding mermaid (D15).

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| Typecheck headroom | `npx tsc -p packages/headroom/tsconfig.json --noEmit` | exit 0 |
| Lint headroom | `npx biome check packages/headroom` | no errors |
| headroom tests (needs: pi-ext-load) | `npx vitest run packages/headroom` | all pass (incl. the previously-failing 9) |
| **Full-repo typecheck** | `npm run typecheck` | exit 0 |
| **Full-repo tests** | `npm run test` | all pass |
| **Full quality gate** | `npm run check` | exit 0 |
| No `AuthStorage` anywhere | `grep -rln "AuthStorage" packages --include=*.ts` | no matches |
| Live retrieve (needs: op-live) | maintainer drives a headroom retrieve in a pi session | resolves `headroom` and succeeds |

### Definition of Done — see Appendix C.

---

## Phase 7 — Template teaches the API pattern

**Entry:** P3. **Shippable as:** `_template` and `TEMPLATE.md` documenting the
1Password-API pattern; all `ModelRuntime`/`AuthStorage` guidance removed.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

- **In:** update `packages/_template` and `TEMPLATE.md` to the imported-API pattern.
- **Out:** functional code in shipping packages; the full developer guide (that is P9).

### Architectural Constraints

- Template shows `dependencies: { "@jmcombs/pi-1password": … }` + `import { resolveSecret, onboardSecret } from "@jmcombs/pi-1password"`; no copy-and-own `auth.ts`; no peer-dep floors (D9).

### Actionable TODOs

- [ ] `packages/_template/README.md`: replace the `AuthStorage`/`ModelRuntime` secret-handling section with the imported-API example; link `docs/1p-credential-api/INTEGRATION.md` (created in P9).
- [ ] `TEMPLATE.md`: replace "read secrets through the `auth.ts` helper" with "depend on `@jmcombs/pi-1password` and import `resolveSecret`/`onboardSecret`"; keep the `"*"` peer rule (D9); remove `assertSupportedPi`/`auth.ts` copy instructions.
- [ ] Remove `packages/_template/auth.ts` and its `files` entry if present.
- [ ] `docs/prompts/build-phase.md`: update the `AuthStorage` example reference.

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| No old-API refs in template/docs | `grep -rn "AuthStorage\|ModelRuntime\|_template/auth" packages/_template TEMPLATE.md docs/prompts` | no matches |
| Repo green | `npm run typecheck` | exit 0 |
| Format check | `npm run format:check` | exit 0 |

### Definition of Done — see Appendix C.

---

## Phase 8 — relay ↔ oh-my-pi compatibility (isolated)

**Entry:** P1. **Shippable as:** a repeatable, **isolated** test proving `relay`
loads and registers under **oh-my-pi** without breaking, plus a documented result;
a relay fix **only if** a real break is found. Independent of the credential work.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

- **In:** stand up oh-my-pi in isolation (Docker container preferred; brew + a
  throwaway `HOME` acceptable), load `packages/relay/index.ts`, and assert relay
  registers its tools and its `@earendil-works/pi-ai` imports resolve under
  oh-my-pi's loader.
- **Out:** any change to the user's `~/.pi`; any relay redesign. Modify relay only
  if oh-my-pi surfaces a genuine break (minimal fix, within `memory/use-pi-public-apis`).

### Architectural Constraints

- **D14 isolation:** the harness MUST run in a container or a throwaway HOME. It
  MUST NOT bind-mount, read, or write `~/.pi`. No maintainer credentials in the
  automated path.
- **Known risk to probe:** oh-my-pi (`can1357/oh-my-pi`) is a pi fork; relay imports
  `createAssistantMessageEventStream` and types from `@earendil-works/pi-ai` and
  uses `registerProvider` + the `AgentDriver` seam. The test verifies those resolve
  and register under oh-my-pi's aliases (it may use a different package scope).

### Actionable TODOs

- [ ] **Research first:** pin oh-my-pi's install method (brew formula/tap or npm) and its extension-load invocation (the oh-my-pi equivalent of `pi -ne -e <path>`), from oh-my-pi's README/CHANGELOG (`github.com/can1357/oh-my-pi`). Record the pinned commands in the harness; do not guess them into a gate.
- [ ] Create `docker/ohmypi-relay.Dockerfile`: a clean image that installs oh-my-pi (pinned method), copies `packages/relay`, and sets an **ephemeral** `HOME`.
- [ ] Create `scripts/test-relay-ohmypi.sh`: build/run the container, load relay via oh-my-pi's extension-load flag with the isolated HOME, print a single machine-checkable line — e.g. `RELAY-OHMYPI: tools=<n> imports=ok` — exiting non-zero on any load/registration/import error. Include a brew-fallback branch guarded to a throwaway `HOME` (never `~/.pi`, D14).
- [ ] Create `docs/1p-credential-api/relay-ohmypi-results.md`: run output, oh-my-pi version, any gap found (+ follow-up issue if a break is real).

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| relay loads under oh-my-pi (needs: ohmypi-env) | `bash scripts/test-relay-ohmypi.sh` | prints `RELAY-OHMYPI: tools=<n> imports=ok`; exit 0 |
| No `~/.pi` access by the harness (needs: ohmypi-env) | `grep -n "\.pi" docker/ohmypi-relay.Dockerfile scripts/test-relay-ohmypi.sh` | only ephemeral/throwaway paths; no bind of the real `~/.pi` |
| Result documented | `test -s docs/1p-credential-api/relay-ohmypi-results.md` | non-empty with version + outcome |
| relay unit tests still green | `npx vitest run packages/relay` | all pass |
| Live dispatch under oh-my-pi (needs: claude-sub) | maintainer runs a relay dispatch inside the isolated env | returns a verdict/result |

### Definition of Done — see Appendix C.

---

## Phase 9 — Developer API documentation & integration guide (mermaid)

**Entry:** P6 (all consumers migrated, available as worked examples).
**Shippable as:** an extensive, developer-facing guide showing how to adopt the
1Password plugin in any extension, with mermaid diagrams (D15).

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout

### Objectives & Scope

- **In:** `docs/1p-credential-api/INTEGRATION.md` — a step-by-step "add 1Password to
  your extension" guide with mermaid diagrams and a worked context7 example; polish
  `docs/1p-credential-api/API.md` (from P2) into the linked reference.
- **Out:** code changes to shipping packages.

### Architectural Constraints

- Documentation uses **```mermaid fenced blocks** so it renders on GitHub and in
  pi.dev. At minimum the four diagrams in the TODO below.
- The guide must be **copy-pasteable**: real import lines, real `package.json`
  `dependencies` snippet, real onboarding + tool wiring, matching the shipped
  consumers.

### Actionable TODOs

- [ ] Create `docs/1p-credential-api/INTEGRATION.md` with:
  - Overview + when to use it.
  - **Mermaid 1 — Architecture:** consumer extension → imports API → `@jmcombs/pi-1password` → (`op` CLI, `auth.json`).
  - **Mermaid 2 — Onboarding availability branch** (the `is1PasswordAvailable` flow: vault picker vs manual entry + install nudge).
  - **Mermaid 3 — Resolve sequence:** `resolveSecret` → `readFile(auth.json)` → `resolveShellValue` → `op read` → secret → tool.
  - **Mermaid 4 — Before/After:** removed `AuthStorage` path vs the 1p API path.
  - Step-by-step: add the `dependencies` entry; `import { resolveSecret, onboardSecret, is1PasswordAvailable }`; wire the onboarding command; wire tool auth (auto-onboard on miss); test.
  - Worked example: annotated context7 excerpts.
  - Link to `API.md`; troubleshooting (`op` not signed in, key not found, warm-on-load).
- [ ] Ensure `docs/1p-credential-api/API.md` is complete and linked from `INTEGRATION.md` and the root `README.md`.

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| Guide has ≥4 mermaid diagrams | `grep -c '^```mermaid' docs/1p-credential-api/INTEGRATION.md` | ≥ 4 |
| Guide covers the API surface | `for f in resolveSecret onboardSecret is1PasswordAvailable; do grep -q "$f" docs/1p-credential-api/INTEGRATION.md || echo MISSING $f; done` | no `MISSING` |
| Reference linked | `grep -q "API.md" docs/1p-credential-api/INTEGRATION.md` | match |
| Diagrams render + guide reads correctly (needs: doc-render) | maintainer previews `INTEGRATION.md` (GitHub / mermaid preview) | all four diagrams render; walkthrough is followable |
| Format check | `npm run format:check` | exit 0 |

### Definition of Done — see Appendix C.

---

## Phase 10 — Release notes & migration guide

**Entry:** P6, P9. **Shippable as:** a consolidated migration guide and clear,
accurate release notes across every migrated package before the release PRs go out.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout

### Objectives & Scope

- **In:** author `docs/1p-credential-api/MIGRATION.md`; confirm each migrated
  package's README/CHANGELOG states the D13 a–d points; link everything from the
  root `README.md`.
- **Out:** merging release PRs (maintainer-only) or editing release-please manifests.

### Architectural Constraints

- Release notes are generated by release-please from commit messages (non-breaking,
  D13); this phase ensures the **inputs** are correct (clear conventional commits +
  human-readable notes), not hand-edited generated CHANGELOGs or manifests (`AGENTS.md`).

### Actionable TODOs

- [ ] Create `docs/1p-credential-api/MIGRATION.md`: what changed (AuthStorage removed in pi 0.80.8) and why; per-package: now integrates with `@jmcombs/pi-1password`; existing `auth.json` keys keep working (literals + `!op read`); onboarding branches on `op` availability; enable the 1p extension for vault integration + startup unlock; upgrade steps. Include the before/after mermaid (reuse Mermaid 4).
- [ ] Confirm each migrated README (context7, tavily-search, grok-search, headroom) has the D13 a–d section.
- [ ] Link `MIGRATION.md` and `INTEGRATION.md` from the root `README.md` package table.

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| Migration guide covers all four | `for p in context7 tavily grok headroom; do grep -qi "$p" docs/1p-credential-api/MIGRATION.md || echo MISSING $p; done` | no `MISSING` |
| READMEs describe the integration | `grep -rl "@jmcombs/pi-1password" packages/{context7,tavily-search,grok-search,headroom}/README.md` | all four |
| Root README links the guides | `grep -E "MIGRATION.md|INTEGRATION.md" README.md` | both matched |
| Repo green | `npm run check` | exit 0 |

### Definition of Done — see Appendix C.

---

## Appendix A — Decision Log (ADR index)

Any deviation from a Locked Decision requires an ADR in `docs/decisions/NNNN-*.md`
and a row here before implementation.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](../decisions/0001-integration-branch-for-baseline-red-migration.md) | Integration branch for the baseline-red AuthStorage migration | Accepted |
| [0002](../decisions/0002-ts-aware-gate5-cross-package-import.md) | TS-aware loader for Phase 2 Gate 5 (cross-package import) | Accepted |
| [0003](../decisions/0003-op-availability-detects-configuration-not-session.md) | `op` availability detects configuration, not live session (fixes `is1PasswordAvailable` + `1p_run`) | Accepted |
| [0004](../decisions/0004-onboardsecret-accepts-extension-context.md) | Onboarding surface (`onboardSecret`/`changeSecret`/`pickOpReferenceSimple` + bordered-popup helpers) takes the minimal `UiContext = Pick<ExtensionContext, "ui">` capability, so it is callable from tool `execute()`, command/event handlers, and a `{ ui }` test double | Accepted |
| [0005](../decisions/0005-onboarding-ux-redesign.md) | Onboarding UX redesign: upfront overwrite gate, three description-backed sources (browse / paste / op:// reference) with masked literal entry + field-step auto-skip + `op://` validation, and post-save verify; adds a masked-input primitive and fixes the `confirm` message / multi-line prompt bugs | Accepted |
| [0006](../decisions/0006-credential-setup-command-naming.md) | Credential-setup command naming: the setup command is `{brand-slug}_setup` across all extensions (incl. 1Password); consumer setup-command descriptions unified to `Set up or update your {label} API key (never shown to the agent).`; `setup` chosen over `onboard`/`authenticate` (sets or updates); diagnose/run commands out of scope | Accepted |
| [0007](../decisions/0007-tool-error-results-no-returned-iserror.md) | Consumer tool error results report via `content` + `details`, never a returned `isError` (pi ignores it — only a thrown `execute()` flags an error); no `throw` for user-facing recoverable errors (missing key / 401 / 429 / network). Removed the no-op `isError` from grok-search, context7, tavily-search; headroom born correct at P6 | Accepted |

## Appendix B — Master TODO index (verifier-ticked)

- [x] **P1** Baseline reset; prompt-enhancer `/compat`; dep alignment.
- [x] **P2** 1Password credential API exported (incl. `is1PasswordAvailable`); warm-on-load; locked writer; JSDoc + `API.md`.
- [x] **P3** context7 migrated (reference); availability-branched onboarding; **live maintainer review passed**.
- [x] **P4** tavily-search migrated (env fallback kept).
- [ ] **P5** grok-search migrated (xai/xai_search/grok precedence).
- [ ] **P6** headroom migrated (both files + test seam); **full repo green**.
- [ ] **P7** `_template` + `TEMPLATE.md` teach the API pattern.
- [ ] **P8** relay proven under oh-my-pi in isolation; result documented.
- [ ] **P9** Developer `INTEGRATION.md` + `API.md` with ≥4 mermaid diagrams; diagrams reviewed.
- [ ] **P10** Migration guide authored; release notes verified across all four.

## Appendix C — Definition of Done (every phase)

1. Work done on the phase's feature branch; Conventional Commits scoped to the
   package (non-breaking per D13); branch↔commit-type symmetry; never the default branch.
2. For every **touched** workspace: `tsc -p <pkg>/tsconfig.json --noEmit`,
   `biome check <pkg>`, `vitest run <pkg>` exit 0 / pass.
3. Full-repo regression: `npm run check` green **where the plan says it must be** —
   fully green from P6 onward; in P1–P5 the not-yet-migrated `AuthStorage` packages
   are the tracked baseline and each phase introduces **no new** errors elsewhere.
4. Every Testing Gate re-run by the verifier with **real** output. `needs: op-live`,
   `needs: pi-onboard-tui`, `needs: doc-render`, `needs: claude-sub` gates are
   **human-verify** (CONDITIONAL PASS + an Appendix D row); `needs: ohmypi-env` is
   provisionable and must be stood up and run; all other gates are must-pass.
   **Phase 3's live onboarding-review gate is a hard prerequisite to merge.**
5. Every literal TODO path exists as specified.
6. No `AuthStorage` or `ModelRuntime` reference remains in a completed package.
7. PR opened against `feat/1password-credential-api` (ADR 0001). The
   `Commit Messages` check is green on every phase PR; the two `Quality Gate`
   checks are required-green on the **final `feat/1password-credential-api` →
   `main` PR** (where P6 has made the repo fully green) and may carry the tracked
   baseline-red on intermediate phase PRs (P1–P5). `main` stays green throughout.
   After explicit human approval, the merger merges and ticks the Appendix B box.
   No self-merge.
8. Every deviation has an ADR (`docs/decisions/`) and an Appendix A row.

## Appendix D — Deferred / human-verify gate ledger

Authored empty. The merger adds one `OPEN` row per human-verify gate (op-live /
pi-onboard-tui / doc-render / claude-sub) when a phase merges on a CONDITIONAL PASS;
a human closes it out-of-band.

| Gate | Deferred at | Needs | Discharge by | Status |
| --- | --- | --- | --- | --- |
| Live availability + resolve (is1PasswordAvailable / resolveSecret) | Phase 2 | op-live | human (maintainer live check) | DISCHARGED |
| Live onboarding review (/context7_setup) | Phase 3 | pi-onboard-tui | human (maintainer live review) | DISCHARGED |
| Live search end-to-end (context7_search) | Phase 3 | op-live | human (maintainer live check) | DISCHARGED |
| Live tavily search (resolveSecret / tavily_search) | Phase 4 | op-live | human (maintainer live check) | DISCHARGED |
