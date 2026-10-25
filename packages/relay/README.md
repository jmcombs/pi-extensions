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
> `model`. Relay registers pi **providers** (`relay-claude`, `relay-grok`,
> `relay-cursor`); a subagent whose `model` is `relay-claude/opus-5-5`,
> `relay-claude/sonnet-5-5`, `relay-grok/grok-4.5`, `relay-cursor/composer-2-5`,
> `relay-cursor/opus-4-8`, `relay-cursor/opus-5-5`, or `relay-cursor/sonnet-5-5`
> routes through relay to a headless **Claude** (`claude -p`),
> **Grok Build** (`grok -p`), or **Cursor Agent** (`cursor-agent -p`), which runs its
> own tool loop and returns the final result.

> **Not affiliated with or endorsed by Anthropic, xAI, or Anysphere. Claude and
> Opus are trademarks of Anthropic, PBC; Grok is a trademark of xAI; Cursor is a
> trademark of Anysphere, Inc.**

## Fixes

- **oh-my-pi system prompts are normalized.** oh-my-pi supplies `systemPrompt` as a
  `string[]`; relay joins those sections before building the backend prompt.
- **pi 0.86+ prompts and tools are read from the transcript.** pi 0.86+ supplies the
  prompt and tools on transcript system messages, read with `getCurrentSystemPrompt`
  and `getCurrentTools`.
- **oh-my-pi tasks terminate through local `yield`.** When the host context exposes
  oh-my-pi's task-only `yield` tool, relay returns the backend text plus one
  synthetic terminal yield call. oh-my-pi therefore finalizes after one external CLI
  run instead of issuing text-only reminders and repeating the request.

## How It Works

A **relay role** is an existing pi-subagent (its persona `.md` + referenced
`SKILL.md`s). Nothing about the subagent changes except the processor:

