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

The enhancer looks at your project tree, git status, and any files the draft
names, then **rewrites the request** instead of answering it. The original
stays one keystroke away.

## Install

```bash
pi install npm:@jmcombs/pi-prompt-enhancer
```

See the [Pi packages documentation](https://pi.dev/docs/packages) for git, local
path, project-scoped install, and filtering options.

No extra API keys. It uses the model already active in your session, or one
you pick with `/prompt_enhance_model`.

## Quick start

1. Type a rough request.
2. Press `Ctrl+Shift+E`.
3. Read the rewrite — nothing has been sent.
4. Press Enter to send, or `Ctrl+Shift+Z` for the original.

## Commands

| Command | What it does |
| --- | --- |
| `/prompt_enhance [text]` | Rewrite the text you pass, or whatever is already in the editor. |
| `/prompt_enhance_model` | Pick the enhancer model for this session. Resets when Pi restarts. |
| `/prompt_enhance_revert` | Put the pre-enhance text back. Once only; also clears when you send a prompt. |
| `/prompt_enhance_auto` | Turn auto-enhance on or off for this session. Off until you do. |

**Shortcuts** — also listed in `/hotkeys`:

- `Ctrl+Shift+E` — enhance what is in the editor. Always works, even when auto-enhance would skip.
- `Ctrl+Shift+Z` — revert the last enhance.

After an enhance, the footer reminds you how to revert. With auto-enhance on it
also says `Enter to send`. Press **Esc** to cancel an enhance that is still
running.

## The status bar

A line above the editor shows the enhancer model, whether auto-enhance is on,
and a short status after you enhance or revert.

A [Nerd Font](https://www.nerdfonts.com/) is required for the mark and
separators to render. Set `PROMPT_ENHANCER_GLYPH=""` to drop the mark.

<div align="center">
  <img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/prompt-enhancer/status-states.svg" width="820" alt="Prompt Enhancer status widget states">
</div>

- **Ready** — a model is resolved. Enhance with `Ctrl+Shift+E`.
- **Auto on** — `/prompt_enhance_auto` is armed. Enter rewrites; Enter again sends.
- **No model** — pick one with `/model` or `/prompt_enhance_model`.
- **Review** — a rewrite is in the editor and has not been sent. `Ctrl+Shift+Z` restores the original.

## Auto-enhance on Enter

Off by default. `/prompt_enhance_auto` toggles it for this session. A green
`auto` block on the status bar means it is on.

When it is on, the first Enter rewrites the draft into the editor; the next
Enter sends it.

Auto-enhance leaves empty drafts, tiny replies with no file path, and short
answers to a question alone. `Ctrl+Shift+E` always rewrites.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROMPT_ENHANCER_GLYPH` | `` | The status bar's mark. `""` drops it; any other value replaces it. |

## Requirements

| | |
| --- | --- |
| **Node** | ≥ 22.19.0 |
| **[Pi](https://pi.dev)** | any recent version |
| **A [Nerd Font](https://www.nerdfonts.com)** | for the status bar mark and separators |
| **A configured model** | at least one Pi model with an API key |

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).
See `CONTRIBUTING.md` at the repo root for project conventions.

```bash
# From the repo root
npm ci
npm run check
npm run test -- packages/prompt-enhancer

# Try local changes (skip globally installed extensions so they do not collide)
pi --no-extensions -e ./packages/prompt-enhancer
```

## License

[MIT](./LICENSE) © Jeremy Combs
