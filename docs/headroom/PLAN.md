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
- **LD8 — Pi-format conversion (Path A, in-extension):** Headroom's `compress()` does **not**
  recognize Pi's `AgentMessage[]` shape (`role: "toolResult"`, content parts `toolCall`/`thinking`):
  `detectFormat()` falls through to `"openai"` and returns the messages unchanged → **~0%
  compression** on real Pi conversations. Until the upstream SDK learns the Pi format (see the
  Upstream follow-up section), the extension **must convert in-process**: Pi `AgentMessage[]` →
  OpenAI messages → `compress()` → **swap the compressed content back into the original Pi messages
  in place** (preserving every Pi field — `toolName`, `toolCallId`/`id` linkage, `usage`, `provider`,
  `timestamp`, `thinking`). The conversion is **1:1 and count-preserving**; if anything fails to line
  up (format not Pi, message-count mismatch after `compress()`, any thrown error), the handler
  returns the **original** `event.messages` untouched (LD3). **Do not** reconstruct Pi messages from
  scratch (placeholder metadata) when the originals are in hand — the in-place swap is mandatory; the
  full reconstruction path belongs only to the upstream SDK contribution.
- **LD9 — Proxy settings are read-only (display, not control):** The proxy's `token`/`cache` **mode**
  and tuning are **server-launch-only** — `/v1/compress` ignores per-request `mode`, and the npm SDK
  exposes no token/cache mode (proven by the Phase 4 spike). The extension **never** sets `mode` or
  any proxy-side config (that would require relaunching the proxy → LD4 violation). It only **reads
  and reports** proxy settings via `client.proxyStats()` (`mode` + the `config` block) and tells the
  user how to change them on their own. Per-request `mode` control is deferred to the upstream track
  (Phase 7).

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
| 4 | `feat` | Status display: extension state + proxy reachability + proxy settings | 3 |
| 5 | `feat` | UX, metrics, docs, asset | 4 |
| 6 | `chore` | Release wiring | 5 |
| 7 | — | Upstream Headroom Pi-format contribution (follow-up, do **last**) | 6 |

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

**Objectives:** Compress the conversation on each LLM call through the `context` hook — converting
Pi's `AgentMessage[]` to a Headroom-recognized format and back (Path A, **LD8**) so compression
actually fires on real Pi sessions — and accumulate session savings.

**Architectural Constraints:** LD1, LD2, LD3, **LD8**. The handler returns `{ messages }` only; on
health-gate false, format-not-Pi, count mismatch, or any error it returns the **original**
`event.messages` untouched. The Pi↔OpenAI conversion is 1:1 and count-preserving, and the compressed
content is swapped **in place** back onto the original Pi messages (never reconstructed from
scratch). Core compression + conversion logic is exported as testable functions so they can be
exercised HEADLESS.

**Actionable TODOs:**
1. `packages/headroom/pi-format.ts` (new): in-extension converter (LD8). Exports
   `isPiFormat(messages): boolean` (true when any message has `role: "toolResult"` or a content part
   of type `toolCall`/`thinking`); `piToOpenAI(messages): OpenAIMessage[]` (1:1 — Pi `user`→OpenAI
   `user`, Pi `assistant` text+`toolCall` parts→OpenAI `assistant` with `tool_calls`, Pi `toolResult`
   →OpenAI `tool` with `tool_call_id`); and `applyCompressedText(originalPiMessages,
   compressedOpenAIMessages): AgentMessage[] | null` that swaps the compressed text **in place** into
   copies of the original Pi messages (preserving all Pi metadata) and returns `null` when the arrays
   are not 1:1 alignable (length mismatch / role mismatch) so the caller can passthrough.
2. `packages/headroom/compress.ts` (new): exports `compressMessages(messages, { model, baseUrl })`.
   When `isPiFormat(messages)`: convert via `piToOpenAI`, call `compress({ fallback: true })` on the
   OpenAI form, then `applyCompressedText(messages, result.messages)`; if that returns `null` (or the
   proxy returned a different count), passthrough the **original** messages. Wrapped in `try/catch`;
   returns `{ messages, tokensSaved }`, returning the original messages + `tokensSaved: 0` on any
   failure or passthrough. Non-Pi inputs fall back to plain `compress({ fallback: true })`.
3. `packages/headroom/index.ts`: register `pi.on("context", …)` that, when `isHealthy()`, calls
   `compressMessages(messages, opts)` and returns `{ messages }`; otherwise passthrough.
