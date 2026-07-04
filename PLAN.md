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
- [Conventional Commits](https://www.conventionalcommits.org/), scope `relay`.
  `commitlint` (`header-max-length` 100) enforced by the `commit-msg` hook. `biome`
  runs on staged files via the `pre-commit` hook.
- **The builder commits its work to `feat/relay` and STOPS.** No PR, no merge, no
  tick. **The PR is opened by the orchestrator only after verifier PASS + explicit
  human approval**, then merged in the separate human-approved merge step.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- No build artifacts committed (`.gitignore` already covers `dist/`, `coverage/`,
  `node_modules/`; jiti loads `.ts` directly — there is no build step).

---

## Phase 0 — Logo & brand assets  ✅ DONE

- Chosen: **A1 "Boxed round-trip"**. Assets committed on `feat/relay` @ `d33d7c7`
  under `assets/relay/` (`preview.{svg,png}`, `logo/relay-mark*.svg`,
  `relay-icon.svg` + `-512.png`, `relay-favicon-32.png`).

---

## Phase 1 — Scaffold `packages/relay` + driver seam + unit-prove  ← ACTIVE

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

### Definition of Done — see Appendix D.

---

## Phases 2–6 (spec finalized when reached — objectives + gates only)

- **Phase 2 — Live-session integration.** `pi -e ./packages/relay`; invoke
  `verify_phase`. Gate: verdict arrives as an async **follow-up turn**. Confirm Q1
  (`triggerTurn` immediate vs. queued-on-idle).
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
- [ ] Phase 1 — Scaffold + driver seam + unit-prove
- [ ] Phase 2 — Live-session integration
- [ ] Phase 3 — Accuracy regression
- [ ] Phase 4 — Wire into the phase loop
- [ ] Phase 5 — Gate B
- [ ] Phase 6 — (optional) Duplex escalation

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
