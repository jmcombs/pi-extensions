# Contributing to `@jmcombs/pi-relay` — adding a driver

`@jmcombs/pi-relay` runs a Pi subagent on an **external coding-agent CLI** through a small,
backend-agnostic seam — the **`AgentDriver`** (Locked Decision **D10**). The live implementation
is `claudeDriver` (headless Claude Opus via `claude -p`). This document is how to add a driver for
a **different** coding agent (e.g. OpenAI Codex, Gemini CLI).

For monorepo-wide conventions (the `npm run check` quality gate, Conventional Commits, releases,
Trusted Publishing), see the [repo-root `CONTRIBUTING.md`](../../CONTRIBUTING.md). This file covers
**only** the driver seam.

> **Scope note (D1).** Adding a driver lets relay dispatch *any* role to that backend. It does
> **not** make that backend a trustworthy **verifier** — the phase-verification accuracy bar is
> Claude-Opus-only until another backend is proven on the accuracy benchmark (0 false-merge). Ship a
> new driver for generic dispatch first; only route the `verifier` role to it **after** it clears the
> benchmark. Never imply multi-backend *verify* works on the strength of the seam alone.

## The `AgentDriver` interface

A driver is a plain object implementing `AgentDriver` (defined in `drivers/claude.ts`). The relay
provider owns everything backend-independent — spawn, streaming, the wall-cap backstop, and abort
handling — and is written against this interface, never against a backend CLI directly.

```ts
interface AgentDriver {
  readonly name: string;                             // stable id for logs/events, e.g. "claude"
  readonly bin: string;                              // executable to spawn, e.g. "claude"
  buildArgs(invocation: DriverInvocation): string[]; // argv for ONE headless run
  parseResult(stdout: string): DriverResult;         // pull the neutral result out of stdout
}
```

The provider hands every driver the same **backend-neutral** request and expects a **backend-neutral**
result back:

```ts
interface DriverInvocation {
  readonly task: string;                       // the final task / user message
  readonly model: string;                      // id after the slash: relay-<x>/opus → "opus"
  readonly systemPromptFile?: string;          // assembled persona + inlined skills (a file path)
  readonly systemPromptMode?: "replace" | "append";
  readonly tools?: readonly string[];          // pi-NEUTRAL names: read, bash, edit, write, grep, find
}

interface DriverResult {
  result: string;                              // the agent's final free-text output
  isError: boolean;                            // did the backend flag the run as failed?
}
```

## What each method must do

| Method | Responsibility | Must / must not |
|---|---|---|
| `buildArgs` | Turn a `DriverInvocation` into the backend's argv | Map `systemPromptFile`/`systemPromptMode` onto the backend's system-prompt mechanism; map the pi-neutral `tools` onto the backend's tool/permission model (below); request a machine-parseable output format. **Never** pass a privilege-escalating flag — `--dangerously-skip-permissions` or a backend analogue (**D2**). |
| `parseResult` | Extract `{ result, isError }` from raw stdout | Return the agent's final text as `result`. Set `isError: true` when the backend signals failure **or** stdout is unparseable/empty — the provider's fail-safe then reports **UNVERIFIED**, never PASS (**D6**). **No verdict parsing here** (no `VERDICT: PASS\|FAIL`) — that belongs to the consumer (**D10**). |

### Tool-name mapping is a per-driver function (D10)

pi tools have **neutral** names (`read`, `bash`, `edit`, `write`, `grep`, `find`). Mapping them onto a
backend is a **driver** concern, because backends express permissions differently:

- **Claude** has a per-tool allowlist → `claudeDriver` maps `read→Read, bash→Bash, edit→Edit,
  write→Write, grep→Grep, find→Glob` and passes `--allowedTools "<names>"`. pi-only tools with no
  Claude equivalent (`subagent`, `ls`) are dropped.
- **Codex** has *no* per-tool allowlist; its read-only guarantee is the **sandbox** (`-s read-only`),
  so the neutral list is advisory. See `drivers/codex.ts` for the full field-by-field mapping.

Keep the map a small `Record<string, string>` beside the driver, and drop unmapped names (preserve
order, de-duplicate) — mirror `CLAUDE_TOOL_NAME_MAP` / `mapToolNames` in `drivers/claude.ts`.

## Steps to add a driver

1. **Create `drivers/<backend>.ts`.** Implement `AgentDriver`; import the shared `DriverInvocation` /
   `DriverResult` types from `./claude.js`. Use `drivers/codex.ts` — a documented, unwired stub — as
   the field-by-field template.
2. **Map tools + express read-only (D2)** the way your backend does — allowlist, sandbox flag, etc.
   Never add a permission-bypass flag.
3. **Implement `parseResult`** — read your backend's structured output (a JSON / JSONL envelope) and
   surface its final message as `result` plus an error flag. Treat unparseable/empty stdout as
   `isError: true` (D6).
4. **Register a provider.** In `provider.ts`, add `registerRelay<Backend>Provider(pi)` that calls
   `streamViaDriver(<backend>Driver, …)`, and export it from `index.ts` alongside
   `registerRelayClaudeProvider`. A subagent then selects it with `model: relay-<backend>/<id>`.
5. **Keep verdict parsing OUT of the driver (D10).** The verify consumer owns
   `/VERDICT:\s*(PASS\|FAIL)/i` — the driver only surfaces `.result` text.
6. **Smoke-test the seam.** Assert `buildArgs` produces the expected argv (system-prompt flag, mapped
   tools, no bypass flag) and that `parseResult` handles both a real envelope and garbage stdout. Per
   repo policy, **don't mock the backend network** — test argv/parse shape, not a live call.

## Constraints every driver must honor

| # | Constraint |
|---|---|
| **D1** | The **verify** quality bar is Claude-Opus-only until another backend is benchmarked (see Scope note). |
| **D2** | Read-only by declaration: scoped tools/sandbox only; **never** `--dangerously-skip-permissions` or a backend equivalent. |
| **D6** | Fail-safe: a cut / errored / unparseable run surfaces **UNVERIFIED**, never auto-PASS. The provider enforces the wall-cap + abort; your `parseResult` must flag `isError` on bad stdout. |
| **D10** | The driver maps tools and builds argv; it does **not** interpret results. Verdict parsing stays in the consumer, and the backend tool-name map is a driver function. |

## Before you open a PR

```bash
npm ci
npm run check   # lint, format, types, tests, version-sync, security — from the repo root
```

Then follow the repo-root [`CONTRIBUTING.md`](../../CONTRIBUTING.md) for commit style (Conventional
Commits, scope `relay`) and the branch/PR flow.
