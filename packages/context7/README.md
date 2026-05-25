<div align="center">
  <img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/context7/preview.png" width="250" alt="Context7 for Pi">
  <br>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-context7"><img src="https://img.shields.io/npm/v/@jmcombs/pi-context7.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-context7"><img src="https://img.shields.io/npm/dm/@jmcombs/pi-context7.svg" alt="npm downloads"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/jmcombs/pi-extensions/stargazers"><img src="https://img.shields.io/github/stars/jmcombs/pi-extensions?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/jmcombs/pi-extensions/issues"><img src="https://img.shields.io/github/issues/jmcombs/pi-extensions" alt="Open issues"></a>
  <a href="https://github.com/sponsors/jmcombs"><img src="https://img.shields.io/badge/Sponsor-30363D?style=flat&logo=GitHub-Sponsors&logoColor=EA4AAA" alt="Sponsor"></a>
</div>

# @jmcombs/pi-context7

Real-time documentation for the Pi coding agent via [Context7](https://context7.com). Gives the agent access to up-to-date, version-aware docs and code examples without polluting context with outdated information.

## Quick Start

Get better library documentation in your agent in under a minute.

1. Install the extension:

   ```bash
   pi install @jmcombs/pi-context7
   ```

2. Configure your Context7 API key:

   ```
   /context7_onboard
   ```

   The command opens a clean, bordered prompt where you can securely enter your key. You can choose to save it permanently or use it only for the current session.

After setup, just ask the agent for documentation normally:

- "How do I set up Row Level Security in Supabase?"
- "Show me how to use server actions in Next.js 15"
- "What's the current recommended way to do authentication in tRPC?"

The agent will automatically use the Context7 tools to fetch fresh, high-quality documentation and code snippets.

## How It Works

This extension registers two tools:

- `context7_search` — Finds the correct Context7 library ID for a programming language, framework, or library.
- `context7_get_docs` — Retrieves detailed, version-specific documentation and real code examples for that library.

The tools support two authentication modes:

- **Persisted keys** — Saved via `/context7_onboard` into `~/.pi/agent/auth.json` (supports plain keys and `!op read` references).
- **Runtime-only keys** — Entered ad-hoc when a tool is called and kept only for the current session (also supports `!op read` references).

This design lets you use Context7 without ever leaking keys into the LLM context.

## /context7_onboard

Run this command to securely configure your Context7 API key:

```
/context7_onboard
```

It supports:

- Entering keys directly or via `!op read` references
- Overwriting an existing key (with confirmation)
- Choosing between permanent storage and runtime-only for the current session

The command never exposes the actual key to the model.

## After Setup

Just talk to the agent naturally. It will use Context7 automatically when it needs current documentation for a library.

Examples of good prompts:

- "Find the Context7 library for Prisma and show me how to do relations"
- "What's the recommended way to handle file uploads in Supabase right now?"
- "Give me examples of using the new React 19 use() hook"

## Checking Status

If you ever need to update or rotate your key, just run `/context7_onboard` again. It will detect the existing key and offer to overwrite it.

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).

```bash
# From the repo root
npm ci
npm run check
npm run test -- --run packages/context7
```

To test changes locally:

```bash
pi -e ./packages/context7
```
