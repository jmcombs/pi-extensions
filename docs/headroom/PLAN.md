# PLAN.md — `@jmcombs/pi-headroom`

Build spec for the Headroom context-compression Pi extension. This is the **single source of
truth** for the build/verify loop (`docs/prompts/build-phase.md`, `docs/prompts/verify-phase.md`).
TODO file paths and names are **literal specs**. Testing Gates are **literal commands** with
literal expected output.

> Feasibility (Phase 0) is **complete** — see the "Phase 0 findings" section. Verdict: GO.

---

## What we are building (one paragraph)

A Pi extension (`packages/headroom/`) that compresses the **whole conversation** before each LLM
call by piping `messages` through Headroom's `compress()` (npm `headroom-ai`, a thin HTTP client to
a local Python proxy). It registers a `headroom_retrieve` tool so the model can recover any detail
that lossy compression elided, and it **degrades to pure passthrough** whenever the proxy is
unreachable. The Python proxy is a documented, user-managed prerequisite — the extension never
manages its lifecycle.

## Phase 0 findings (authoritative, already validated on this machine)

- npm `headroom-ai` is a **pure HTTP client**; the engine is the Python proxy
  (`headroom proxy --port 8787`, default `http://127.0.0.1:8787`). Install via venv:
  `python3 -m venv ~/.headroom-venv && ~/.headroom-venv/bin/pip install "headroom-ai[proxy]"`
  (`[proxy]` = onnxruntime + magika, **no PyTorch**). No license wall.
- **Recency protection (decisive):** Headroom protects recent turns and compresses stale ones.
  The same file read scored **0% as the newest tool result** but **71% three turns later**. ⇒ the
  correct hook is **`context`** (whole conversation), **not** `tool_result`.
- **CCR is reversible:** the retrieve hash is embedded **inline** in compressed text
  (`[… Retrieve more: hash=<hash>]`); `client.retrieve(hash)` returns the full original.
- **Compression is lossy on the surface** (error lines can vanish from the visible text) →
  `headroom_retrieve` is **required for safety**, not optional.
- **Graceful fallback works:** proxy down + `fallback:true` → input returned unchanged in ~24ms.

---

## Locked Decisions (non-negotiable; a deviation requires the escalation path in Appendix B)

- **LD1 — Hook:** Integration is via Pi's **`context`** event (compress the whole `messages` array
  before each LLM call) and returns `{ messages }`. Do **not** use `tool_result` for compression.
- **LD2 — Conservative posture:** Compression is **on by default**, but CCR + the
  `headroom_retrieve` tool are **always enabled** so any elided detail is recoverable. A
  flag/setting may disable compression per session; it may **not** disable retrieve.
- **LD3 — Graceful degradation:** The extension must **never throw into the agent loop**. Every
  `compress()` call uses `fallback: true` **and** is wrapped in defensive `try/catch` that returns
  the original input unchanged. When the cached health probe says the proxy is down, the `context`
  handler is a pure passthrough (no network call).
- **LD4 — No proxy lifecycle management:** The extension never spawns, stops, or installs the proxy.
  It only health-checks and documents the venv prerequisite.
- **LD5 — Dependencies:** `headroom-ai` is a real `dependencies` entry. Pi runtime packages
  (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) and `typebox` stay in
  `peerDependencies: "*"`. Do not bundle peers.
- **LD6 — Repo conventions:** Node `>=22`; Conventional Commits scoped `…(headroom)…`; package
  version stays `0.0.0` until Release Please; `keywords` include `pi-package`; `license: MIT`;
  `author: "Jeremy Combs"`; smoke tests only (**no network mocks** in the committed suite).
- **LD7 — Layout:** npm name `@jmcombs/pi-headroom`, directory `packages/headroom/`. Asset lives at
  the **repo root** under `assets/headroom/`, never inside the package.

---

## Git & PR conventions (every phase)

