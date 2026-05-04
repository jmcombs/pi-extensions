# @jmcombs/pi-prompt-enhancer

A [Pi coding agent](https://pi.dev) extension that rewrites rough user prompts into
precise, codebase-aware ones — before they reach the model. The enhanced prompt is
loaded back into the editor for your review, so you stay in control of what gets
submitted.

## Install

```bash
# Globally (recommended)
pi install npm:@jmcombs/pi-prompt-enhancer

# For a single session, without installing
pi -e npm:@jmcombs/pi-prompt-enhancer
```

No external API keys are required. The enhancer uses whichever Pi model is currently
active in your session (or one you pick interactively via `/enhance-model`).

## What It Adds

- **Command** `/enhance [text]` — enhance the provided text, or the editor's current
  contents if no argument is given.
- **Shortcut** `Ctrl+Shift+E` — enhance the editor's current contents in place.
- **Command** `/enhance-model` — interactively pick which model to use as the
  enhancer for the current session. Choice is held in memory and resets on restart.

## How It Works

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
While the request is in flight, a `BorderedLoader` covers the editor; pressing
**Esc** cancels at any point and restores your original text.

On success the enhanced prompt is loaded into the editor and you receive a notification
to review it before submitting. The editor's standard **Ctrl+Z** undo reverts to the
original prompt.

## Model Selection

By default the enhancer uses the same model that's currently active in your Pi
session (`ctx.model`). Run `/enhance-model` to open an interactive picker showing
every model that has a configured API key. Your choice persists for the lifetime
of the session only — restarting Pi or starting a new session resets it back to
the default.

## Behavior Notes

- **Nothing is submitted to the LLM automatically.** The flow always ends with the
  enhanced prompt sitting in your editor awaiting your review.
- An empty prompt, no model, or a model with no configured API key produces a
  notification and a no-op return — your editor is never modified.
- Cancellation (**Esc**) and errors both restore the original prompt and notify you.
- The extension makes no network calls of its own — it only invokes Pi's existing
  model interface, which means anything that works in your `pi` setup (local
  models, OpenRouter, Anthropic direct, etc.) works here.

## Requirements

- Pi `>= 0.72.0`
- Node `>= 20.6.0`
- At least one Pi-configured model with an API key (any provider)

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).

```bash
# From the repo root
npm ci
npm run check       # full quality gate

# Try local changes against a real pi session
pi -e ./packages/prompt-enhancer
```

The smoke test in `index.test.ts` does **not** mock the LLM API; it only verifies
registration shape (commands, shortcuts). Real end-to-end behavior is exercised
manually via `pi -e`.

## License

[MIT](./LICENSE) © Jeremy Combs
