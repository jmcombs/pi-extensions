<div align="center">
  <img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/relay/preview.png" width="250" alt="@jmcombs/pi-relay">
  <br>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/jmcombs/pi-extensions/stargazers"><img src="https://img.shields.io/github/stars/jmcombs/pi-extensions?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/jmcombs/pi-extensions/issues"><img src="https://img.shields.io/github/issues/jmcombs/pi-extensions" alt="Open issues"></a>
  <a href="https://github.com/sponsors/jmcombs"><img src="https://img.shields.io/badge/Sponsor-30363D?style=flat&logo=GitHub-Sponsors&logoColor=EA4AAA" alt="Sponsor"></a>
</div>

# @jmcombs/pi-relay

> **Relay roles** for the [Pi coding agent](https://pi.dev): run any Pi **subagent**
> on an **external coding agent** instead of a local model — just by setting its
> `model`. Relay registers pi **providers** (`relay-claude`, `relay-grok`); a
> subagent whose `model` is `relay-claude/opus` or `relay-grok/grok-4.5` routes
> through relay to a headless **Claude Opus** (`claude -p`) or **Grok Build**
> (`grok -p`), which runs its own tool loop and returns the final result.

> **Not affiliated with or endorsed by Anthropic or xAI. Claude and Opus are
> trademarks of Anthropic, PBC; Grok is a trademark of xAI.**

## Fixes

- **Dispatching under oh-my-pi no longer crashes.** On oh-my-pi a subagent's
  `systemPrompt` arrives as a `string[]` rather than a plain string; relay now
  normalizes it before building the backend prompt, so relay roles dispatch
  cleanly under both pi and oh-my-pi.

## How It Works

A **relay role** is an existing pi-subagent (its persona `.md` + referenced
`SKILL.md`s). Nothing about the subagent changes except the processor:

- **Trigger + model** — set a subagent's `model` to `relay-claude/opus` or
  `relay-grok/grok-4.5`. pi's native `resolveModel` routes the completion to
  relay's registered provider → `claudeDriver`/`grokDriver` → `claude -p …
  --model opus` / `grok -p … --model grok-4.5`.
- **Persona + skills** — when pi runs a subagent it assembles the persona body +
  a skill injection into the (child) session's system prompt, where skills are
  `<available_skills>` **references** (name/description/location). Relay reads each
  referenced `SKILL.md` and **inlines its full content** into the prompt it writes
  via the backend's own system-prompt mechanism (`claude`'s
  `--system-prompt-file`, or `grok`'s inline `--system-prompt-override`/`--rules`),
  so the methodology is guaranteed present (deterministic — no model re-echo, no
  drift).
- **Tools** — each driver maps the subagent's pi tools onto its backend's own
  permission model (`read → Read`, `bash → Bash`, `edit → Edit`, `write → Write`,
  `grep → Grep`, `find → Glob`); pi-only tools with no external equivalent (e.g.
  `subagent`, `ls`) are dropped. Claude gets `--allowedTools`; Grok gets one
  `--allow <Tool>` flag per tool plus `--permission-mode dontAsk` (fail-closed —
  unlisted tools are silently declined, never a hang or a blanket bypass). The map
  is a **driver** function (D10).
- **Single-turn** — the relayed subagent has no pi-side tools; the external agent
  runs its **own** tool loop. One provider completion = one full headless CLI run
  returning the final assistant text. pi's native subagent-async layer delivers
  the result.

The flagship consumer is phase **verification**: the `verifier` subagent runs as a
relayed subagent (`model: relay-claude/opus`, read-only tools) — no bespoke tool,
no inline prompt.

## Backend

The **verify** quality bar is **Claude Opus only** (D1), reached through the
subscription `claude -p` CLI (billed to your Claude subscription via
`oauthAccount` — never the Anthropic API, never a local model). The verify role
is **read-only**: `claude` is invoked with a scoped `--allowedTools` allowlist and
**never** with `--dangerously-skip-permissions`. On a cut run (wall-cap or abort)
relay surfaces an **UNVERIFIED** error result — it **never** auto-passes.

`relay-grok` (Grok Build, `grok -p`) is a second live driver available for generic
subagent dispatch — it does **not** change the verify quality bar. Per D1, a new
backend only becomes verify-eligible after it clears the accuracy benchmark; until
then, route the `verifier` role to `relay-claude/opus` and use `relay-grok` for
other subagents. Grok is invoked with `--permission-mode dontAsk` plus one
`--allow <Tool>` per allowed tool (verified fail-closed and non-interactive —
**never** `--always-approve` or `--permission-mode auto`/`bypassPermissions`).

A driver/adapter seam (`AgentDriver` in `drivers/claude.ts`) keeps the provider
backend-agnostic. `claudeDriver` and `grokDriver` are the live implementations,
each owning its own pi→backend tool-name map (D10); `drivers/codex.ts` is a
documented seam-only stub (`codex exec`, `-s read-only`) for a future OpenAI Codex
backend. `roles/resolver.ts` is backend-neutral: it inlines skill references to
full content (`expandSkillReferences`) and resolves a persona+skills role from
disk (used off the pi-subagents path). The provider streams the completion
through pi's own `createAssistantMessageEventStream()` (`@earendil-works/pi-ai`).

## Requirements

- Pi (loads the extension via jiti — no build step)
- Node `>= 22.0.0`
- The [`claude`](https://claude.com/claude-code) CLI on `PATH`, authenticated via
  your Claude subscription (`oauthAccount`), for `relay-claude`
- The `grok` (Grok Build) CLI on `PATH`, authenticated (`grok login` or
  `XAI_API_KEY`), for `relay-grok`

## Configuration

- `PI_RELAY_WALL_MS` — wall-cap backstop for a single relayed run, in milliseconds
  (default `600000`). On a cut run relay reports an **UNVERIFIED** error result.
- `PI_RELAY_HEARTBEAT_MS` — interval, in milliseconds, at which the provider pushes
  a no-op stream beat while a relayed run is in flight (default `20000`; set `0` to
  disable). A single `claude -p` completion emits nothing until it finishes, so
  without a beat pi-subagents' parent run sees "no observed activity" and falsely
  flips the child to `needs_attention` at its 60s threshold. Each beat surfaces as
  a pi `message_update`, advancing the parent's activity clock; the verdict still
  rides only on the terminal result, so the beats never affect it.

## Install

```bash
# Globally (recommended)
pi install npm:@jmcombs/pi-relay

# For a single session, without installing
pi -e npm:@jmcombs/pi-relay
```

See the [Pi packages documentation](https://pi.dev/docs/packages) for git, local
path, project-scoped install, and filtering options.

## Usage

Relay registers the `relay-claude` and `relay-grok` **providers**; you use either
by pointing a subagent (or a whole session) at it through `model`:

```bash
# Route a whole session through the relay provider
pi --model relay-claude/opus "…"
pi --model relay-grok/grok-4.5 "…"
```

To run an existing subagent through relay, set its `model` frontmatter to
`relay-claude/opus` or `relay-grok/grok-4.5` and make relay discoverable in the
subagent's child pi (an installed package, or the agent's `extensions` field). The
flagship example is the `verifier` subagent — `model: relay-claude/opus` with a
read-only tool set (D1: verify stays Claude-Opus-only).

## Extending — adding a driver

Relay is backend-agnostic through the `AgentDriver` seam (D10). `claudeDriver` and
`grokDriver` are the live implementations; `drivers/codex.ts` is a documented
seam-only stub for a future OpenAI Codex backend. To add a driver for another coding
agent (Codex, Gemini CLI, …) — the `AgentDriver` API, the pi→backend tool-name
mapping, the read-only/fail-safe constraints, and a step-by-step guide — see
[`CONTRIBUTING.md`](./CONTRIBUTING.md) in this package.

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).
See the repo-root [`CONTRIBUTING.md`](../../CONTRIBUTING.md) for project conventions, and
this package's [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the driver seam.

```bash
# From the repo root
npm ci
npm run check                       # full quality gate
node packages/relay/scripts/harness.mjs   # manual provider proof vs. real `claude -p`
node packages/relay/scripts/harness.mjs --model relay-grok/grok-4.5   # same, vs. real `grok -p`
```

## License

[MIT](./LICENSE) © Jeremy Combs
