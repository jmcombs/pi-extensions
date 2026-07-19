<div align="center">
  <img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/1password/preview.png" width="250" alt="1Password for Pi">
  <br>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-1password"><img src="https://img.shields.io/npm/v/@jmcombs/pi-1password.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-1password"><img src="https://img.shields.io/npm/dm/@jmcombs/pi-1password.svg" alt="npm downloads"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/jmcombs/pi-extensions/stargazers"><img src="https://img.shields.io/github/stars/jmcombs/pi-extensions?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/jmcombs/pi-extensions/issues"><img src="https://img.shields.io/github/issues/jmcombs/pi-extensions" alt="Open issues"></a>
  <a href="https://github.com/sponsors/jmcombs"><img src="https://img.shields.io/badge/Sponsor-30363D?style=flat&logo=GitHub-Sponsors&logoColor=EA4AAA" alt="Sponsor"></a>
</div>

# @jmcombs/pi-1password

1Password integration for the Pi coding agent — with a focus on **secure, transparent credential injection** so bare `gh`, `aws`, `heroku`, and other 1P-protected CLIs "just work" inside Pi without the LLM ever seeing tokens.

## Breaking changes in v2.0.0

- **`AuthStorage` is gone.** Pi 0.80.8 removed the `AuthStorage` API this extension was built on. Credentials now resolve through a stateless **credential API** that this package exports for other extensions to consume; onboarding writes `!op read '…'` entries to `~/.pi/agent/auth.json` that resolve fresh on every use.
- **Availability-branched onboarding.** When the `op` CLI is installed and an account is configured, setup opens the 1Password **vault → item → field picker**; when `op` is unavailable it falls back to **masked manual entry**.
- **The `1p_run` tool has been retired.** Transparent credential injection into bare CLIs (`gh`, `aws`, …) is unchanged — it runs through the bash spawn-hook / `user_bash` env injection, so a dedicated run tool is no longer needed.
- **Existing entries keep working.** Any `!op read` entry already in `~/.pi/agent/auth.json` resolves unchanged. No migration action is required.

## Quick Start

Get transparent credential injection in under a minute:

1. Make sure you have the **1Password CLI** (`op`) installed and signed in (the desktop app + biometric unlock is recommended on macOS).

2. Install the extension:

   ```bash
   pi install npm:@jmcombs/pi-1password
   ```

3. In any Pi chat, type:
   ```
   /1password_setup
   ```

The command opens a beautiful guided interface (with live filtering and consistent styling) that lets you:

- Pick from 60+ popular tools (gh, aws, npm, heroku, Stripe, Fly.io, …)
- Search your 1Password vaults and pick the exact item + field
- Safely write a `!op read …` entry to `~/.pi/agent/auth.json`

After that, just use the CLIs normally inside Pi — the secrets are injected automatically at the host level.

Run `/1password_diagnose` anytime to see which variables are currently active.

## How It Works

This extension works by storing **references** (never the raw secrets) in `~/.pi/agent/auth.json` using the `!op read` syntax.

The easiest way to create these entries is with the guided `/1password_setup` command shown above.

You can also manage entries manually if you prefer:

```json
{
  "GH_TOKEN": "!op read 'op://Automation/Agent GitHub Token/credential'",
  "AWS_ACCESS_KEY_ID": "!op read 'op://Automation/AWS/credential'"
}
```

On every Pi start (and `/reload`), the extension:

- Reads the top-level keys from `auth.json`
- Securely resolves any `!op read ...` values in the privileged host process (using your normal `op` CLI + desktop app)
- Injects the final values as real environment variables into **every** agent `bash` tool call **and** your `!` / `!!` commands via Pi's spawn hook.

Result: the agent can run `gh auth status`, `gh repo view ...`, `aws sts get-caller-identity`, etc. with **bare commands**. No shell plugin hacks or `shellCommandPrefix` required, and no tokens ever reach the LLM or terminal output.

`/1password_diagnose` will show exactly which vars are active (names only).

## /1password_setup

Run this command for a polished, guided setup experience:

```
/1password_setup
```

It provides a filterable, bordered interface that walks you through:

- Choosing from a curated list of 60+ popular 1Password shell plugins (maintained weekly via CI)
- Searching your vaults for the right item
- Selecting the exact field
- Reviewing the exact line that will be written to `auth.json`
- Optional immediate `/reload`

The command creates `~/.pi/agent/auth.json` with proper `0600` permissions if needed and never overwrites existing keys without confirmation.

## After Setup

Once you have entries in `auth.json`, just ask the agent to use the tools normally:

- "Run `gh auth status` and show the output."
- "Use the terminal to view this repo: `gh repo view jmcombs/pi-extensions`"
- "Run `aws sts get-caller-identity`"

The injection happens transparently via Pi’s spawn hook.

## Checking Status

Run `/1password_diagnose` at any time to see:

- Your `op` sign-in state
- Detected shell plugins
- Currently active injected environment variables (names only)

## Security Model

- All secret resolution happens in the privileged Pi host process.
- Values are only injected into the child environment of bash executions.
- The LLM never sees the actual secret values — only the clean commands it requested.
- `/1password_diagnose` (and the underlying tools) never return secret values, only variable names.

**Best practice**: Use dedicated, least-privilege items or fine-grained PATs rather than personal high-privilege credentials.

## Requirements & Setup

You need a working 1Password CLI that Pi can talk to:

1. **Install the 1Password desktop app** and sign in (required for biometric unlock on macOS).
2. **Install the 1Password CLI** (`op`):
   - macOS: `brew install --cask 1password-cli`
   - Verify with `op --version`
3. **Install this extension** (see Quick Start).

> The desktop app is only needed when Pi resolves the `!op read` references. The actual secret values are injected directly into child processes and never touch the LLM.

### Weekly Maintenance of Supported Tools

This extension maintains a curated list of 60+ 1Password shell plugins. A weekly GitHub Actions workflow fetches the latest data from 1password.dev, updates `data/shell-plugins.json`, and opens a PR for review. This keeps `/1password_setup` current without manual maintenance.

## Development / Local Testing

```bash
# From repo root
npm run check

# Load in a real Pi session (no install needed)
pi -e ./packages/1password
```

The smoke test only verifies registration (no external `op` calls are mocked).

## License

[MIT](./LICENSE) © Jeremy Combs
