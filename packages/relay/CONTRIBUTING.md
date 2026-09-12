# Contributing to `@jmcombs/pi-relay` — adding a driver

`@jmcombs/pi-relay` runs a Pi subagent on an **external coding-agent CLI** through a small,
backend-agnostic seam — the **`AgentDriver`** (Locked Decision **D10**). The live implementations
are `claudeDriver` (headless Claude Opus via `claude -p`), `grokDriver` (headless Grok Build via
`grok -p`), and `cursorDriver` (headless Cursor Agent via `cursor-agent -p`). This document is how
to add a driver for a **different** coding agent (e.g. OpenAI Codex, Gemini CLI).

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
  env?(invocation: DriverInvocation): Readonly<Record<string, string>>; // optional extra spawn env
}
```

The provider hands every driver the same **backend-neutral** request and expects a **backend-neutral**
result back:

```ts
interface DriverInvocation {
  readonly task: string;                       // the final task / user message
  readonly model: string;                      // id after the slash: relay-<x>/opus → "opus"
  readonly thinking?: PiThinkingLevel;         // Pi thinking (`off`…`max`); drivers also parse `:<level>` on model
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
| `buildArgs` | Turn a `DriverInvocation` into the backend's argv | Map `systemPromptFile`/`systemPromptMode` onto the backend's system-prompt mechanism; map Pi thinking onto the backend (`--effort`, `--reasoning-effort`, or a listed `--model` id); map the pi-neutral `tools` onto the backend's tool/permission model (below); request a machine-parseable output format. **Never** pass a privilege-escalating flag — `--dangerously-skip-permissions` or a backend analogue (**D2**). |
| `parseResult` | Extract `{ result, isError }` from raw stdout | Return the agent's final text as `result`. Set `isError: true` when the backend signals failure **or** stdout is unparseable/empty — the provider's fail-safe then reports **UNVERIFIED**, never PASS (**D6**). **No verdict parsing here** (no `VERDICT: PASS\|FAIL`) — that belongs to the consumer (**D10**). |

### Tool-name mapping is a per-driver function (D10)

pi tools have **neutral** names (`read`, `bash`, `edit`, `write`, `grep`, `find`). Mapping them onto a
backend is a **driver** concern, because backends express permissions differently:

- **Claude** has a per-tool allowlist → `claudeDriver` maps `read→Read, bash→Bash, edit→Edit,
  write→Write, grep→Grep, find→Glob` and passes `--allowedTools "<names>"`. pi-only tools with no
  Claude equivalent (`subagent`, `ls`) are dropped.
- **Codex** has *no* per-tool allowlist; its read-only guarantee is the **sandbox** (`-s read-only`),
  so the neutral list is advisory. See `drivers/codex.ts` for the full field-by-field mapping.
- **Grok Build** uses the *same* capitalized tool names as Claude, but through permission **rule**
  flags rather than a tool-set flag: `grokDriver` passes `--permission-mode dontAsk` (fail-closed —
  confirmed via direct testing that an unlisted tool is silently declined, never a hang or an
  auto-approve) plus one `--allow <Tool>` per mapped tool — **not** a single space-joined value,
  which was confirmed to silently fail. Do **not** reach for `--tools`/`--disallowed-tools`: passing
  either reproducibly breaks session creation in the tested CLI version, independent of the value
  given. Never use `--permission-mode auto`/`bypassPermissions` or `--always-approve` — confirmed to
  auto-approve every tool call with no allowlist, the Grok analogue of
  `--dangerously-skip-permissions`.
- **Cursor Agent** has no `--allowedTools` argv flag. `--force` / `--yolo` is the bypass analogue
  of `--dangerously-skip-permissions` and must **never** be passed; `--sandbox` is also never
  passed (D12). `--trust` is passed so headless runs do not hang on the workspace-trust prompt
  (not a tool bypass). `cursorDriver` maps `read`/`grep`/`find` → `Read(**/*)`, `bash` → `Shell(*)`,
  `edit`/`write` → `Write(**/*)`. `env()` copies the user's Cursor config home (top-level files)
  into a temp dir, overlays those rules on `cli-config.json`, and points `CURSOR_CONFIG_DIR` at
  it — a temp dir that contains only the generated config hangs `cursor-agent -p` on the first
  tool call (wall-cap UNVERIFIED). When the role declared no tools, `env()` is a no-op. Read-only
  roles also `deny` `Write(**/*)`. Cursor has no system-prompt flag; persona+skills are prepended
  to the user prompt.

Keep the map a small `Record` beside the driver, and drop unmapped names (preserve order,
de-duplicate) — mirror `CLAUDE_TOOL_NAME_MAP` / `mapToolNames` in `drivers/claude.ts` (or
`GROK_TOOL_NAME_MAP` in `drivers/grok.ts`, `CURSOR_TOOL_PERMISSION_MAP` in `drivers/cursor.ts`).

## Steps to add a driver

1. **Create `drivers/<backend>.ts`.** Implement `AgentDriver`; import the shared `DriverInvocation` /
   `DriverResult` types from `./claude.js`. Use `drivers/codex.ts` (a documented, unwired stub) or
   `drivers/grok.ts` / `drivers/cursor.ts` (live, wired-in implementations) as the field-by-field
   template — those are the better reference if your backend's permission model turns out to differ
   from its `--help` text once you actually run it.
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

`npm run check` does **not** hit live CLIs. After catalog or thinking/driver argv changes, also
prove the unreleased worktree (never `npm:@jmcombs/pi-relay`) against real backends:

```bash
# Catalog only (no backend spend) — context / max-out / thinking must match this tree
./packages/relay/scripts/prove-thinking-map.sh catalog

# Live argv: Pi thinking → Claude --effort, Grok --reasoning-effort, Cursor listed --model ids
# Needs authenticated claude, grok, and cursor-agent on PATH. Skips cmux shims.
./packages/relay/scripts/prove-thinking-map.sh argv
```

`catalog` is cheap and should stay green. `argv` spends six one-shot `-p` runs; re-check a previous
log with `./packages/relay/scripts/prove-thinking-map.sh assert` (no backends).

Then follow the repo-root [`CONTRIBUTING.md`](../../CONTRIBUTING.md) for commit style (Conventional
Commits, scope `relay`) and the branch/PR flow.