4. `packages/headroom/index.ts`: a session savings accumulator updated from each call's `tokensSaved`.
5. A disable mechanism (flag or setting) that turns compression off but **not** retrieve (LD2).
6. `packages/headroom/index.test.ts`: assert the `context` event is registered; unit-test the pure
   savings accumulator and the `isPiFormat` / `applyCompressedText` count-preserving + passthrough
   behavior with **no network**.
7. **Upstream tracking (cannot be completed in this build — Path A is the interim workaround):**
   create a GitHub issue in **this** repo (`jmcombs/pi-extensions`) titled e.g. *"Remove in-extension
   Pi↔OpenAI shim once Headroom SDK supports Pi format"*, describing LD8/Path A as a temporary
   workaround, and **link it to the upstream issue/PR** filed against `headroomlabs-ai/headroom`
   (Phase 7). This TODO **stays unchecked** until that upstream issue/PR exists and is cross-linked —
   the verifier does **not** tick it and does **not** block the phase on it (it is tracked under the
   Upstream follow-up section, not a Phase 2 gate). The validated upstream fix is already documented
   in `~/Projects/headroom/PI-FORMAT-NOTE.md`.

**Testing Gates:**

| # | Method | Command | Expected |
| - | ------ | ------- | -------- |
| 2.1 | AUTO | `npm run check` | exit 0 |
| 2.2 | AUTO | `npm run test -- packages/headroom` | `context` registered; accumulator + `isPiFormat`/`applyCompressedText` unit tests pass |
| 2.3 | HEADLESS | Node: `compressMessages(<real Pi `AgentMessage[]` with a stale heavy `toolResult`>)` with proxy up | `tokensSaved > 0`; output is valid **Pi** format — same length, roles `user/assistant/toolResult` preserved, `toolResult.toolCallId` + assistant `toolCall.id` linkage intact, stale `toolResult` text strictly shorter |
| 2.4 | HEADLESS | Node: `compressMessages(<Pi convo>)` with proxy **down** | returns original messages unchanged, `tokensSaved === 0`, no throw |
| 2.5 | HEADLESS | Node: `applyCompressedText` on a count-mismatched pair | returns `null` → `compressMessages` passes through original (no partial/garbled swap) |
| 2.6 | HEADLESS-RPC | drive a multi-turn convo via RPC `prompt`s, then `/headroom-status` (or stats command) | session savings notify shows non-zero; no crash. (Full model-coherence over a real session may also be spot-checked MANUAL.) |

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

## Phase 4 — Status display: extension state + proxy reachability + proxy settings

> **Why this replaced "Config surface: mode + tuning" (LD9).** The Phase 4 builder proved
> empirically that the proxy's `token`/`cache` **mode is a server-launch-only setting**: the
> `/v1/compress` endpoint the extension uses ignores any per-request `mode`/`config.mode` (identical
> output for every variant, confirmed live), and the npm SDK's `CompressOptions`/`HeadroomClient`
> expose no token/cache mode. The only lever is relaunching the proxy with `--mode`/`HEADROOM_MODE`,
> which **violates LD4** (extension never manages the proxy). A settable `mode` could therefore only
> be a no-op or an LD4 violation — both disallowed (Appendix B). **However, the proxy's mode and
> effective settings ARE queryable read-only** (`/stats` → `summary.mode`; SDK
> `client.proxyStats(): ProxyStats` with `mode?` + a `config` block: `target_ratio`, `protect_recent`,
> `compress_user_messages`, …). So Phase 4 is redefined to **detect and display** proxy state rather
> than set it — the user changes proxy settings on their own. **LD9:** the extension only ever
> **reads/reports** proxy settings; it never sets `mode` or any proxy-side config (LD4 preserved).
> Per-request `mode` control is deferred to the upstream track (Phase 7).

**Objectives:** A persistent, **read-only** status display — modeled on `packages/prompt-enhancer/`'s
footer-chip/widget pattern (`ctx.ui.setStatus` / `ctx.ui.setWidget`, guarded by `ctx.hasUI`) — that
makes the integration's state plainly visible: whether compression is **enabled**, whether the
**proxy is reachable** (+ version), the proxy's **current settings** (mode + key tuning), and **live
compression statistics** — the in-memory **session tokens saved** (the Phase 2 accumulator, truly
realtime and free) plus a **proxy savings summary** from `client.proxyStats()` (e.g. lifetime tokens
saved / compression ratio). Purely informational; the user changes proxy settings themselves.

