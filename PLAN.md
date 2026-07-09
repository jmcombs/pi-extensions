# PLAN — `@jmcombs/pi-relay`

> Phase-loop build spec for a new extension in this monorepo. The builder and
> verifier follow **this file literally**. Adapted from `CLAUDE-VERIFY-PLAN.md`
> (superseded/removed). Not shipped in the npm tarball.

## Context / Goal

Build a general **async agent-dispatch primitive** for the Pi coding agent:
`pi` hands a task to a headless agent CLI and the result is **relayed back into
the live session mid-turn, non-blocking**. The flagship consumer is **phase
verification** (`verify_phase`) — on a locked 9-case benchmark only subscription
**Opus via `claude -p`** clears the bar clean (6/6 catch, 0 false-merge, 0
false-fail, 3/3 audit; billed to the Claude subscription via `oauthAccount`, not
the API). A thin generic `dispatch` tool rides the same substrate so the neutral
name is earned. A **driver/adapter seam** (`AgentDriver`, sole impl `claudeDriver`)
keeps the core backend-agnostic.

## Locked Decisions (frozen — deviation requires an ADR + orchestrator routing)

- **D1** Verify backend = subscription **Opus via `claude -p`** (`oauthAccount`) —
  never the Anthropic API, never a local model. **No API-key code path** in the
  verify consumer.
- **D2** Scoped `--allowedTools "Bash Read Grep Glob"`. **Never**
  `--dangerously-skip-permissions`. Read-only verify.
- **D3** `--model opus`, `--output-format json`; verdict = **last**
  `/VERDICT:\s*(PASS|FAIL)/i` match in the JSON envelope's `.result`.
- **D4** **Async** — `execute()` returns immediately (`PENDING`); verdict arrives
  via `sendMessage(…, { triggerTurn: true })`.
- **D5** `peerDependencies` **per the template**: `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`, `typebox` — all `"*"`. **Not** `pi-agent-core`; **not**
  the `@mariozechner` fork.
- **D6** Wall-cap backstop (default **600 s**, configurable) + `signal` →
  `child.kill`. On cut / no-verdict push **`UNVERIFIED`**, never auto-`PASS`.
- **D7** The verify tool **reports verdict + evidence only** — never merges or ticks.
- **D8** Re-entrancy guard: `process.env` sentinel at the **top of the factory** so
  it does not re-register inside a spawned child.
- **D9** Error signalling. `AgentToolResult` supports **only** `content`, `details`,
  `terminate` — there is **no `isError` field**, and a returned `isError` is
  **silently ignored**: `pi-agent-core/dist/agent-loop.js` `executePreparedToolCall`
  hardcodes `isError:false` on the success path, and `finalizeExecutedToolCall`
  rebuilds the result as `{content,details,terminate}` only. A tool result is flagged
  `isError:true` **only** when `execute()` **throws** (harness wraps it via
  `createErrorToolResult`), arg-validation/`beforeToolCall` blocks, or an
  `afterToolCall` hook overrides it. Therefore relay's **synchronous setup-error path
  MUST `throw`** (never `return { …, isError }`). Async dispatch errors are delivered
  via the `sendMessage` pushback as an `UNVERIFIED` verdict, independent of tool-result
  `isError`. (`grok-search:88`'s returned `isError` is the same latent no-op bug —
  tracked in its own issue, out of scope for this PR.)
- **D10 (seam)** `AgentDriver` interface; `claudeDriver` the **sole** implementation.
  Core (spawn, pushback, wall-cap, signal) is driver-agnostic. Verdict parsing lives
  in the **`verify_phase` consumer**, not the driver. **Backend tool-name mapping is a
  driver function** — the resolver stays backend-neutral (persona + skills + pi tool list);
  each driver maps that to its agent (`claudeDriver` → `--allowedTools`, `codexDriver` → `-s`).