- **Trigger + model** — set a subagent's `model` to `relay-claude/opus-4-8`,
  `relay-claude/opus-5-5`, `relay-claude/sonnet-5-5`, `relay-claude/haiku-5-5`,
  `relay-grok/grok-4.5`, `relay-cursor/composer-2-5`, `relay-cursor/opus-4-8`,
  `relay-cursor/opus-5-5`, or `relay-cursor/sonnet-5-5`. pi's native `resolveModel`
  routes the completion to relay's registered provider → `claudeDriver` /
  `grokDriver` / `cursorDriver` →
  `claude -p … --model claude-opus-4-8|claude-opus-5-5|claude-sonnet-5-5|claude-haiku-5-5 --effort <level>` /
  `grok -p … --model grok-4.5 --reasoning-effort <level>` /
  `cursor-agent -p … --model composer-2.5|claude-opus-4-8-thinking-<level>|claude-opus-5-5-<level>|claude-sonnet-5-5-<level>`
  (Pi's thinking level selects the Claude/Grok effort flag, or the listed Cursor id).
- **Persona + skills** — when pi runs a subagent it assembles the persona body +
  a skill injection into the (child) session's system prompt, where skills are
  `<available_skills>` **references** (name/description/location). Relay reads each
  referenced `SKILL.md` and **inlines its full content** into the prompt it writes
  via the backend's own system-prompt mechanism (`claude`'s
  `--system-prompt-file`, `grok`'s inline `--system-prompt-override`/`--rules`, or
  prepended onto Cursor's user prompt — Cursor has no system-prompt flag),
  so the methodology is guaranteed present (deterministic — no model re-echo, no
  drift).
- **Tools** — each driver maps the subagent's pi tools onto its backend's own
  permission model (`read → Read`, `bash → Bash`, `edit → Edit`, `write → Write`,
  `grep → Grep`, `find → Glob`); pi-only tools with no external equivalent (e.g.
  `subagent`, `ls`) are dropped. Claude gets `--permission-mode dontAsk`,
  `--permission-prompts none`, and a comma-separated `--allowedTools` rule list
  (`bash` → `Bash(*)`, not bare `Bash`). Grok gets one `--allow <Tool>` flag per
  tool plus `--permission-mode dontAsk` (fail-closed — unlisted tools are silently
  declined, never a hang or a blanket bypass). The map is a **driver** function
  (D10). Cursor has no `--allowedTools` argv flag;
  `cursorDriver` maps the same pi names onto allow/deny rules (`Read(**/*)`,
  `Shell(*)`, `Write(**/*)`), copies the user's Cursor config home into a temp dir,
  overlays those rules on `cli-config.json`, and points `CURSOR_CONFIG_DIR` at it.
  A sparse temp dir (only the generated config) hangs `cursor-agent -p` on the first
  tool call. `--force` / `--yolo` are never passed.
- **Single external run** — the relayed subagent has no external equivalent for
  pi/oh-my-pi orchestration tools. The external agent runs its own tool loop once
  and returns final text. pi consumes that text directly; oh-my-pi receives the same
  text plus a local terminal `yield` call generated by relay.

The flagship consumer is phase **verification**: the `verifier` subagent runs as a
relayed subagent (`model: relay-claude/opus-5-5`, read-only tools) — no bespoke tool,
no inline prompt.

## Backend

The **verify** quality bar is **Claude Opus only** (D1), reached through the
subscription `claude -p` CLI (billed to your Claude subscription via
`oauthAccount` — never the Anthropic API, never a local model). The verify role
is **read-only**: `claude` is invoked with scoped `--allowedTools` rules
(`Bash(*)` when bash is declared) plus `--permission-mode dontAsk` and
`--permission-prompts none`, and **never** with `--dangerously-skip-permissions`
or `bypassPermissions`. The child sets `CMUX_CLAUDE_HOOKS_DISABLED=1` so a
terminal permission hook cannot stall a headless run; the real `claude` binary
ignores that variable. On a cut run (idle-cap or abort) relay surfaces an
**UNVERIFIED** error result — it **never** auto-passes.

`relay-grok` (Grok Build, `grok -p`) is a second live driver available for generic
subagent dispatch — it does **not** change the verify quality bar. Per D1, a new
backend only becomes verify-eligible after it clears the accuracy benchmark; until
then, route the `verifier` role to `relay-claude/opus-5-5` and use `relay-grok` for
other subagents. Grok is invoked with `--permission-mode dontAsk` plus one
`--allow <Tool>` per allowed tool (verified fail-closed and non-interactive —
**never** `--always-approve` or `--permission-mode auto`/`bypassPermissions`).

`relay-cursor` (Cursor Agent, `cursor-agent -p`) is a third live driver. Cursor is
invoked with `--output-format stream-json` and `--trust` (skip the workspace-trust prompt).
`--force` / `--yolo` (Cursor's permission bypass) and `--sandbox` are **never**
passed. Pi model → Cursor `--model` map:

| Pi id | Cursor `--model` at Pi `off` | Other Pi levels |
| --- | --- | --- |
| `relay-cursor/auto` | `auto` | No thinking axis; only Pi `off` is offered |
| `relay-cursor/composer-2-5` | `composer-2.5` | No thinking axis; only Pi `off` is offered |
| `relay-cursor/opus-4-8` | `claude-opus-4-8-high` | `claude-opus-4-8-thinking-<level>` |
| `relay-cursor/opus-5-5` | `claude-opus-5-5-low` | `claude-opus-5-5-<level>` (`off` clamps to `low`) |
| `relay-cursor/sonnet-5-5` | `claude-sonnet-5-5-low` | `claude-sonnet-5-5-<level>` (`off` clamps to `low`) |

The mapper strips the `relay-cursor/` provider prefix first; an id that does not
resolve to a listed id is rejected up front rather than forwarded. Unversioned
and dotted ids (`opus`, `cursor`, `opus-4.8`, `opus-5.5`, `sonnet-5.5`) are
not accepted. Cursor has no system-prompt flag, so persona +
skills are prepended onto the user prompt. Tool scoping overlays allow/deny rules
on a **seeded** temp `CURSOR_CONFIG_DIR` (copy of the user's Cursor config home,
not a lone `cli-config.json` — that hangs headless tool calls until the wall-cap;
see #254). No-tools roles still seed that dir and fail-closed `deny` `Write(**/*)`
so Cursor cannot fall through to `~/.cursor`.

Claude Code and Cursor name the same Anthropic models differently:

| Goal | Claude Code (`claude -p`) | Cursor Agent (`cursor-agent -p`) |
| --- | --- | --- |
| Opus 4.8 | `--model claude-opus-4-8` + `--effort <level>` (omitted on Pi `off`) | `claude-opus-4-8-high` on Pi `off`, else `claude-opus-4-8-thinking-<level>` |
| Opus 5.5 | `--model claude-opus-5-5 --effort <level>` (Pi `off` → `low`) | `claude-opus-5-5-<level>` (Pi `off` → `low`) |
| Sonnet 5.5 | `--model claude-sonnet-5-5 --effort <level>` (Pi `off` → `low`) | `claude-sonnet-5-5-<level>` (Pi `off` → `low`) |
| Haiku 5.5 | `--model claude-haiku-5-5 --effort <level>` (Pi `off` → `low`) | n/a |
| Composer 2.5 | n/a | `--model composer-2.5` (thinking does not change the id) |

Confirm Cursor account availability with an authenticated `cursor-agent --list-models`
(catalog is server-driven). Claude Code 2.1.295's baked catalog lists Opus 5.5,
Sonnet 5.5, and Haiku 5.5 as 1M / 128K with `rejects_disabled_thinking`. The
first-party aliases `opus`, `sonnet`, and `haiku` resolve to those ids; relay
lists the versioned ids and pins `--model` to them.

Claude and Grok keep `--model` as the pinned id and apply Pi thinking as
`--effort` / `--reasoning-effort`. Relay catalogs these models with
`reasoning: true` so Pi's thinking UI matches what the drivers send. Levels the
backend cannot express are `null` in `thinkingLevelMap` (hidden). A session left
on a hidden level is clamped the same way Pi clamps an unsupported level.

A driver/adapter seam (`AgentDriver` in `drivers/claude.ts`) keeps the provider
backend-agnostic. `claudeDriver`, `grokDriver`, and `cursorDriver` are the live
implementations, each owning its own pi→backend tool-name map (D10);
`drivers/codex.ts` is a documented seam-only stub (`codex exec`, `-s read-only`) for
a future OpenAI Codex backend. `roles/resolver.ts` is backend-neutral: it inlines skill references to
full content (`expandSkillReferences`) and resolves a persona+skills role from
disk (used off the pi-subagents path). The provider streams the completion
through pi's own `createAssistantMessageEventStream()` (`@earendil-works/pi-ai`).

## Requirements

- Pi (loads the extension via jiti — no build step)
- Node `>= 22.19.0`
- The [`claude`](https://claude.com/claude-code) CLI on `PATH`, authenticated via
  your Claude subscription (`oauthAccount`), for `relay-claude`
- The `grok` (Grok Build) CLI on `PATH`, authenticated (`grok login` or
  `XAI_API_KEY`), for `relay-grok`
- The [`cursor-agent`](https://cursor.com/docs/cli/headless) CLI on `PATH`,
  authenticated (`cursor-agent login` or `CURSOR_API_KEY`), for `relay-cursor`

## Configuration

- `PI_RELAY_WALL_MS` — idle-cap backstop for a single relayed run, in milliseconds
  (default `600000`). Any stdout or stderr byte resets the timer; true silence still
  SIGTERMs the child. On a cut run relay reports an **UNVERIFIED** error result.
- `PI_RELAY_HEARTBEAT_MS` — fallback no-op stream beat while a backend emits nothing
  (json print mode). Stream backends forward real `text_delta` / tool-progress instead.
  Default `20000`; set `0` to disable. Each beat surfaces as a pi `message_update`,
  advancing the parent's activity clock; the verdict still rides only on the terminal
  result, so the beats never affect it.

## Install

```bash
# Globally (recommended)
pi install npm:@jmcombs/pi-relay

# For a single session, without installing
pi -e npm:@jmcombs/pi-relay

# Oh My Pi
omp plugin install @jmcombs/pi-relay
```

See the [Pi packages documentation](https://pi.dev/docs/packages) for git, local
path, project-scoped install, and filtering options.

## Usage

Relay registers the `relay-claude`, `relay-grok`, and `relay-cursor` **providers**;
you use any of them by pointing a subagent (or a whole session) at it through
`model`:

```bash
# Route a whole session through the relay provider
pi --model relay-claude/opus-4-8 "…"
pi --model relay-claude/opus-5-5 "…"
pi --model relay-claude/sonnet-5-5 "…"
pi --model relay-claude/haiku-5-5 "…"
pi --model relay-grok/grok-4.5 "…"
pi --model relay-cursor/auto "…"
pi --model relay-cursor/composer-2-5 "…"
pi --model relay-cursor/opus-4-8 "…"
pi --model relay-cursor/opus-5-5 "…"
pi --model relay-cursor/sonnet-5-5 "…"
```

To run an existing subagent through relay, set its `model` frontmatter to
`relay-claude/opus-5-5`, `relay-claude/sonnet-5-5`, `relay-claude/haiku-5-5`,
`relay-grok/grok-4.5`, `relay-cursor/composer-2-5`, `relay-cursor/opus-4-8`,
`relay-cursor/opus-5-5`, or `relay-cursor/sonnet-5-5` and make
relay discoverable in the subagent's child pi (an installed package, or the agent's
`extensions` field).

oh-my-pi discovers custom task agents from `~/.omp/agent/agents/*.md` and
`.omp/agents/*.md`. Set the agent's model normally:

```yaml
---
name: relay-reviewer
description: Review a change through Claude Code.
model: relay-claude/opus-5-5
tools: read, grep
---
```

oh-my-pi keeps `yield` local; relay never forwards it to Claude, Grok, or Cursor.

## Extending — adding a driver

Relay is backend-agnostic through the `AgentDriver` seam (D10). `claudeDriver`,
`grokDriver`, and `cursorDriver` are the live implementations; `drivers/codex.ts` is
a documented seam-only stub for a future OpenAI Codex backend. To add a driver for
another coding agent (Codex, Gemini CLI, …) — the `AgentDriver` API, the pi→backend
tool-name mapping, the read-only/fail-safe constraints, and a step-by-step guide —
see [`CONTRIBUTING.md`](./CONTRIBUTING.md) in this package.

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
node packages/relay/scripts/harness.mjs --model relay-cursor/auto     # same, vs. real `cursor-agent -p`

# Unreleased worktree only (--no-extensions -e ./packages/relay):
./packages/relay/scripts/prove-thinking-map.sh catalog   # list-models vs expected context/max/thinking
./packages/relay/scripts/prove-thinking-map.sh argv      # Pi thinking → real CLI flags (six -p runs)
```

## License

[MIT](./LICENSE) © Jeremy Combs