> **Relationship to Phase 5.** Phase 5 still ships the on-demand `/headroom-stats` (and
> `/headroom-simulate`) commands for the **detailed** view. Phase 4 surfaces the **at-a-glance** live
> numbers continuously in the status display so they're "just known" without running a command — the
> two are complementary, not duplicative. Keep the heavy/detailed breakdown in Phase 5's command.

**Architectural Constraints:** **LD3** — display gathering never throws; proxy-down shows an
"unreachable" state, not an error into the loop. **LD4 / LD9** — read-only; never sets proxy config.
The display is additive and must **not** change Phase 2/3 compression behavior. UI calls are no-ops
when `!ctx.hasUI`, so the data-gathering must be a **separately exported, headless-testable** function
(the chip/widget rendering itself is the only MANUAL/visual part). **Stats freshness:** the live
**session** savings come from the in-memory accumulator (free, update the widget on each compression
pass); the **proxy** savings summary is an HTTP call, so refresh it at sensible points
(`session_start`, on the disable-flag toggle, and at most a short-TTL throttle) — never on every
`context` call (avoid adding latency to the agent loop).

**Actionable TODOs (literal paths):**
1. `packages/headroom/status.ts` (new): exported `getProxyStatus(baseUrl?, apiKey?)` that calls
   `client.proxyStats()` and returns a normalized, never-throwing snapshot of **settings + stats**
   `{ reachable: boolean, version?: string, mode?: string, targetRatio?: number, protectRecent?: …,
   compressUserMessages?: …, proxyTokensSaved?: number, proxyCompressionRatio?: number }`
   (`reachable:false` on any error). Plus a pure `formatStatusLine(state, sessionTokensSaved)` helper
   producing the display string (e.g. `Headroom: on · proxy 0.27.0 · mode token · saved 8.8k this
   session · 1.2M lifetime`).
2. `packages/headroom/index.ts`: a persistent status display via `ctx.ui.setStatus`/`setWidget`
   (pattern from `prompt-enhancer`), guarded by `ctx.hasUI`, showing enabled state + proxy
   reachability (+ version) + proxy mode (+ key settings) + **live stats** (session tokens saved from
   the accumulator + proxy savings summary). Refresh the **session** figure on each compression pass;
   refresh the **proxy** snapshot on `session_start`, the disable-flag toggle, and a short-TTL
   throttle. No-op safe when headless.
3. `packages/headroom/index.ts`: extend the existing `/headroom-status` command output to include the
   proxy settings + stats snapshot (mode + key tuning + savings) so the data is assertable HEADLESS /
   HEADLESS-RPC.
4. `packages/headroom/index.test.ts`: unit-test `formatStatusLine` (incl. session + proxy savings
   rendering) + the `getProxyStatus` shaping (no network — inject a stub stats object), and assert the
   status-display wiring is registered.

**Testing Gates:**

| # | Method | Command | Expected |
| - | ------ | ------- | -------- |
| 4.1 | AUTO | `npm run check` | exit 0 |
| 4.2 | AUTO | `npm run test -- packages/headroom` | `formatStatusLine` (settings + session/proxy savings) + `getProxyStatus`-shaping unit tests pass (no network); status-display registered |
| 4.3 | HEADLESS | Node: `getProxyStatus()` with proxy **up** | `reachable:true`, `version:"0.27.0"`, `mode:"token"`, key tuning fields populated, `proxyTokensSaved` present (number) |
| 4.4 | HEADLESS | Node: `getProxyStatus()` with proxy **down** | `reachable:false`, no throw, no proxy-side mutation |
| 4.5 | HEADLESS-RPC | `node docs/headroom/rpc-verify.mjs ./packages/headroom "/headroom-status"` (proxy up) | status notify now includes proxy **mode** + key settings + **savings** (session + proxy) |
| 4.6 | MANUAL | `pi -e ./packages/headroom` — observe the persistent status chip/widget | shows `enabled · proxy reachable (vX) · mode … · saved … this session · … lifetime`. Builder captures a transcript/screenshot; if it cannot, the verifier marks **UNVERIFIED** and escalates (the underlying data is still proven by 4.3–4.5). |

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

## Phase 7 — Upstream Headroom Pi-format contribution (follow-up — do **last**)