- **Branch first**, before editing: `git switch -c <type>/headroom-phase-[N]-<slug>` where `<type>`
  is the phase's branch type from the summary table. **Never commit to `main`.**
- **Symmetry:** branch prefix = commit type (`feat/` branch → `feat(headroom): …` commits).
- Atomic Conventional Commits scoped to `headroom`. Use `chore(headroom):` for changes that should
  not appear in the package CHANGELOG.
- **One real PR per phase.** Push the branch, open the PR, ensure all three required checks are
  green: **`Quality Gate (Node 22)`**, **`Quality Gate (Node 24)`**, **`Commit Messages`**.
- The builder **does not merge** and **does not tick checkboxes**. The verifier does not merge
  either (Code Owner = `@jmcombs`); on PASS it green-lights and the **orchestrator asks the user for
  merge approval**. Merge happens only after explicit user approval.
- Never disable, weaken, or add bypass actors to the branch ruleset. Never edit `.github/CODEOWNERS`,
  `ci.yml` job names, or the Release Please config except as a phase TODO explicitly requires.
- Each phase's **Entry** phases must be **merged to `main`** before that phase's branch is cut.

---

## Phase summary

| Phase | Branch type | Title | Entry (must be merged) |
| ----- | ----------- | ----- | ---------------------- |
| 1 | `feat` | Scaffold + proxy client + status commands | — |
| 2 | `feat` | Whole-conversation compression via `context` | 1 |
| 3 | `feat` | `headroom_retrieve` tool (reversibility) | 2 |
| 4 | `feat` | Config surface: mode + tuning | 3 |
| 5 | `feat` | UX, metrics, docs, asset | 4 |
| 6 | `chore` | Release wiring | 5 |

### Testing-Gate methods

Each gate row has a **Method**:

- **AUTO** — verifier runs the exact committed command; real output must match Expected.
- **HEADLESS** — verifier runs an ad-hoc Node script (not committed) against the **running proxy**,
  importing the extension's exported functions; real output must match Expected.
- **HEADLESS-RPC** — verifier drives the extension through Pi's RPC mode and asserts on real events,
  using the committed driver `docs/headroom/rpc-verify.mjs`. It spawns `pi --mode rpc --no-session
  --offline -e <ext>` and optionally sends `{type:"prompt",message:"/cmd"}`; extension commands
  execute immediately with **no LLM call / no API key**, and `ctx.ui.notify(...)` surfaces as
  `extension_ui_request` / `method:"notify"` events on stdout. This covers status/notice/command/
  retrieve behavior once thought to need an interactive TUI. Filter notifies for messages starting
  with `Headroom` (other installed extensions also emit `session_start` notices).
- **MANUAL** — reserved for genuinely *visual* TUI output RPC cannot assert (e.g. `renderCall`/
  `renderResult` glyph layout). Builder captures a screenshot/transcript; if absent the verifier
  marks it **UNVERIFIED** and, per the roadblock rule, **pauses and asks the user** — never passes on
  assertion alone. Prefer HEADLESS-RPC wherever behavior (not pixels) is what the gate asserts.

**Proxy precondition** for HEADLESS/HEADLESS-RPC/MANUAL gates: `~/.headroom-venv/bin/headroom proxy
--port 8787` running, `GET http://127.0.0.1:8787/health` returns `"status":"healthy"`.

---

## Phase 1 — Scaffold + proxy client + status commands

**Objectives:** Stand up the package from the template, wire a thin typed client around `headroom-ai`
with config resolution + a memoized health probe, and add status/auth commands. **No compression in
this phase.**

**Architectural Constraints:** LD3 (health probe is cached, short-TTL, never throws), LD4, LD5, LD6,
LD7. The `session_start` notice must be non-fatal and fire at most once per session.

**Actionable TODOs (literal paths):**
1. `packages/headroom/` created by copying `packages/_template/`; every `EXTENSION_NAME` placeholder
   and `TODO:` resolved.
