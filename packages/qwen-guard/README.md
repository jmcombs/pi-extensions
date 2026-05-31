<div align="center">
  <img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/qwen-guard/preview.png" width="250" alt="pi-qwen-guard">
  <br>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-qwen-guard"><img src="https://img.shields.io/npm/v/@jmcombs/pi-qwen-guard.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-qwen-guard"><img src="https://img.shields.io/npm/dm/@jmcombs/pi-qwen-guard.svg" alt="npm downloads"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/jmcombs/pi-extensions/stargazers"><img src="https://img.shields.io/github/stars/jmcombs/pi-extensions?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/jmcombs/pi-extensions/issues"><img src="https://img.shields.io/github/issues/jmcombs/pi-extensions" alt="Open issues"></a>
  <a href="https://github.com/sponsors/jmcombs"><img src="https://img.shields.io/badge/Sponsor-30363D?style=flat&logo=GitHub-Sponsors&logoColor=EA4AAA" alt="Sponsor"></a>
</div>

# @jmcombs/pi-qwen-guard

Automatically detects Qwen 3.6 (or any Qwen model via Ollama) and injects strict incremental-mode rules to prevent "error: terminated" and "Stream ended without finish_reason".

Just install and forget — works on every session.

## Quick Start

```bash
pi install @jmcombs/pi-qwen-guard
```

The guard activates silently the moment you start a session with any Qwen model. No commands, no configuration, no secrets.

## How It Works

On `session_start`:

- Inspects `ctx.model.id`.
- If it contains "qwen", sets an internal flag and shows a one-time success notification:
  > 🛡️ pi-qwen-guard: Qwen3.6 incremental mode enabled

On every `before_agent_start` (i.e. before each agent turn):

- When the flag is set, appends a block of strict incremental-mode instructions to the system prompt.

The injected rules (abridged):

> CRITICAL QWEN3.6 / OLLAMA INCREMENTAL MODE (enforced every turn):
>
> - Never output more than ~70–80 lines of code in any single response.
> - Prefer the edit tool over write for any file that already exists.
> - Work in small logical chunks.
> - After completing a chunk, emit a progress signal that starts with exactly:
>   `🛡️ pi-qwen-guard: ✅ Chunk complete. File is now X lines.`
> - You may then continue directly to the next chunk (no need to wait for user approval).

This forces the model to stay within Ollama's streaming limits and eliminates the two fatal errors.

The guard is a no-op for all non-Qwen models.

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).

```bash
# From the repo root
npm ci
npm run check
```

To try local changes against a real Pi session:

```bash
pi -e ./packages/qwen-guard
```

## License

[MIT](./LICENSE) © Jeremy Combs