**Do this only after Phases 1–6 are merged and the extension ships.** This removes the need for the
in-extension Path A shim (LD8) by teaching Headroom's own SDK the Pi format. It is a contribution to
a **third-party repo**, handled by its **own dedicated agent**, and is **not** gated by this repo's
build/verify loop.

**Where:** the fork is already cloned at `~/Projects/headroom` (`origin = jmcombs/headroom`,
`upstream = headroomlabs-ai/headroom`, Apache-2.0). The complete, validated brief — problem,
exact change locations (`sdk/typescript/src/utils/format.ts` lines 22/33/463/473), reference
`piToOpenAI`/`openAIToPi` converters, test evidence (~96% vs 0% compression, round-trip fidelity),
known fidelity gaps, and a per-step checklist — lives in **`~/Projects/headroom/PI-FORMAT-NOTE.md`**.

**Actionable TODOs (tracked here; executed in the `headroom` clone, not `pi-extensions`):**
1. File an **issue** on `headroomlabs-ai/headroom` describing the missing Pi (`AgentMessage[]`)
   format support (use PI-FORMAT-NOTE.md as the basis).
2. Implement the fix on a branch of the `jmcombs/headroom` fork (add `"pi"` to `MessageFormat`,
   extend `detectFormat`, add `piToOpenAI`/`openAIToPi`, wire `toOpenAI`/`fromOpenAI`, add tests),
   and open a **PR** to upstream linked to the issue.
3. **Back-link in this repo:** update the Phase 2 upstream-tracking GitHub issue (Phase 2 TODO #7) to
   reference the upstream issue/PR URLs. Only then can that tracking TODO be considered resolved.
4. Once upstream merges and releases, follow up to **remove the Path A shim (LD8)** —
   `packages/headroom/pi-format.ts` and its use in `compress.ts` — behind a version bump of
   `headroom-ai`. (Separate future change; not part of this PLAN's Phases 1–6.)
5. **Per-request `mode` (LD9 follow-up):** file an upstream request for a **per-request token/cache
   `mode` on `/v1/compress`** (and a typed SDK `CompressOptions.mode`). Today mode is server-launch-
   only, so the extension can only *display* it (Phase 4 / LD9). If upstream adds per-request mode,
   the extension could then offer a real settable mode without violating LD4.

There are **no committed Testing Gates** for Phase 7 in this repo — its acceptance is the upstream
PR's own CI and review. Record the issue/PR URLs in Appendix C when they exist.

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
- [x] Phase 2 — Whole-conversation compression via `context` — verified in #92; gates 2.1–2.6 re-derived green (2.3/2.4/2.5 HEADLESS, 2.6 HEADLESS-RPC + registered-surface accumulation)
- [x] Phase 3 — `headroom_retrieve` tool — verified in #93; gates 3.1–3.4 re-derived green (3.3 HEADLESS, 3.4 via registered `headroom_retrieve.execute` against live proxy — RPC has no tool-invoke command); LD2/LD3 confirmed empirically
- [x] Phase 4 — Status display: extension state + proxy reachability + proxy settings — verified in #95; gates 4.1–4.5 re-derived green (4.3/4.4 HEADLESS against live proxy v0.27.0, 4.5 HEADLESS-RPC); 4.6 widget CONTENT proven via captured `setWidget` RPC event (pixel render UNVERIFIED, visual-only per gate wording); LD3-no-latency/LD4/LD9 read-only confirmed empirically (proxy untouched after down-path)
- [ ] Phase 5 — UX, metrics, docs, asset
- [ ] Phase 6 — Release wiring
- [ ] Phase 7 — Upstream Headroom Pi-format contribution (follow-up; do last). Tracking issue: _TBD_;
      upstream issue: _TBD_; upstream PR: _TBD_. Stays unchecked until upstream issue/PR exist and the
      Phase 2 tracking issue back-links them.

## Appendix D — Definition of Done (every phase)

- All AUTO + HEADLESS + HEADLESS-RPC gates re-derived green by the verifier from real output.
- Any remaining MANUAL (visual-only) gates have real builder-captured evidence, or are explicitly
  escalated to the user.
- Full quality gate green: `npm run check` exit 0.
- Literal layout matches this spec (every TODO path exists exactly).
- No Locked-Decision violation; no unapproved deviation/ADR (Appendix B).
- PR open with the three required checks green; branch↔commit-type symmetry; nothing on `main`.