2. `packages/headroom/package.json`: name `@jmcombs/pi-headroom`; `dependencies` includes
   `"headroom-ai"`; `peerDependencies` keep `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
   `typebox` at `"*"`; `keywords` include `pi-package`; `version` `0.0.0`; `private` removed only in
   Phase 6 (stays for Phase 1).
3. `packages/headroom/client.ts`: exports `resolveConfig()` (arg → `AuthStorage("headroom")` →
   `HEADROOM_BASE_URL`/`HEADROOM_API_KEY` → default `http://127.0.0.1:8787`), a memoized
   `getClient()` returning a `HeadroomClient`, and `isHealthy(): Promise<boolean>` (short-TTL cached
   `health()` probe that resolves `false` on any error, never throws).
4. `packages/headroom/index.ts`: default factory registers commands `headroom-status` and
   `headroom-authenticate`, plus a `session_start` handler emitting the one-time proxy-down notice.
5. `packages/headroom/index.test.ts`: smoke test asserts the factory registers `headroom-status`,
   `headroom-authenticate`, and a `session_start` event (registration surface only, no network).

**Testing Gates:**

| # | Method | Command | Expected |
| - | ------ | ------- | -------- |
| 1.1 | AUTO | `npm run check` | exit 0; lint, typecheck, vitest, version check, secretlint, audit all pass |
| 1.2 | AUTO | `npm run test -- packages/headroom` | smoke test passes; asserts `headroom-status`, `headroom-authenticate`, `session_start` registered |
| 1.3 | HEADLESS | Node: import `isHealthy` from `client.ts` with proxy **up** | resolves `true` |
| 1.4 | HEADLESS | Node: import `isHealthy` from `client.ts` with proxy **down** | resolves `false` within ~3s, no throw |
| 1.5 | HEADLESS-RPC | `node docs/headroom/rpc-verify.mjs ./packages/headroom "/headroom-status"` (proxy up) | an `info` notify reporting healthy + proxy version |
| 1.6 | HEADLESS-RPC | `node docs/headroom/rpc-verify.mjs ./packages/headroom` (proxy down) | a single `warning` notify at session start; no crash |

---

## Phase 2 — Whole-conversation compression via `context`

**Objectives:** Compress the conversation on each LLM call through the `context` hook; accumulate
session savings.

**Architectural Constraints:** LD1, LD2, LD3. The handler returns `{ messages }` only; on health-gate
false or any error it returns the **original** `event.messages` untouched. Core compression logic is
exported as a testable function so it can be exercised HEADLESS.

**Actionable TODOs:**
1. `packages/headroom/index.ts`: register `pi.on("context", …)` that, when `isHealthy()`, calls the
   exported `compressMessages(messages, opts)` and returns `{ messages }`; otherwise passthrough.
2. `packages/headroom/compress.ts` (new): exports `compressMessages(messages, { model, baseUrl })`
   wrapping `compress({ fallback: true })` in `try/catch`; returns `{ messages, tokensSaved }`,
   returning the original messages + `tokensSaved: 0` on any failure.
3. `packages/headroom/index.ts`: a session savings accumulator updated from each call's `tokensSaved`.
4. A disable mechanism (flag or setting) that turns compression off but **not** retrieve (LD2).
5. `packages/headroom/index.test.ts`: assert the `context` event is registered; unit-test the pure
   savings accumulator with no network.

**Testing Gates:**

| # | Method | Command | Expected |
| - | ------ | ------- | -------- |
| 2.1 | AUTO | `npm run check` | exit 0 |
| 2.2 | AUTO | `npm run test -- packages/headroom` | `context` registered; accumulator unit test passes |
| 2.3 | HEADLESS | Node: `compressMessages(<stale-heavy convo>)` with proxy up | `tokensSaved > 0`; returns valid messages array same length |
| 2.4 | HEADLESS | Node: `compressMessages(<convo>)` with proxy **down** | returns original messages unchanged, `tokensSaved === 0`, no throw |
| 2.5 | HEADLESS-RPC | drive a multi-turn convo via RPC `prompt`s, then `/headroom-status` (or stats command) | session savings notify shows non-zero; no crash. (Full model-coherence over a real session may also be spot-checked MANUAL.) |

