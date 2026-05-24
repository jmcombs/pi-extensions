<div align="center">
  <img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/1password/preview.png" width="250" alt="1Password for Pi">
  <br>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-1password"><img src="https://img.shields.io/npm/v/@jmcombs/pi-1password.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-1password"><img src="https://img.shields.io/npm/dm/@jmcombs/pi-1password.svg" alt="npm downloads"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</div>

# @jmcombs/pi-1password

1Password integration for the Pi coding agent — with a focus on **secure, transparent credential injection** so bare `gh`, `aws`, `heroku`, and other 1P-protected CLIs "just work" inside Pi without the LLM ever seeing tokens.

## The Recommended Pattern (auth.json + `!op read`)

The extension is specifically designed so you do **not** need a 1Password Service Account for normal use.

Stop fighting non-persistent shells and 1Password shell plugin limitations (biometric flows + "interactive IO not available" errors in agent tools).

1. Create a dedicated, least-privilege credential in 1Password (e.g. a fine-grained GitHub PAT).

2. Store it as a normal item in 1Password (e.g. "Agent GitHub Token" in an "Automation" vault).

3. Reference it in your existing `~/.pi/agent/auth.json` using the `!op read` syntax:

```json
{
  "anthropic": { "type": "api_key", "key": "!op read 'op://Personal/Anthropic/credential'" },
  "xai": { "type": "api_key", "key": "!op read 'op://Personal/xAI/credential'" },

  "GH_TOKEN": "!op read 'op://Automation/Agent GitHub Token/credential'",
  "GITHUB_TOKEN": "!op read 'op://Automation/Agent GitHub Token/credential'"
}
```

4. Install this extension. On every Pi start (and `/reload`), the extension:
   - Reads the top-level keys from `auth.json`
   - Securely resolves any `!op read ...` values in the privileged host process (using your normal `op` CLI + desktop app)
   - Injects the final values as real environment variables into **every** agent `bash` tool call **and** your `!` / `!!` commands via Pi's spawn hook.

Result: the agent can run `gh auth status`, `gh repo view ...`, `aws sts get-caller-identity`, etc. with **bare commands**. No shell plugin hacks or `shellCommandPrefix` required, and no tokens ever reach the LLM or terminal output.

`/1password_diagnose` will show exactly which vars are active (names only).

## What It Adds

- **Transparent injection** (the main feature): any top-level `UPPER_SNAKE_CASE` key in `~/.pi/agent/auth.json` whose value is a `!op read` (or literal) becomes a real env var for all bash executions.
- **Command**: `/1password_onboard` — Guided UI to discover supported integrations (from our CI-maintained list of 60+ tools), search your vault, pick the field, preview, and safely write the `!op read` entry (recommended way to add new CLIs).

- **Command**: `/1password_diagnose` — Gathers the full diagnostics (op status, plugin configuration for common tools, and active shell-injected variables) directly and presents a clean report. No extra prompting required. `1p_run` remains available as a tool for manual injected command execution.
- **Tool**: `1p_run` — Run commands with 1Password injection + diagnostics (used by the LLM when running `/1password_diagnose` to produce clean, well-formatted plugin inspection output).

## Security Model (Why This Is Safer for Agents)

- Resolution happens only in the privileged Pi host process (same context that already handles your LLM provider keys).
- The spawn hook injects values **only** into the child environment of the bash execution. The LLM sees only the clean command it requested (`gh ...`) and the command's stdout/stderr.
- `/1password_diagnose` (and the underlying `1p_diagnose` tool) never return secret _values_ (only names for the injection layer).

**Best practice**: Use dedicated least-privilege items or fine-grained PATs rather than your personal high-privilege credentials.

## Requirements & Setup

You need a working 1Password CLI that the Pi process can talk to:

1. **Install the 1Password desktop app** and sign in (this is required for the `op` CLI to work with biometric unlock on macOS).

2. **Install the 1Password CLI** (`op`):
   - macOS: `brew install --cask 1password-cli` (or download from 1password.com)
   - Make sure `op --version` works from your terminal.

3. **Authenticate** so `op` can read items:
   - For normal use (recommended): Just unlock the 1Password desktop app. Biometric unlock is sufficient. No service account token is required.

4. **Install this extension** (see below).

> **Note on the desktop app**: The 1Password desktop app + biometric unlock is only needed when Pi (or the extension) resolves the `!op read` references at startup or `/reload`. Once resolved, the actual secret values are injected directly into the child processes via Pi's spawn hook and never touch the LLM.

### Weekly Maintenance of Supported Tools

This extension maintains a curated list of 60+ 1Password shell plugins (AWS, GitHub, npm, Heroku, Stripe, Fly.io, etc.).

We run a GitHub Actions workflow every week that:

- Fetches the official list from https://www.1password.dev/
- Parses the reference tables in each plugin's documentation
- Updates `data/shell-plugins.json` with the latest env var mappings and primary variables
- Opens a PR for human review before merging

This keeps `/1password_onboard` up-to-date without manual maintenance.

## Usage

After adding the entries to `~/.pi/agent/auth.json`:

```bash
pi -e ./packages/1password   # during development
# or
pi install npm:@jmcombs/pi-1password
```

Then just ask the agent to use the CLIs normally:

- "Run `gh auth status` and show the output."
- "Use the terminal to view this repo: `gh repo view jmcombs/pi-extensions`"
- "Run `aws sts get-caller-identity`"

Run `/1password_diagnose` anytime to see:

- op sign-in state
- Configured plugins (gh, aws, ...)
- **Active shell env injection** (the vars coming from your auth.json)

## /1password_onboard

Type `/1password_onboard` (or just start typing `/1p`) for a guided, interactive flow that:

1. Optionally picks from the curated list of 63+ supported 1Password shell plugins (maintained weekly via CI from official docs) to get the recommended env var name (e.g. `GH_TOKEN`, `AWS_ACCESS_KEY_ID`).
2. Live-searches your 1Password vault (`op item list`) for API Credential / Login / Secure Note items.
3. Lets you pick the exact item and field.
4. Suggests / lets you edit the env var name.
5. Shows the exact JSON line that will be written.
6. Safely appends it to `~/.pi/agent/auth.json` (creates the file with 0600 permissions if needed; refuses to overwrite existing keys).
7. Offers to `/reload` immediately so the spawn hook picks it up for the current session.

After the entry is active, bare commands just work and `/1password_diagnose` will list the var name (never the value).

This is the recommended way to onboard new CLIs (gh, aws, npm, heroku, fly, stripe, etc.) without ever exposing secrets to the LLM or relying on fragile rc sourcing.

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
