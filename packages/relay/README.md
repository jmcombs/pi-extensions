<div align="center">
  <img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/relay/preview.png" width="250" alt="@jmcombs/pi-relay">
  <br>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/jmcombs/pi-extensions/stargazers"><img src="https://img.shields.io/github/stars/jmcombs/pi-extensions?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/jmcombs/pi-extensions/issues"><img src="https://img.shields.io/github/issues/jmcombs/pi-extensions" alt="Open issues"></a>
  <a href="https://github.com/sponsors/jmcombs"><img src="https://img.shields.io/badge/Sponsor-30363D?style=flat&logo=GitHub-Sponsors&logoColor=EA4AAA" alt="Sponsor"></a>
</div>

# @jmcombs/pi-relay

> An async **agent-dispatch primitive** for the [Pi coding agent](https://pi.dev).
> Pi hands a task to a headless agent CLI and the result is relayed back into the
> live session **mid-turn, non-blocking**. The flagship consumer is phase
> verification (`verify_phase`); a thin generic `dispatch` tool rides the same
> substrate.

> **Not affiliated with or endorsed by Anthropic. Claude and Opus are trademarks
> of Anthropic, PBC.**

## What It Adds

- **Tool**: `verify_phase` — dispatches a **read-only** phase verification to a
  headless **Claude Opus** agent via `claude -p`, then relays the `PASS` / `FAIL`
  verdict back as a follow-up turn. Returns immediately as `PENDING`; the verdict
  arrives asynchronously. It reports the verdict and evidence **only** — it never
  merges, ticks, or edits anything. Parameters: `phase` (required), `cwd`
  (optional, defaults to the session cwd), `prompt` (optional prompt override).
- **Tool**: `dispatch` — a generic escape hatch over the same async substrate:
  hand an arbitrary `prompt` to a headless Claude Opus agent and relay its result
  back as a follow-up turn. Parameters: `prompt` (required), `cwd` (optional).

## Backend

The verification backend is **Claude Opus only**, reached through the subscription
`claude -p` CLI (billed to your Claude subscription via `oauthAccount` — never the
Anthropic API, never a local model). Dispatches are **read-only**: the underlying
agent is invoked with scoped tools (`Bash Read Grep Glob`) and **never** with
`--dangerously-skip-permissions`.

A driver/adapter seam (`AgentDriver`, sole implementation `claudeDriver` in
`drivers/claude.ts`) keeps the async core backend-agnostic; verdict interpretation
lives in the `verify_phase` consumer, not the driver.

## Requirements

- Pi (loads the extension via jiti — no build step)
- Node `>= 22.0.0`
- The [`claude`](https://claude.com/claude-code) CLI on `PATH`, authenticated via
  your Claude subscription (`oauthAccount`)

## Configuration

- `PI_RELAY_WALL_MS` — wall-cap backstop for a single dispatch, in milliseconds
  (default `600000`). On a cut run (wall-cap or abort) the relay reports
  `UNVERIFIED` — it **never** auto-passes.

## Live-session behavior

Both tools are **non-blocking**: `execute()` returns `PENDING` immediately and the
verdict/result arrives **later** as a follow-up turn. When does that follow-up
land?

- **Agent idle** (the usual case — you asked for a verify and are waiting): the
  pushback is delivered via `sendMessage(…, { triggerTurn: true })` and pi starts
  a **fresh turn immediately** the moment the dispatched `claude -p` run finishes.
  There is no polling and no idle checkpoint to wait for.
- **Agent busy** (still streaming another turn when the result arrives): the
  pushback is queued as a **steer** and delivered right after the current
  assistant turn finishes executing its tool calls, before the next LLM call.

Either way the verdict is guaranteed to land as its own turn — verified against a
real `pi --mode rpc` session (see `scripts/live-session.mjs`). Because idle
delivery is immediate, the relay needs no separate idle-flush queue.

## Quick Start

```bash
# Try it against a real Pi session without installing
pi -e ./packages/relay
```

See the [Pi packages documentation](https://pi.dev/docs/packages) for git, local
path, project-scoped install, and filtering options.

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).
See `CONTRIBUTING.md` at the repo root for project conventions.

```bash
# From the repo root
npm ci
npm run check                            # full quality gate
node packages/relay/scripts/harness.mjs       # manual async proof vs. real `claude -p`
node packages/relay/scripts/live-session.mjs  # live-session proof vs. real `pi --mode rpc`
```

## License

[MIT](./LICENSE) © Jeremy Combs