---

## Phase 3 — `headroom_retrieve` tool (reversibility)

**Objectives:** Let the model recover originals via the inline CCR hash.

**Architectural Constraints:** LD2 (retrieve always enabled). CCR stays enabled in the compress
config so inline markers (`… Retrieve more: hash=<hash>`) reach the model.

**Actionable TODOs:**
1. `packages/headroom/index.ts`: `registerTool({ name: "headroom_retrieve", … })` with a TypeBox
   schema `{ hash: string, query?: string }`, wired to `getClient().retrieve(hash, { query })`.
2. Returns the original content as `{ content: [{ type: "text", text }], details }`; invalid/missing
   hash returns a clear non-throwing error result.
3. `renderCall`/`renderResult` for the retrieve tool (pattern from `packages/better-toolsy/index.ts`).
4. `packages/headroom/index.test.ts`: assert `headroom_retrieve` is registered.

**Testing Gates:**

| # | Method | Command | Expected |
| - | ------ | ------- | -------- |
| 3.1 | AUTO | `npm run check` | exit 0 |
| 3.2 | AUTO | `npm run test -- packages/headroom` | `headroom_retrieve` registered |
| 3.3 | HEADLESS | Node: compress a verbose log (proxy up), extract inline `hash=…`, call the tool's execute with that hash | returns original text incl. the lines compression elided |
| 3.4 | HEADLESS-RPC | via RPC, invoke the `headroom_retrieve` tool execute with a real inline hash from a lossy compression | original detail (incl. elided lines) returned in the tool result |

---

## Phase 4 — Config surface: mode + tuning

**Objectives:** Expose a small, documented config surface with conservative defaults.

**Architectural Constraints:** Defaults must reproduce Phase 2/3 behavior exactly; LD1–LD3 hold.

**Actionable TODOs:**
1. `packages/headroom/config.ts` (new): typed settings — at minimum `mode: "token" | "cache"`
   (default `"token"`), `enabled` (default `true`), resolved from settings/env with safe defaults.
2. Wire the resolved config into `compressMessages` / client construction.
3. `packages/headroom/index.test.ts`: unit-test default resolution (no network).

**Testing Gates:**

| # | Method | Command | Expected |
| - | ------ | ------- | -------- |
| 4.1 | AUTO | `npm run check` | exit 0 |
| 4.2 | AUTO | `npm run test -- packages/headroom` | default-config unit test passes; defaults = Phase 2 behavior |
| 4.3 | HEADLESS-RPC | drive compression under `token` vs `cache` config via RPC; assert both run and default is unchanged from Phase 2 | both modes succeed; default behavior identical to Phase 2 |

---

## Phase 5 — UX, metrics, docs, asset

**Objectives:** Stats/simulate commands, real README, gallery asset.

**Actionable TODOs:**
1. `packages/headroom/index.ts`: commands `headroom-stats` (`proxyStats()` + session savings) and
   `headroom-simulate` (dry-run `simulate()` on a pasted blob).
2. `packages/headroom/README.md`: leads with the **Python-proxy venv prerequisite**, env vars,
   config, graceful-degradation behavior, savings model; all template boilerplate removed.
3. `assets/headroom/preview.png` exists at the repo root.

**Testing Gates:**

| # | Method | Command | Expected |
| - | ------ | ------- | -------- |
| 5.1 | AUTO | `npm run check` | exit 0 |
| 5.2 | AUTO | `npm run test -- packages/headroom` | `headroom-stats`, `headroom-simulate` registered |
| 5.3 | AUTO | `test -f assets/headroom/preview.png && ! grep -ri "EXTENSION_NAME\|TODO:" packages/headroom/README.md` | asset present; no template residue |
| 5.4 | HEADLESS-RPC | `node docs/headroom/rpc-verify.mjs ./packages/headroom "/headroom-stats"` and `"/headroom-simulate …"` | both emit notifies with correct data |

