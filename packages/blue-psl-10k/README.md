<div align="center">
  <img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/blue-psl-10k/preview.png" width="250" alt="pi-blue-psl-10k">
  <br>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-blue-psl-10k"><img src="https://img.shields.io/npm/v/@jmcombs/pi-blue-psl-10k.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-blue-psl-10k"><img src="https://img.shields.io/npm/dm/@jmcombs/pi-blue-psl-10k.svg" alt="npm downloads"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/jmcombs/pi-extensions/stargazers"><img src="https://img.shields.io/github/stars/jmcombs/pi-extensions?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/jmcombs/pi-extensions/issues"><img src="https://img.shields.io/github/issues/jmcombs/pi-extensions" alt="Open issues"></a>
  <a href="https://github.com/sponsors/jmcombs"><img src="https://img.shields.io/badge/Sponsor-30363D?style=flat&logo=GitHub-Sponsors&logoColor=EA4AAA" alt="Sponsor"></a>
</div>

# @jmcombs/pi-blue-psl-10k

Replaces Pi's default footer with a two-line Powerline status bar and bundles the matching **Blue PSL 10K** color theme.

## Quick Start

```bash
pi install @jmcombs/pi-blue-psl-10k
```

Then apply the theme:

```
/theme blue-psl-10k
```

## Status Bar Layout

The footer renders two lines pinned to the bottom of the terminal.

![Footer screenshot](https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/blue-psl-10k/footer-screenshot.png)

**Line 1** — left: path and git status; right: cost, thinking level, model

| Segment | What it shows |
| ------- | ------------- |
| Path | Truncated CWD (`…/parent/leaf`) |
| Git | Branch name with OMP-style dirty indicators (`+` staged, `!` unstaged, `?` untracked) and ahead/behind counts (`↓2/↑1`) — background color: green (clean), yellow (dirty), sky (ahead only), red (diverged) |
| Cost | Accumulated session cost — hidden when $0 (local/free models) |
| Thinking | Active thinking level (`min` `low` `med` `high` `max`) — hidden when off; color-coded muted → blue → teal → sky → mauve |
| Model | Active model ID |

**Line 2** — right-aligned: token I/O, cache efficiency, context fill

| Segment | What it shows |
| ------- | ------------- |
| Tokens | `↓` read (input + cache-read) and `↑` write (output + cache-write) counts — hidden at session start |
| Cache | Cache hit rate — works for Anthropic server-side prompt cache and llama.cpp KV cache; hidden when 0% |
| Context | Context window fill — green (<50%) → yellow (≥50%) → orange (≥80%) → red (≥90%) |

Line 2 is omitted entirely before the first model response.

## Theme

The bundled **Blue PSL 10K** theme is a [Catppuccin Latte](https://github.com/catppuccin/catppuccin)-inspired palette with Path Blue accents. After installing, select it in Pi:

```
/theme blue-psl-10k
```

The theme also sets a warm peach tint on user message backgrounds to distinguish your input from model responses.

## Commands

| Command | Description |
| ------- | ----------- |
| `/blue-psl-restore-footer` | Remove the Powerline footer and restore Pi's default |

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).

```bash
# From the repo root
npm ci
npm run check
```

To test changes locally against a real Pi session:

```bash
pi -e ./packages/blue-psl-10k
```

## License

[MIT](./LICENSE) © Jeremy Combs
