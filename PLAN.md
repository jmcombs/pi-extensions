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
  in the **`verify_phase` consumer**, not the driver.

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

## Phases 3–6 (spec finalized when reached — objectives + gates only)
- **Phase 3 — Accuracy regression.** Drive the locked 9-case benchmark **through the
  extension**. Gate: 9/9 — 0 false-merge, 0 false-fail, 3/3 audit-catch.
- **Phase 4 — Wire into the phase loop (self-hosting).** Orchestrator dispatches
  `verify_phase`; PASS → human merge-gate, FAIL → remediation; retire/repoint
  `verifier.md`. Gate: an end-to-end phase verifies and routes correctly.
- **Phase 5 — Gate B.** 25 live orchestrated verify runs. Gate: 0 false-merge across
  all 25. Then flip `"private": false` + Release Please for 1.0.0.
- **Phase 6 — (optional) Duplex escalation.** Intercom-broker ask-reply for
  human escalation (true pi↔pi / cross-session channel).

---

## Phase 7 — "Relay Roles" generalization (post-Phase-5)

**Entry phases:** Phase 5 (verifier path proven in production — do not generalize
before the flagship role is proven). Own branch `feat/relay-roles` → own PR.

### Objectives
Generalize the async-dispatch substrate into a reusable **role** abstraction so new
agent roles (research, summarize, triage, lint, …) can be added declaratively,
following the same methodology as `verify_phase`. Prove it by shipping a **second
reference role** that legitimately differs from the verifier (different tools/model).

### The role abstraction
A relay **role** is a tuple over the shared non-blocking spine (`runDriverAsync` →
`sendMessage(…, { triggerTurn: true })`) — the same spine `verify_phase` and
`dispatch` already use:
- **tool name + TypeBox param schema**
- **`buildPrompt(params)`** — the default prompt (caller-overridable via a `prompt` param)
- **backend opts** — `{ model, allowedTools, maxTurns }` passed to the driver
- **`interpret(result, cut)`** — result text → typed outcome (verdict / report /
  fail-safe `UNVERIFIED`)
- **`format(outcome)`** — the pushback `customType`, content, and details

Today `verify_phase` = {verify prompt, read-only tools, verdict interpreter,
`relay:verify_phase`} and `dispatch` = {passthrough} — both hand-rolled. Phase 7
extracts the shared shape.

### Actionable TODOs (literal paths — finalize when reached)
- [ ] `packages/relay/roles.ts` — a `defineRelayRole(spec)` factory that registers a
  tool over the shared substrate; refactor `verify_phase` and `dispatch` to be defined
  through it, **behavior-preserving** (Phase-1/2 gates must still pass unchanged).
- [ ] `packages/relay/drivers/claude.ts` — extend `AgentDriver.buildArgs(prompt, opts)`
  to accept `{ model, allowedTools, maxTurns }`; `claudeDriver` keeps the verifier
  defaults (D1/D2/D3) when opts are omitted.
- [ ] `packages/relay/roles/research.ts` — a second reference role: web-tool scope
  (`WebSearch WebFetch Read`), a research prompt, a report/citations interpreter,
  `relay:research` pushback. Demonstrates a role that **deliberately relaxes D1/D2**.
- [ ] `docs/relay-roles.md` — the documented "Relay Roles" pattern and a how-to-add-a-role
  guide (the reusable methodology).

### Architectural Constraints
- The refactor is **behavior-preserving** for `verify_phase`/`dispatch` — the
  registration test, `harness.mjs`, and `live-session.mjs` must all still pass.
- **D1/D2 remain the defaults** and stay in force for the **verify** role; only new
  roles opt into different tools/models via explicit opts. "Roles" is a superset that
  lives *above* the verifier's Locked Decisions, not a violation of them.
- Async spine (D4), fail-safe (D6), re-entrancy (D8), no-returned-`isError` (D9), and
  the driver seam (D10) are all preserved.

### Testing Gates (finalize when reached)
- **Gate 7.1** — `npm run check` green; `verify_phase`/`dispatch` behave **identically**
  after the refactor (unit tests unchanged; `harness.mjs` still 5/5).
- **Gate 7.2** — the new reference role dispatches and relays a result through the
  **real runtime** (a `live-session.mjs`-style proof for the new role).
- **Gate 7.3** — lockfile parity (Gate 4) for any new dependency.

### Resolves
- The productization angle of **Q2** (per-role prompt-source strategy) and **Q3**
  (config knobs: per-role `model` / `allowedTools` / `maxTurns`).

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

None. If a deviation from a literal TODO or a Locked Decision is genuinely required,
create `docs/decisions/0001-<slug>.md` (MADR-lite: **Context / Decision /
Consequences**), add a row here `| 0001 | <slug> | <phase> | <status> |`, and route
the deviation to the orchestrator for human decision. Do not self-approve.

## Appendix C — Phase tick tracker (ticked only in the human-approved merge step)

- [x] Phase 0 — Logo & brand assets
- [x] Phase 1 — Scaffold + driver seam + unit-prove
- [x] Phase 2 — Live-session integration
- [ ] Phase 3 — Accuracy regression
- [ ] Phase 4 — Wire into the phase loop
- [ ] Phase 5 — Gate B
- [ ] Phase 6 — (optional) Duplex escalation
- [ ] Phase 7 — "Relay Roles" generalization (post-Phase-5)

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
