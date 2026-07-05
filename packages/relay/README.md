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
> `model`. Relay registers a pi **provider** (`relay-claude`); a subagent whose
> `model` is `relay-claude/opus` routes through relay to a headless **Claude Opus**
> via `claude -p`, which runs its own tool loop and returns the final result.

> **Not affiliated with or endorsed by Anthropic. Claude and Opus are trademarks
> of Anthropic, PBC.**

## How It Works

A **relay role** is an existing pi-subagent (its persona `.md` + referenced
`SKILL.md`s). Nothing about the subagent changes except the processor:

- **Trigger + model** — set a subagent's `model` to `relay-claude/opus`. pi's
  native `resolveModel` routes the completion to relay's registered provider →
  `claudeDriver` → `claude -p … --model opus`.
- **Persona + skills** — when pi runs a subagent it assembles the persona body +
  a skill injection into the (child) session's system prompt, where skills are
  `<available_skills>` **references** (name/description/location). Relay reads each
  referenced `SKILL.md` and **inlines its full content** into the prompt it writes
  to `claude`'s `--system-prompt-file`, so the methodology is guaranteed present
  (deterministic — our code writes the file; no model re-echo, no drift).
- **Tools** — the driver maps the subagent's pi tools to `claude`'s
  `--allowedTools` (`read → Read`, `bash → Bash`, `edit → Edit`, `write → Write`,
  `grep → Grep`, `find → Glob`); pi-only tools with no external equivalent (e.g.
  `subagent`, `ls`) are dropped. The map is a **driver** function (D10).
- **Single-turn** — the relayed subagent has no pi-side tools; the external agent
  runs its **own** tool loop. One provider completion = one full `claude -p` run
  returning the final assistant text. pi's native subagent-async layer delivers
  the result.

The flagship consumer is phase **verification**: the `verifier` subagent runs as a
relayed subagent (`model: relay-claude/opus`, read-only tools) — no bespoke tool,
no inline prompt.

## Backend

The verify backend is **Claude Opus only**, reached through the subscription
`claude -p` CLI (billed to your Claude subscription via `oauthAccount` — never the
Anthropic API, never a local model). The verify role is **read-only**: `claude` is
invoked with a scoped `--allowedTools` allowlist and **never** with
`--dangerously-skip-permissions`. On a cut run (wall-cap or abort) relay surfaces
an **UNVERIFIED** error result — it **never** auto-passes.

A driver/adapter seam (`AgentDriver` in `drivers/claude.ts`) keeps the provider
backend-agnostic. `claudeDriver` is the live implementation and owns the
pi→Claude tool-name map (D10); `drivers/codex.ts` is a documented seam-only stub
(`codex exec`, `-s read-only`) for a future OpenAI Codex backend. `roles/resolver.ts`
is backend-neutral: it inlines skill references to full content
(`expandSkillReferences`) and resolves a persona+skills role from disk (used off
the pi-subagents path). The provider streams the completion through pi's own
`createAssistantMessageEventStream()` (`@earendil-works/pi-ai`).

## Requirements

- Pi (loads the extension via jiti — no build step)
- Node `>= 22.0.0`
- The [`claude`](https://claude.com/claude-code) CLI on `PATH`, authenticated via
  your Claude subscription (`oauthAccount`)

## Configuration

- `PI_RELAY_WALL_MS` — wall-cap backstop for a single relayed run, in milliseconds
  (default `600000`). On a cut run relay reports an **UNVERIFIED** error result.

## Quick Start

```bash
# Load the provider into a real Pi session
pi -e ./packages/relay

# Route a session (or subagent) through the relay provider
pi -e ./packages/relay --model relay-claude/opus "…"
```

To run an existing subagent through relay, set its `model` frontmatter to
`relay-claude/opus` and make relay discoverable in the subagent's child pi (via an
installed package or the agent's `extensions` field). See the
[Pi packages documentation](https://pi.dev/docs/packages) for install options.

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).
See `CONTRIBUTING.md` at the repo root for project conventions.

```bash
# From the repo root
npm ci
npm run check                       # full quality gate
node packages/relay/scripts/harness.mjs   # manual provider proof vs. real `claude -p`
```

## License

[MIT](./LICENSE) © Jeremy Combs