- **D11 (use pi's APIs — never reinvent)** Use pi's **public extension APIs**; never mirror,
  fork, or hand-roll pi internals. Import pi types/helpers from the official
  `@earendil-works/*` packages (e.g. `createAssistantMessageEventStream()` from
  `@earendil-works/pi-ai`). Adding an **official** pi package as a peer-dep is permitted and
  is **not** the forbidden `@mariozechner` fork (D5). Re-implementing a pi contract by hand
  is a defect.
- **D12 (read-only by declaration + detect/present, NOT sandbox)** relay does **not** OS-sandbox
  dispatched agents. A role's read-only posture is expressed by its **declared tools** — relay maps
  only those to the backend (withholding Edit/Write). A hard filesystem sandbox is **rejected**: it
  breaks the verifier's own mandated gates (`vitest` writes scratch under `node_modules/` *inside* cwd)
  and buys **no verdict integrity** — a bad verifier returns a wrong verdict without writing a byte, so
  write-blocking is the wrong lever. Instead, tree-hygiene is enforced by **detection, not prevention**:
  the verifier runs in the real git-tracked tree; **after** verify the orchestrator diffs the tree, and
  if the verifier changed anything it **presents the diff to the human and asks discard-or-keep** before
  acting on the verdict. Containment already holds — the verifier can't merge/tick (**D7**), its changes
  are git-visible + uncommitted, and merge is human-gated. (Supersedes the Phase-5 Seatbelt-sandbox
  spike, reverted.)

## Git / PR conventions (PLAN-wide)

- **Single feature branch `feat/relay`** holds Phase 0 (assets, already committed)
  + Phase 1 (scaffold) → **one PR** against `main`. **This supersedes phase-build's
  branch-per-phase default** — it is an explicit project decision; the verifier must
  treat the single-branch layout as **compliant**, not a hygiene FAIL.
- **From Phase 2 on, each phase gets its own branch → its own PR** (`feat/relay-phase2`,
  …), per the standard branch-per-phase model; Phase 0+1 sharing one branch was a
  one-time bootstrap exception.
- [Conventional Commits](https://www.conventionalcommits.org/), scope `relay`.
  `commitlint` (`header-max-length` 100) enforced by the `commit-msg` hook. `biome`
  runs on staged files via the `pre-commit` hook.
- **The builder commits its work to `feat/relay` and STOPS.** No PR, no merge, no
  tick. **The PR is opened by the orchestrator only after verifier PASS + explicit
  human approval**, then merged in the separate human-approved merge step.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- No build artifacts committed (`.gitignore` already covers `dist/`, `coverage/`,
  `node_modules/`; jiti loads `.ts` directly — there is no build step).
- **Adding a workspace package requires regenerating the root `package-lock.json`**
  (`npm install`) and committing it **in sync** — CI's first step is `npm ci`, which
  hard-fails on an out-of-sync lockfile before any check runs.

---

## Phase 0 — Logo & brand assets  ✅ DONE

- Chosen: **A1 "Boxed round-trip"**. Assets committed on `feat/relay` @ `d33d7c7`
  under `assets/relay/` (`preview.{svg,png}`, `logo/relay-mark*.svg`,
  `relay-icon.svg` + `-512.png`, `relay-favicon-32.png`).

---

## Phase 1 — Scaffold `packages/relay` + driver seam + unit-prove  ✅ DONE

**Entry phases:** Phase 0 (assets) — done.

### Objectives
A working, **private** `@jmcombs/pi-relay` extension that registers `verify_phase`
and a generic `dispatch` tool, dispatches to a headless agent through the driver
seam, returns `PENDING` immediately, and relays the result back asynchronously via
`sendMessage(…, { triggerTurn: true })`.

### Architectural Constraints
All of **D1–D10** above apply. In particular: no API-key path (D1); scoped tools,
never skip-permissions (D2); async, non-blocking `execute()` (D4); template peer-deps
(D5); fail-safe `UNVERIFIED`, never auto-PASS (D6); re-entrancy guard (D8); driver
seam with verdict-parse in the consumer (D10).

### Actionable TODOs (literal paths — build exactly here)
- [ ] `packages/relay/package.json` — copy `packages/_template/package.json`; set
  `name` `@jmcombs/pi-relay`, keep `"private": true`; `description` credits Claude
  nominatively ("…dispatches to headless Claude Opus via `claude -p`"); peer-deps
  per **D5**; `pi.image` → `assets/relay/preview.png`; `files`
  **must include `drivers/`** (it is imported at runtime) — e.g.
  `["index.ts","drivers/","README.md","LICENSE"]`; do **not** ship `scripts/` or
  `index.test.ts`; topical `keywords`.
- [ ] `packages/relay/tsconfig.json` — copy from `packages/_template/tsconfig.json`.
- [ ] `packages/relay/LICENSE` — MIT, copied from the template.
- [ ] `packages/relay/README.md` — what it does + usage; **trademark disclaimer**
  verbatim: *"Not affiliated with or endorsed by Anthropic. Claude and Opus are
  trademarks of Anthropic, PBC."*; note the verify backend is Claude-Opus-only.
- [ ] `packages/relay/drivers/claude.ts` — export the `AgentDriver` interface and
  `claudeDriver` (`name:"claude"`, `bin:"claude"`, `buildArgs` per **D2/D3**,
  `parseResult` reading the `--output-format json` envelope `{ type:"result",
  result, is_error }` → `.result`). No verdict parsing here (**D10**).
- [ ] `packages/relay/index.ts` — default-exported factory:
  re-entrancy guard at the top (**D8**); registers `verify_phase`
  (TypeBox `Type.Object({ phase, cwd?, prompt? })`) and `dispatch`
  (TypeBox `Type.Object({ prompt, cwd? })`); both spawn via `claudeDriver`
  **without awaiting** and return `PENDING` (**D4**); on child close, parse (verdict
  regex for `verify_phase`, **D3**) and push back via
  `sendMessage(…, { triggerTurn: true })` + `events.emit`; wall-cap + `signal`→kill
  with `UNVERIFIED` on cut (**D6**); synchronous setup errors **`throw`** (never return
  `isError`), async errors ride the pushback (**D9**).
- [ ] `packages/relay/index.test.ts` — **registration smoke test** (asserts
  `verify_phase` and `dispatch` register against a stub `ExtensionAPI`; **no live
  API, no network**) **plus a test asserting the synchronous setup-error path THROWS**
  (D9 — proves the error is real, not a no-op `isError`). Repo convention (mirror
  `packages/grok-search/index.test.ts`).
- [ ] `packages/relay/scripts/harness.mjs` — standalone **approach-B proof**: stub
  `ExtensionAPI` + **real `claude -p`**, reproducing Appendix A. Prints the 5 checks.
  Run manually; **not** part of `npm run check`.

### Testing Gates (exact command → expected)
- **Gate 1 — repo quality gate.**
  Command: `npm run check` (repo root).
  Expected: **exit 0**; `biome check .` clean, `node scripts/typecheck.mjs` 0 errors,
  `vitest run` all pass **including `packages/relay/index.test.ts`**, `check:versions`
  passes, `security` (secretlint + `npm audit --omit=dev`) passes.
- **Gate 2 — async approach-B proof (manual, real Opus).**
  Command: `node packages/relay/scripts/harness.mjs` (with `claude` authed via
  `oauthAccount`).
  Expected: real stdout showing **5 OK lines** — (1) tool registered;
  (2) duplex receive+reply; (3) `execute()` returns `PENDING` **non-blocking** (< 15 s);
  (4) async pushback delivers a verdict; (5) pushback triggers a turn.
- **Gate 3 — types against earendil (call-out of Gate 1).**
  Command: `node scripts/typecheck.mjs`.
  Expected: **0 type errors** — confirms **D5** peer-deps resolve and the tool returns
  only `AgentToolResult` fields (`content`/`details`/`terminate`; no `isError`, per **D9**).
- **Gate 4 — lockfile in sync (CI parity).**
  Command: `npm ci` (repo root).
  Expected: **exit 0** — the root `package-lock.json` includes the new
  `@jmcombs/pi-relay@0.0.0` workspace entry and installs cleanly. CI runs `npm ci` as
  its first step, so an out-of-sync lockfile fails every required check before any
  test/lint runs. (`npm install` must produce **no further lockfile diff**.)

### Definition of Done — see Appendix D.

---

## Phase 2 — Live-session integration  ✅ DONE

**Entry phases:** Phase 1 (merged to `main` @ `80e0be5`). Own branch `feat/relay-phase2`
→ own PR.

### Objectives
Prove the **real pi runtime** delivers the async verdict as a **follow-up turn** — the
one thing the Phase-1 mock (stub `ExtensionAPI`) could not: real
`sendMessage(…, { triggerTurn: true })` delivery. Answer **Q1** (does `triggerTurn`
fire immediately, or queue until the orchestrator is idle / `ctx.isIdle()`), and if
delivery is not reliable, mirror pi-intercom's idle flush-queue so the verdict always
lands.

### Architectural Constraints
- Locked Decisions **D1–D10** continue to hold; the `verify_phase`/`dispatch` contract
  and the driver seam do **not** change shape.
- Any Q1 fix is **additive/behavioral** (queue-and-flush on idle) — it must not weaken
  **D4** (non-blocking `execute()`) or **D6** (fail-safe `UNVERIFIED`, never auto-PASS).
- **No new runtime dependencies** (peer-deps stay = D5; lockfile stays in sync, Gate 4).

### Actionable TODOs (literal paths)
- [ ] `packages/relay/scripts/live-session.mjs` — a **scriptable live-session
  integration harness**: launch a real `pi` session with `--extension ./packages/relay`
  in a programmatic mode (`--mode rpc`, falling back to `--mode json`), send a user
  turn that invokes `verify_phase`, **keep the session alive**, and capture from the
  real runtime: (a) the tool returns `PENDING` immediately, (b) an **async follow-up
  turn** carrying `VERDICT: PASS|FAIL` arrives via the pushback, (c) the **timing of
  `triggerTurn`** (immediate vs. after idle) = the Q1 answer. Print OK/FAIL checks like
  `harness.mjs`; exit 0 iff async delivery is observed. **Not** part of `npm run check`.
- [ ] `packages/relay/index.ts` — **only if Q1 requires it**: if `triggerTurn` queues
  until idle, add a pi-intercom-style `ctx.isIdle()` flush-queue so the verdict is
  delivered reliably. If Q1 shows immediate delivery, make **no** code change and record
  that in the report. Any change stays within D4/D6.
- [ ] `packages/relay/README.md` — a short "Live-session behavior" note documenting the
  Q1 finding (immediate vs. idle-queued) so users know when the verdict lands.

### Testing Gates (exact command → expected)
- **Gate 2.1 — live async delivery (real runtime).**
  Command: `node packages/relay/scripts/live-session.mjs` (real `pi` + `claude` authed
  via `oauthAccount`).
  Expected: real output showing the tool returned `PENDING`, then an **async follow-up
  turn with `VERDICT: PASS|FAIL`** delivered by the live runtime, plus the Q1 timing
  line. **UNVERIFIED** (never faked) if the environment genuinely cannot drive an
  rpc/interactive `pi` session — escalate to the orchestrator instead.
- **Gate 2.2 — regression.**
  Command: `npm run check` → exit 0 (vitest green; if a Q1 idle-flush change was made,
  add/extend a unit test covering it).
- **Gate 2.3 — lockfile parity.**
  Command: `npm ci` → exit 0; `npm install` → no further diff (Gate 4 carries forward).
  Also re-run Phase-1 `node packages/relay/scripts/harness.mjs` if `index.ts` changed.

### Definition of Done
Appendix D items 1–8 hold; Gate 2.1 proven (or UNVERIFIED + escalated, never faked);
Q1 documented in the README; if `index.ts` changed, the async substrate still proves
out via `harness.mjs`.

## Phase 3 — Relay Roles (provider seam)  ✅ DONE

**Entry phases:** Phase 2 (merged @ `cf2add8`). Own branch `feat/relay-phase3` → own PR.

### Concept (locked design — Option B)
A **relay role** is an existing **pi-subagent** (persona `.md` + its referenced `SKILL.md`s)
executed on an **external coding agent** instead of a local pi model. The subagent
definition is the single source of truth; a per-agent **driver** adapts its standardized
fields into that agent's invocation. Relay registers a pi **provider**, so a subagent runs
externally simply by setting its `model` field — *nothing changes but the processor*.

- **Trigger + model:** `model: relay-claude/opus` → pi's native `resolveModel` routes to
  relay's registered provider → `claudeDriver` → `claude -p … --model opus`.
- **Persona + skills:** the driver resolves the persona body + each `SKILL.md` and injects
  them via `--system-prompt-file` (`systemPromptMode: replace`) / `--append-system-prompt-file`.
  Deterministic — our code writes the file; no model re-echo, no drift (this fixes the ~22%
  inline-prompt drift found in the Phase-4 baseline).
- **Tools:** subagent `tools` → `--allowedTools` via a rename map (`read→Read, bash→Bash,
  edit→Edit, write→Write, grep→Grep, glob→Glob`); pi-only tools with no external equivalent
  are dropped; `thinking` / context-inherit fields are N/A.
- The relayed subagent is **single-turn** (no pi-side tools; the external agent runs its own
  tool loop) — one provider completion = one full `claude -p` run returning the final text.
  pi's native subagent-async layer delivers the result, **superseding relay's bespoke
  `verify_phase` tool + custom pushback** (Phases 1–2).

### Objectives
Make any pi-subagent runnable on an external coding agent via the driver seam, and
re-express the **verifier** as a relayed subagent — no bespoke tool, no inline prompt.

### Actionable TODOs (literal paths)
- [ ] **Gate-zero spike** — prove pi's `registerApiProvider`/`registerProvider` contract can
  represent *"one completion = one full `claude -p` run"* (single-turn, no pi-side tools,
  returns the final assistant text). **If it cannot → STOP and escalate; fall back to Option A**
  (relay stays a tool that resolves the subagent def) — a human decision, not the builder's.
- [ ] `packages/relay/provider.ts` — register provider `relay-claude`; `model: relay-claude/*`
  routes here; a completion runs the driver and returns the external agent's final text.
- [ ] `packages/relay/roles/resolver.ts` — resolve a pi-subagent by name (persona `.md` + its
  `SKILL.md`s from `~/.pi/agent`), assemble the system-prompt file; apply the tool map.
- [ ] `packages/relay/drivers/claude.ts` — evolve `claudeDriver`: fields →
  `claude -p --system-prompt-file <assembled> --allowedTools <mapped> --model <model>
  --output-format json`; preserve **D1** (Opus for verify) / **D2** (read-only).
- [ ] `packages/relay/drivers/codex.ts` — **seam-only stub + documented mapping** (deferred
  build; no codex account): `codex exec`, persona+skills → AGENTS.md / `-c` instructions,
  `-m`, `-s read-only`, `--json` + `-o <file>`.
- [ ] Retire `verify_phase`'s inline-`prompt` path; the verifier runs as a relayed subagent.
  Keep D1/D2/D6 semantics.

### Architectural Constraints
- **No fork of pi core** — use its extension APIs (`registerProvider`/`registerApiProvider`).
- **D1/D2 preserved for the verify role** (Opus, read-only); "roles" is a superset above the
  Locked Decisions. Fail-safe (D6) and driver seam (D10) preserved; D4 non-blocking now comes
  from pi's subagent-async layer.
- The subagent definition is **unchanged** whether run locally or via relay (single source).

### Testing Gates (exact command → expected)
- **Gate 3.0 (spike)** — a minimal `registerApiProvider` proof that a `relay-claude/*` model
  yields one `claude -p` run's final text as the completion. Expected: real external output
  captured; or a documented escalation to Option A.
- **Gate 3.1** — the `verifier` pi-subagent (defined once) run via `model: relay-claude/opus`
  through pi's **native** subagent system on one real phase returns a real Opus verdict
  (`VERDICT: PASS|FAIL`), with persona+skills provably injected (byte-exact system-prompt
  file). Proven live.
- **Gate 3.2** — `npm run check` → exit 0; lockfile parity (Gate 4).

### Corrective refinements (found in verify — apply before merge)
1. **Inline skill content (fidelity).** pi injects a subagent's skills as `<available_skills>`
   *references* (name/desc/`<location>`); relayed to `claude -p`, the external agent gets only
   pointers. The role resolver must **read each referenced `SKILL.md` and inline its full
   content** into the assembled system prompt so the methodology is guaranteed present (prefer
   a pi API to expand skills → content if one exists per D11, else read the files).
2. **Tool-name map → driver (D10).** Move the pi→backend tool map out of `roles/resolver.ts`
   into `claudeDriver`. Use pi's **real** tool names: `read→Read, bash→Bash, grep→Grep,
   write→Write, edit→Edit, find→Glob`, `ls`→Bash/drop; there is **no** pi `glob` — drop the
   phantom entry.
3. **Use pi's stream API (D11).** Delete `stream.ts`; use `createAssistantMessageEventStream()`
   from `@earendil-works/pi-ai` (add as peer-dep; write the ADR — official pkg, not the fork).
4. **Real single-source verifier.** Update `~/.pi/agent/agents/verifier.md`:
   `model: relay-claude/opus`, `tools: read, bash, grep, find` (drop `edit` → D2), wire the
   relay extension. **Re-prove Gate 3.1 with the real verifier.md** (not a stand-in). Report
   the dotfiles diff for the human to commit — do **not** auto-commit the user's dotfiles.
5. **biome-ignore `.pi-subagents/`** in `biome.json` (subagent-run artifacts trip `npm run check`).

### Definition of Done
Appendix D items 1–8 hold; Gate 3.0/3.1 proven live (or spike-fail escalated, never faked);
the verifier runs as a relayed subagent with no inline prompt (real verifier.md, skills
inlined); the corrective refinements above are all applied; codex seam documented. The
full 9-case accuracy re-benchmark is **Phase 4**, not this phase.

## Phase 4 — Accuracy regression (through the role)  ← ACTIVE

### Objectives
Re-run the locked **9-case verifier benchmark** against the **role-based** verifier — the
relayed `verifier` subagent (`model: relay-claude/opus`, `{phase,cwd}`-only, **no inline
prompt**, methodology from its 4 skills) — reproducing the accuracy bar the old inline-prompt
design already cleared. **Remove `docs/prompts/` from the benchmark sandbox** (the methodology
now lives in the role + skills, not a prompt file the case carries).

### Topology (LOCKED — the seat correction)
- **Host / orchestrator seat = LOCAL `qwen3.6-35b-a3b` @ `localhost:11439`** (llama.cpp). The
  benchmark's hosting `pi` session runs on qwen and dispatches the verifier subagent per case.
- **Verifier = `relay-claude/opus`** (external subscription Opus via `claude -p`) — the **only**
  external call. **No local verifier seat** (`:11436` stays down); **no Haiku / API / non-local
  driver anywhere.** (Last accuracy attempt wrongly used a Haiku driver — do not repeat.)
- Builder seat (`ornith` @ `:11437`) is not exercised (cases are pre-built), may be up.

### IP constraint (LOCKED, user-approved — must hold)
The benchmark is the **PRIVATE** `jmcombs/verifier-benchmark` repo (macprefs IP). ALL case
internals, the runner, and per-case verdict text stay in the private repo
(`~/.cache/verifier-bench`). **Only the numeric summary** may enter the public `pi-extensions`
repo. **No macprefs token — path, brand hex, theme name, filename — in any pi-extensions file,
commit, or table.** The through-the-role runner lives in the private repo.

### Actionable TODOs
- **(private repo)** Point the runner at the relayed verifier **role** (dispatch the `verifier`
  subagent at `relay-claude/opus`) instead of `docs/prompts/verify-phase.md`; **remove
  `docs/prompts/` from the sandbox cases.**
- **(private repo)** Run all **9 cases** (3 correct + 6 defects incl. 3 audit-only) with the
  host on qwen `:11439`; score verdicts vs `answer-key.json` (false-merge = dangerous,
  false-fail = over-strict, audit-catch); re-lock the private results.
- **(public repo, this branch)** Record **only the numeric summary** in the results table below.

### Testing Gates (exact → expected)
- **Gate 4.1 (accuracy):** 9/9 — **0 false-merge, 0 false-fail, 3/3 audit-catch** via the role
  (`relay-claude/opus`), host on qwen.
- **Gate 4.2 (topology):** captured invocations show the verifier at `--model opus` (D1),
  read-only tools (D2); host session model = `qwen3.6-35b-a3b`; no non-local driver present.
- **Gate 4.3 (no leak + removal):** `git grep` in `pi-extensions` finds **no** macprefs token;
  `docs/prompts/` removed from the sandbox; only the numeric summary is public.
- **Gate 4.4 (repo):** `npm run check` green (public repo gains only the summary doc).

### Results — numeric summary
| metric | baseline (inline-prompt) | Phase 4 (through the role) |
|---|---|---|
| correct | 9/9 | **9/9** |
| false-merge | 0 | **0** |
| false-fail | 0 | **0** |
| audit-catch (spec-only defects) | 3/3 | **3/3** |
| avg wall / case | ~150 s | ~149 s |

_Baseline = the old inline-prompt/`verify_phase` design. Phase 4 filled the right column via the
**role** — host on local `qwen3.6-35b-a3b` (`:11439`), verifier on `relay-claude/opus` (Opus,
read-only) — with `docs/prompts/` removed from the sandbox. No macprefs specifics — numeric only._

### Definition of Done
9/9 reproduced **through the role** with the correct local-host / Opus-verifier topology;
`docs/prompts/` removed from the sandbox; private results re-locked; only the numeric summary in
the public repo; no IP leak (Gate 4.3 clean). Appendix D full-repo regression holds.

---

## Phase 5 — Wire into the phase loop (self-hosting)  ← DONE (#109)

### Objectives
Wire the real pi phase loop so the **orchestrator** dispatches the **relay verifier**
(`verifier.md`, already `relay-claude/opus`) and routes **PASS → human merge-gate**, **FAIL →
remediation** — and harden the two Phase-4 findings per the locked architecture. **Scope: demonstrate,
then cut over** (Q1) — prove the wiring end-to-end this phase; the real loop fully self-hosts on
relay only **after Gate B (Phase 6)**. Spans two repos: `packages/relay` (enforcement code) and the
user's **dotfiles** orchestration (`phase-orchestrate` skill, `verifier.md`, `merger.md`) — dotfiles
changes are reported as diffs for the human to commit (as in Phase 3/4), never auto-committed.

### Part 1 — Read-only by declaration; NO sandbox (D12 revised, `packages/relay`)
- **Revert the driver OS sandbox** (the `--settings` Seatbelt `denyWrite:[cwd]` + `--disallowedTools`
  enforcement from the reverted spike). It broke the verifier's own **mandated** gates (`vitest` writes
  scratch to `node_modules/.vite-temp` *inside* cwd → EPERM, zero tests collected) and buys **no verdict
  integrity** (a bad verifier returns a wrong verdict without writing a byte). A read-only role is
  read-only **by declaration**: relay maps only its declared read-only tools to the backend (no
  Edit/Write) and does **not** OS-sandbox. The read-only verifier MUST be able to run the repo's full
  `npm run check` (incl. `vitest`) **in-tree**.

### Part 1b — Tree-hygiene by detection, human-decides (D12, dotfiles orchestration)
- Enforcement that "the verifier didn't tamper with the tree" is by **detection, not prevention**:
  **after** verify, the orchestrator diffs the working tree; if the verifier changed anything it
  **presents the diff to the human and asks whether to discard or keep**, and does **not** act on the
  verdict until the human decides. Containment already holds — the verifier can't merge/tick (**D7**),
  its changes are git-visible + uncommitted, and merge is human-gated.

### Part 2 — Dispatch cardinality (Q3=1, in dotfiles)
- `phase-orchestrate` skill instructs the orchestrator to dispatch verify **exactly once**, then wait
  for the verdict. relay stays a clean per-completion provider (no dedup state); **D8** re-entrancy
  guard is the process-level backstop. **No relay code** for this — it's the caller's contract.

### Part 3 — Routing (dotfiles orchestration)
- Orchestrator routes the relay verdict: **PASS → stop at the human merge-gate** (never auto-merge/
  tick — **D7**); **FAIL → remediation** (back to builder with the evidence). `merger.md` unchanged
  except to consume the relay verdict.

### Part 3b — Read-only verifier: disable the completion guard (root cause of the exit-1 FAIL)
- A read-only verifier makes **no file edits**, so pi-subagents flips its exit **0 → 1** via the
  **completion/no-edits guard** (`execution.ts:838` → "completed without making edits for an
  implementation task"); a *failed* run's inline output is then replaced by a `[failed]` summary,
  **burying the verdict** (the orchestrator must artifact-grep to recover it → risks misrouting a real
  PASS/FAIL as an execution failure). **Fix (set once, robust):** `completionGuard: false` in
  **`verifier.md` frontmatter** — the agent loader honors it (`agents.ts:1156` coerces the string),
  and `execution.ts:838` then skips the guard entirely. **Do NOT set `acceptance` on the dispatch:** the
  acceptance gate only flips the exit when acceptance is **explicit** (`execution.ts:1099`); left
  inferred (`explicit=false`) it never fails the run. ⚠️ The earlier
  `acceptance: { level: "none", reason }` approach is **rejected on two counts** (both observed live):
  (a) the local orchestrator **can't emit the nested object** — qwen serialized it as a JSON *string* →
  tool-validation error → forced a `false` fallback; (b) it targeted the wrong gate (the completion
  guard, not acceptance, is what failed the run). With `completionGuard:false` + no acceptance param the
  verify run exits **0** and its `VERDICT` flows into the subagent tool result inline (pi default
  `outputMode:"inline"`) — no artifact-grep. **Not a relay issue** — a local read-only verifier hits the
  identical guard.

### Testing Gates (exact → expected)
- **Gate 5.1 (no sandbox breakage):** the read-only verifier runs the repo's **full `npm run check`
  (incl. `vitest`) to a real pass/fail in-tree** — no EPERM, tests actually collected. Proves the
  reverted sandbox unbroke verification.
- **Gate 5.2 (routing) — CITE REAL ARTIFACTS:** end-to-end via the real orchestrator (qwen `:11439`) →
  relay verifier (Opus): one **PASS** halts at the human merge-gate (no auto-merge/tick, D7); one
  **FAIL** → remediation. **Commit/cite the run transcripts** (distinct `toolCallId`s) — a claim is not
  proof (the first attempt cited none).
- **Gate 5.3 (dispatch cardinality):** exactly **one** verify dispatch per scenario, re-derivable from
  the cited artifacts.
- **Gate 5.4 (tree-hygiene detect+present):** a verify that mutates the tree is **detected** and
  **surfaced to the human** (keep/discard) before the verdict is acted on — demonstrated.
- **Gate 5.5 (repo):** `npm run check` green; lockfile in sync; ADR 0002 **rewritten** to the detect
  model + indexed (Appendix B).
- **Gate 5.6 (verify exits 0 + verdict in-result, VERBATIM skill):** with `completionGuard: false` on
  `verifier.md` (and NO `acceptance` param on the dispatch), the verifier run exits **0**, and its
  `VERDICT` appears in the **subagent tool result** (not only an artifact). Gates 5.2–5.4 routing
  re-proven with the orchestrator driven by the **verbatim shipped `phase-orchestrate` skill** — NO
  hand-injected grep/outputPath logic in the prompt.

### Definition of Done
Driver sandbox **reverted**; the read-only verifier runs the full `npm run check` in-tree (Gate 5.1);
orchestrator dispatches verify exactly once, routes PASS/FAIL correctly, and **presents any verifier
tree-change to the human** (Gates 5.2–5.4) — all proven with **cited** artifacts; real-loop cutover
deferred to post-Gate-B; D12 + ADR rewritten; dotfiles diffs reported for the human to commit;
Appendix D regression holds.

---

## Phases 6–7 (spec finalized when reached — objectives + gates only)
- **Phase 6 — Gate B.** ✅ DONE. Gate B measured **through the shipped `verifier` role**
  (relay-claude/opus + its real skills), not bare `claude -p` — the only lens that catches a
  role-level false-merge. Full 9-case pass: 6/6 gate-defect catch, **0 false-merge**, 3/3
  audit-catch, 3/3 correct→PASS, 0 UNVERIFIED; audit-stability 9/9. A stochastic false-merge on
  a committed `dist/` artifact was root-caused to the `git-hygiene` skill and fixed at source.
  Then flipped `"private": false` + registered Release Please; **`@jmcombs/pi-relay@1.0.0`
  published** (bootstrap 0.0.0 → OIDC-managed 1.0.0). `verifier.md` repointed to
  `npm:@jmcombs/pi-relay`.
- **Phase 7 — (optional) Duplex escalation.** Intercom-broker ask-reply for human escalation
  (true pi↔pi / cross-session channel).

---

## Appendix A — proven reference (approach B)

Non-blocking spawn + parse + push-back. The shippable version lives behind
`claudeDriver` (TypeScript, `@earendil-works` types); `scripts/harness.mjs`
reproduces this proof against a real `claude -p`.

```js
function runClaudeAsync(prompt, cwd, onDone, signal) {
  const child = spawn("claude", [
    "-p", prompt, "--output-format", "json", "--model", "opus",
    "--allowedTools", "Bash Read Grep Glob", "--max-turns", "80",
  ], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", d => (out += d));
  signal?.addEventListener?.("abort", () => child.kill("SIGTERM"), { once: true });
  child.on("close", () => {
    let verdict = "UNKNOWN", result = "";
    try { result = String(JSON.parse(out).result ?? ""); } catch {}
    const m = /VERDICT:\s*(PASS|FAIL)/i.exec(result);
    if (m) verdict = m[1].toUpperCase();
    onDone({ verdict, result });
  });
}
```

The 5-step proof `harness.mjs` must print: (1) `verify_phase` registered;
(2) duplex receive+reply; (3) `execute()` returned `PENDING` non-blocking (< 15 s);
(4) async pushback delivered a verdict; (5) pushback triggered a turn.

## Appendix B — ADR index

| ADR  | Slug                          | Phase | Status   |
| ---- | ----------------------------- | ----- | -------- |
| 0001 | pi-ai-peer-dependency         | 3     | Accepted |
| 0002 | per-role-execution-posture (read-only by declaration; tree-hygiene by detection — sandbox rejected) | 5 | Accepted |

If a deviation from a literal TODO or a Locked Decision is genuinely required,
create `docs/decisions/000N-<slug>.md` (MADR-lite: **Context / Decision /
Consequences**), add a row here, and route the deviation to the orchestrator for
human decision. Do not self-approve. (ADR 0001 records the D11-mandated addition of
the official `@earendil-works/pi-ai` peer-dep + deletion of the hand-rolled
`stream.ts` — an alignment with a Locked Decision, not a deviation from one.)

## Appendix C — Phase tick tracker (ticked only in the human-approved merge step)

- [x] Phase 0 — Logo & brand assets
- [x] Phase 1 — Scaffold + driver seam + unit-prove
- [x] Phase 2 — Live-session integration
- [x] Phase 3 — Relay Roles (provider seam)
- [x] Phase 4 — Accuracy regression (through the role)
- [x] Phase 5 — Wire into the phase loop
- [x] Phase 6 — Gate B (published `@jmcombs/pi-relay@1.0.0`)
- [ ] Phase 7 — (optional) Duplex escalation

## Appendix D — Definition of Done (full-repo regression; verifier runs all)

1. `npm run check` **exit 0** across the whole workspace — **no predecessor package
   broken** (regression is a FAIL even if Phase 1's own gates pass).
2. Every Phase-1 Actionable TODO path exists **exactly** as written; no relocation or
   rename without an ADR.
3. Locked Decisions **D1–D10** upheld — spot-check: no API-key path (D1); tools scoped,
   no skip-permissions (D2); `execute()` non-blocking (D4); peer-deps exactly D5;
   fail-safe `UNVERIFIED` on cut (D6); re-entrancy guard present (D8); **no returned
   `isError` anywhere — synchronous setup errors `throw` (D9)**; single `claudeDriver`
   impl, verdict-parse in the consumer (D10).
4. README trademark disclaimer present verbatim.
5. `package.json` `files` includes `drivers/`; excludes `scripts/` and tests;
   `"private": true`.
6. Git hygiene: work committed on `feat/relay` (single-branch convention above);
   Conventional Commits; no build artifacts; clean `git status` after commit.
7. Gate 2 (`harness.mjs`) proven with **real** `claude -p` stdout, or explicitly
   marked **UNVERIFIED** with the reason if the environment cannot reach `claude`
   (never PASS an unproven gate).
8. Root `package-lock.json` **in sync** — `npm ci` at repo root exits 0 and `npm install`
   yields no further lockfile diff (Gate 4; CI parity — CI runs `npm ci`).
