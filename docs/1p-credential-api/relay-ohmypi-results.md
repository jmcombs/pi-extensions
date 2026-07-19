# relay ↔ oh-my-pi — live-dispatch results (Phase 8, narrowed per ADR 0009)

Phase 8 is narrowed to its unique, non-automatable value: a **live subscription-Opus
dispatch of `relay` under stock oh-my-pi** — the human `claude-sub` gate. The
automated "relay loads + registers its providers under stock omp" proof is
**superseded by Phase 11** (relay is one of P11's auto-discovered packages); the
current confirmation is recorded below.

## Environment

| Field | Value |
| --- | --- |
| oh-my-pi (`omp`) | `@oh-my-pi/pi-coding-agent@17.0.5` (pinned, under Bun) |
| claude CLI | `@anthropic-ai/claude-code@2.1.215` (`claude`) |
| pi (reference) | `@earendil-works/pi-coding-agent@0.80.9` |
| Isolation | op **absent**; throwaway `PI_CODING_AGENT_DIR` (never the host `~/.pi`) |
| Rig | `docker/interactive-onboarding.Dockerfile` + `docker/run-relay-ohmypi.sh` |

## Automated load + registration (confirmed — P11-covered)

Confirmed on the `pi-ext-interactive` image (stock omp, op absent):

- omp's own loader (`loadExtensions(["/app/packages/relay/index.ts"])`) loads relay
  with **`errors: []`** — relay links and loads clean under stock omp, including its
  `createAssistantMessageEventStream` import from `@earendil-works/pi-ai` (resolved
  through omp's compat shim). **No feature-detect needed.**
- Relay's factory registers providers **`["relay-claude", "relay-grok"]`** (stub
  `ExtensionAPI` capturing `registerProvider`, mirroring
  `packages/relay/index.test.ts`).
- omp launches with `--model relay-claude/opus` preselected: the status bar shows
  `⬢ Relay Claude Opus` and reaches a usable prompt.

This regression proof will be generalized into Phase 11's package-agnostic harness.

## Live-dispatch crash + fix (genuine relay break — omp-only)

The maintainer's first live dispatch under stock omp **crashed** at prompt assembly:

```
expandSkillReferences(context.systemPrompt).trim is not a function
```

**Root cause (empirical, instrumented in the rig):** `context.systemPrompt` has a
**different runtime shape on omp vs pi**:

| Runtime | `typeof context.systemPrompt` | shape |
| --- | --- | --- |
| **oh-my-pi 17.0.5** | `object` (`Array`) | **`string[]`** — sections, e.g. `["<system-conventions>…", …]` (also a `len=1` array for omp's auto-title turn) |
| **real pi 0.80.9** | `string` | a single string |

- pi's **public type** `@earendil-works/pi-ai` `Context.systemPrompt` is
  `string | undefined` — real pi (0.80.9) matches it. **omp's runtime diverges**
  (its own type widens to `string | string[] | (fn)`; it passes a `string[]`).
- **Is pi 0.80.9 also affected? NO.** Instrumented in the rig, pi passes a
  `string`; relay assembled the prompt and reached `spawn claude` (only ENOENT
  because `claude` wasn't installed in that probe) — **no crash**. The break is
  **omp-only**; relay's live dispatch on pi was never broken by this.

**Fix (minimal, Phase-8 scope, public-API-correct — `packages/relay/roles/resolver.ts`):**
- New `normalizeSystemPrompt(value: unknown): string` — `string` → as-is (pi);
  `string[]` → string sections joined with a blank line (omp; lossless, matches
  omp's own separator); `undefined`/other → `""`. Never `String(obj)` →
  `"[object Object]"`.
- `expandSkillReferences` now accepts `string | readonly string[] | undefined` and
  normalizes first, so it always returns a string. `provider.ts:190`
  (`expandSkillReferences(context.systemPrompt).trim()`) is now safe on both
  runtimes with skill-inlining fidelity preserved for the string and undefined cases.

**Verified (op absent):** relay loads clean on stock omp (`errors: []`) and real pi;
the omp `string[]` shape no longer throws — a dispatch now reaches the `claude -p`
spawn step; `npx vitest run packages/relay` → 29 passed (6 new regression tests for
the omp shape + `normalizeSystemPrompt`). The actual `claude -p` round-trip remains
the maintainer's live `claude-sub` gate below.

## Live dispatch (human `claude-sub` gate — **PASS**, maintainer-run)

The maintainer ran real turns through relay to Opus under stock omp; each turn routes
`omp -> resolveModel(relay-claude/opus) -> relay streamSimple ->
claude -p <task> --output-format json --model opus` and streams the final Opus text
back. relay passes **no** auth; `claude` authenticates via its own login. Run on the
**fixed** relay (commit normalizing omp's `string[]` `systemPrompt`).

- **Environment:** stock `omp v17.0.5`, op absent, throwaway agent dir (host `~/.pi`
  not mounted / not touched). Model preselected `relay-claude/opus` (status bar
  `⬢ Relay Claude Opus`).
- **Auth path used:** **(C) `ANTHROPIC_API_KEY`** — this proves the full
  omp → relay → `claude -p` → stream-back **dispatch mechanics** (the path that
  crashed pre-fix). It does **not** exercise the subscription `oauthAccount` path;
  the (A) `~/.claude:ro` subscription variant is left as an **optional follow-up** to
  tick that specific `claude-sub` sub-variant.
- **Dispatches performed + outcomes (verbatim):**
  1. Prompt `RELAY-OMP-OK` → Opus replied **`RELAY-OMP-ACK`**. The exact turn that
     crashed before the fix now completes and streams a reply — **no
     `expandSkillReferences … .trim is not a function`**.
  2. Prompt `In one short sentence, what model are you and what is 17 times 23?` →
     Opus replied **"I'm Claude (Opus), and 17 × 23 = 391."** — correct model
     identity and arithmetic, confirming the turn genuinely reached Opus (not a
     swallowed error).
- **Outcome — did Opus return a result under omp? PASS.** Both turns dispatched
  through relay and streamed coherent Opus replies; no crash/error banner in the
  session.
- **Any gap found under omp:** **none** — the provider streamed and returned cleanly
  under omp; the `string[]` `systemPrompt` fix is confirmed live. No follow-up issue
  needed. (Optional: the subscription-`oauthAccount` variant remains un-run.)

## Maintainer recipe (exact commands)

```bash
# Build the rig image (from the repo root):
docker build -f docker/interactive-onboarding.Dockerfile -t pi-ext-interactive:latest .

# (A) RECOMMENDED — subscription (claude-sub) gate, host ~/.claude mounted READ-ONLY
#     (exposes only the Claude login, never ~/.pi):
docker run --rm -it -v "$HOME/.claude:/root/.claude:ro" \
  pi-ext-interactive:latest bash docker/run-relay-ohmypi.sh

# (C) API-key path (lower friction; same omp/relay mechanics, not the subscription):
docker run --rm -it -e ANTHROPIC_API_KEY=sk-ant-... \
  pi-ext-interactive:latest bash docker/run-relay-ohmypi.sh

# Inside omp: press enter to skip the intro; the model is already Relay Claude Opus.
# Type a prompt (e.g. "Reply with exactly: RELAY-OMP-OK") and submit. The Opus reply
# streams back through relay. (If not active, Ctrl+P -> "Relay Claude Opus".)
```

Fallback (host, no Docker): install `omp` under Bun + the `claude` CLI, set a
throwaway `PI_CODING_AGENT_DIR` (isolates `~/.pi`) and `PI_OFFLINE=1 OMP_SKIP_SETUP=1`,
then `omp -e packages/relay/index.ts --model relay-claude/opus --no-session`. This
uses the host's existing `claude` login but keeps `~/.pi` isolated via the throwaway
agent dir; it does not need to touch the maintainer's pi config.

## Pointer

- Automated cross-platform load/registration (all shipped packages incl. relay):
  **Phase 11** (`docs/1p-credential-api/PLAN.md`) + **ADR 0009**.
- Relay design: `packages/relay/index.ts`, `packages/relay/provider.ts`,
  `packages/relay/drivers/claude.ts`.