---

## Phase 6 — Release wiring

**Objectives:** Register the package with Release Please.

**Actionable TODOs:**
1. `release-please-config.json`: add a `packages/headroom` entry (`release-type: node`,
   `component: headroom`, `package-name: @jmcombs/pi-headroom`).
2. `.release-please-manifest.json`: add `"packages/headroom": "0.0.0"`.
3. `packages/headroom/package.json`: remove `"private": true`; keep `version` `0.0.0`.
4. Root `README.md`: add `@jmcombs/pi-headroom` to the package table.

**Testing Gates:**

| # | Method | Command | Expected |
| - | ------ | ------- | -------- |
| 6.1 | AUTO | `npm run check` | exit 0 (incl. `check:versions`) |
| 6.2 | AUTO | `node -e "JSON.parse(require('fs').readFileSync('release-please-config.json'));JSON.parse(require('fs').readFileSync('.release-please-manifest.json'))"` | both parse; `headroom` present in each |
| 6.3 | AUTO | `node -e "const p=require('./packages/headroom/package.json'); if(p.private)process.exit(1); if(p.version!=='0.0.0')process.exit(1)"` | exit 0 |

---

## Appendix A — Reuse map (do not hand-roll what exists)

- `packages/tavily-search/index.ts` — `AuthStorage` + `process.env` fallback; auth command shape.
- `packages/better-toolsy/index.ts` — `registerTool` + `renderCall`/`renderResult` TUI patterns.
- `packages/_template/` — scaffold, `package.json` shape, smoke-test stub (`index.test.ts`).
- `TEMPLATE.md` / `CONTRIBUTING.md` / `AGENTS.md` — process + conventions.

## Appendix B — ADR / deviation policy (STRICT)

There is **no standing ADR mechanism for this build.** Deviations are **not** pre-authorized.

If a TODO or Locked Decision cannot be implemented as written, the builder must:
1. **Exhaust all reasonable paths** to satisfy it as specified (different API, different ordering,
   reading the SDK/Pi types, etc.) and document what was tried.
2. If still blocked, **stop and escalate to the user** with evidence — do **not** invent an ADR,
   relocate files, rename, or "work around" and proceed.

The verifier **fails** any phase that contains a deviation, relocation, rename, or ad-hoc ADR that
was not explicitly approved by the user. A phase PASSes only when it matches this spec **exactly**.

| ADR | Status | Approved by | Notes |
| --- | ------ | ----------- | ----- |
| _none_ | — | — | No deviations approved. |

## Appendix C — Completion tracking (verifier ticks on PASS)

- [x] Phase 1 — Scaffold + proxy client + status commands — merged in #86; all gates 1.1–1.6 verified (1.5/1.6 via HEADLESS-RPC)
- [ ] Phase 2 — Whole-conversation compression via `context`
- [ ] Phase 3 — `headroom_retrieve` tool
- [ ] Phase 4 — Config surface: mode + tuning
- [ ] Phase 5 — UX, metrics, docs, asset
- [ ] Phase 6 — Release wiring

## Appendix D — Definition of Done (every phase)

- All AUTO + HEADLESS + HEADLESS-RPC gates re-derived green by the verifier from real output.
- Any remaining MANUAL (visual-only) gates have real builder-captured evidence, or are explicitly
  escalated to the user.
- Full quality gate green: `npm run check` exit 0.
- Literal layout matches this spec (every TODO path exists exactly).
- No Locked-Decision violation; no unapproved deviation/ADR (Appendix B).
- PR open with the three required checks green; branch↔commit-type symmetry; nothing on `main`.
