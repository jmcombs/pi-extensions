<div align="center">
  <img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/prompt-enhancer/banner.png" width="420" alt="@jmcombs/pi-prompt-enhancer">
  <br>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-prompt-enhancer"><img src="https://img.shields.io/npm/v/@jmcombs/pi-prompt-enhancer.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-prompt-enhancer"><img src="https://img.shields.io/npm/dm/@jmcombs/pi-prompt-enhancer.svg" alt="npm downloads"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/jmcombs/pi-extensions/stargazers"><img src="https://img.shields.io/github/stars/jmcombs/pi-extensions?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/jmcombs/pi-extensions/issues"><img src="https://img.shields.io/github/issues/jmcombs/pi-extensions" alt="Open issues"></a>
  <a href="https://github.com/sponsors/jmcombs"><img src="https://img.shields.io/badge/Sponsor-30363D?style=flat&logo=GitHub-Sponsors&logoColor=EA4AAA" alt="Sponsor"></a>
</div>

# @jmcombs/pi-prompt-enhancer

> Codebase-aware prompt rewriting for the [Pi coding agent](https://pi.dev).
> It turns a rough request into a precise one — then puts that rewrite back in
> the editor for you to review. Nothing is submitted until you say so.

The enhancer gathers a shallow project tree, git status, and any files your
draft mentions, then asks the configured model to **rewrite the request, not
answer it**. The original stays one keystroke away.

## Install

```bash
# Globally (recommended)
pi install npm:@jmcombs/pi-prompt-enhancer

# For a single session, without installing
pi --no-extensions -e ./packages/prompt-enhancer
```

See the [Pi packages documentation](https://pi.dev/docs/packages) for git, local
path, project-scoped install, and filtering options.

No external API keys are required. The enhancer uses whichever Pi model is
currently active in your session — or one you pick with `/prompt_enhance_model`.

## Commands

| Command | What it does |
| --- | --- |
| `/prompt_enhance [text]` | Rewrite the provided text, or the editor's current contents if no argument is given. |
| `/prompt_enhance_model` | Interactively pick which model to use as the enhancer for this session. Choice is held in memory and resets on restart. |
| `/prompt_enhance_revert` | Restore the editor to the prompt from immediately before the most recent enhance. Single-step: cleared after one revert, and also when you submit a non-command prompt. |
| `/prompt_enhance_auto` | Toggle auto-enhance on Enter. **Off by default.** When on, Enter rewrites the draft; Enter again sends it. |

**Shortcuts**

- `Ctrl+Shift+E` — enhance the editor's current contents in place.
- `Ctrl+Shift+Z` — revert the most recent enhance.

There is no shortcut for `/prompt_enhance_model` — pick the model from the
command. Both accelerators appear in `/hotkeys`.

> Pi's terminal `Ctrl+Z` is bound to `app.suspend` (it sends `SIGTSTP` and
> backgrounds Pi — resume with `fg`). The extension uses `Ctrl+Shift+Z` instead.
> `Ctrl+Shift+P` is Pi's own `app.model.cycleBackward` and is intentionally
> not used here — a colliding extension shortcut is skipped.

**Footer hint chips** — enhance is not advertised as an always-on chip. After
a successful enhance, a `Ctrl+Shift+Z to revert enhanced prompt` chip appears
and disappears once you revert or submit a new prompt. While an enhance is
in flight, the `BorderedLoader` owns cancel (**Esc**).

## The status bar

Prompt Enhancer draws a Powerline line above the editor — same family as
[Steward](../steward) and [Headroom](../headroom). Pi cannot place widgets
left/right of each other, so the bars stack as separate lines.

<div align="center">
  <img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/prompt-enhancer/status-states.svg" width="760" alt="Prompt Enhancer status widget states">
</div>

- **Ready** — a model is resolved (session default or a `/prompt_enhance_model`
  override). The blue block is `provider/id`.
- **No model** — nothing is configured. `/prompt_enhance` will refuse until you
  pick one with `/model` or `/prompt_enhance_model`.
- **Just enhanced** — a short-lived teal status after a soft event (enhanced,
  cancelled, reverted, nothing-to-enhance, model-changed). Hard errors still
  surface as Pi notifications.
- **Auto** — a green `auto` block after `/prompt_enhance_auto`. Enter rewrites
  the draft; Enter again sends. Off by default, and reset when the session
  restarts. Short replies (`ok`, `yes`, a two-word ack, or a brief answer to a
  question) skip the rewrite with **no word list** — we look at length, whether
  a path was named, and whether the last assistant turn asked a question.
  `Ctrl+Shift+E` always enhances.

> **Nerd Font required.** The widget uses Powerline separators and a two-glyph
> brand mark (`nf-cod-chevron-right` + `nf-cod-sparkle`, the caret and the
> spark). Your terminal must be using a [Nerd Font](https://www.nerdfonts.com/)
> (e.g. MesloLGS NF, FiraCode NF, JetBrainsMono NF) or the separators and icon
> will render as missing-glyph boxes. This affects **display only** — enhance,
> revert, and the picker work regardless of the font. Override the mark with
> `PROMPT_ENHANCER_GLYPH`; set it empty to drop the mark and keep the wordmark.

## How it works

When you trigger an enhancement, the extension gathers (in parallel):

1. **Project directory tree** — up to 3 levels deep, max 100 entries, skipping
   `node_modules`, `.git`, `dist`, `build`, `coverage`, and similar artifact
   directories.
2. **Git context** — current branch, `git status --short`, and the last 8 commits
   via `git log --oneline`. 3-second timeout per call; failures are silently
   ignored (works fine outside a git repo).
3. **Mentioned file contents** — filenames or paths referenced in your prompt are
   resolved relative to `cwd`, verified to exist, and read up to 100 lines each
   (capped at 3 files; unreadable files are silently skipped).

That context plus your original prompt is sent to the configured enhancer model.
The system prompt tells the model it is a **rewriter, not the solver** — it
must not answer, implement, or explain the request. While the call is in
flight, a `BorderedLoader` covers the editor; pressing **Esc** cancels at any
point and restores your original text.

On success the enhanced prompt is loaded into the editor. Press
**Ctrl+Shift+Z** (or run `/prompt_enhance_revert`) to restore your original;
the revert affordance is single-step and clears automatically once you submit
a new prompt.

## Model selection

By default the enhancer uses the same model that's currently active in your Pi
session (`ctx.model`). Run `/prompt_enhance_model` to open an interactive picker
showing every model that has a configured API key.

The picker is official Pi Pattern 1 (`SelectList` + `DynamicBorder` via
`ctx.ui.custom`, editor-replace, no overlay):

- Viewport height is 70% of `tui.terminal.rows` minus chrome, so the highlight
  stays on screen.
- Type to fuzzy-filter (same matching as `/model`). Empty query restores the
  full list; no matches show a dedicated empty state.
- Overflow uses the SelectList `(n/total)` cue.
- Esc cancels.

Your choice persists for the lifetime of the session only — restarting Pi or
starting a new session resets it back to the default.

## Behavior notes

- **Nothing is submitted to the LLM automatically.** The flow always ends with
  the enhanced prompt sitting in your editor awaiting your review.
- An empty prompt, no model, or a model with no configured API key produces a
  notification (or a soft status) and a no-op return — your editor is never
  modified.
- Cancellation (**Esc**) and errors both restore the original prompt.
- The extension makes no network calls of its own — it only invokes Pi's
  existing model interface, which means anything that works in your `pi` setup
  (local models, OpenRouter, Anthropic direct, etc.) works here.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROMPT_ENHANCER_GLYPH` | `` (`nf-cod-chevron-right` + `nf-cod-sparkle`) | The status bar's mark. `""` drops it; any other value replaces it. |

## Requirements

| | |
| --- | --- |
| **Node** | ≥ 22.19.0 |
| **[Pi](https://pi.dev)** | any recent version (Pattern 1 picker + above-editor widgets) |
| **A [Nerd Font](https://www.nerdfonts.com)** | for the status bar's mark and separators. Set `PROMPT_ENHANCER_GLYPH=""` to drop the mark if you would rather not install one. |
| **A configured model** | at least one Pi model with an API key (any provider) |

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).
See `CONTRIBUTING.md` at the repo root for project conventions.

```bash
# From the repo root
npm ci
npm run check       # full quality gate
npm run test -- packages/prompt-enhancer
```

To try local changes against a real Pi session (skip globally installed
extensions so they do not collide):

```bash
pi --no-extensions -e ./packages/prompt-enhancer
```

The committed test suite asserts registration shape, picker sizing/filtering,
and the widget's Powerline output with **no network**. Real end-to-end
behavior is exercised manually via `pi -e`.

## License

[MIT](./LICENSE) © Jeremy Combs
