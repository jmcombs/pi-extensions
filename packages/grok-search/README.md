# @jmcombs/pi-grok-search

<div align="center">
  <img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/grok-search/preview.png" width="250" alt="Grok Search">
  <br>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-grok-search"><img src="https://img.shields.io/npm/v/@jmcombs/pi-grok-search.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-grok-search"><img src="https://img.shields.io/npm/dm/@jmcombs/pi-grok-search.svg" alt="npm downloads"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</div>

A [Pi coding agent](https://pi.dev) extension that adds real-time web search via the
[xAI Grok Agent Tools API](https://docs.x.ai/docs/guides/tools/overview).

## Breaking changes in v2.0.0

- **`AuthStorage` is gone.** Pi 0.80.8 removed the `AuthStorage` API this extension used
  to store and read its API key. Credentials now resolve through the
  [`@jmcombs/pi-1password`](https://www.npmjs.com/package/@jmcombs/pi-1password)
  **credential API**, which this package now depends on directly and **installs
  automatically** — no separate install step.
- **Availability-branched onboarding.** When the `op` CLI is installed and an account is
  configured, setup opens a 1Password **vault → item → field picker**; when `op` is
  unavailable it falls back to **masked manual key entry**.
- **Existing keys keep working.** Any `xai_search`, `xai`, or `grok` key already in
  `~/.pi/agent/auth.json` — a literal value or an `!op read` reference — resolves
  unchanged. No migration action is required.

## What's New — 1Password credential integration

Grok search now handles your xAI API key through the
[`@jmcombs/pi-1password`](https://www.npmjs.com/package/@jmcombs/pi-1password) credential
API, which installs automatically as a dependency. What this means for you:

- **Onboarding branches on 1Password availability.** If the `op` CLI is installed and an
  account is configured, `/grok_setup` opens a live **vault → item → field picker** (or
  lets you type an `op://…` reference) and stores it as a `!op read '…'` entry that
  resolves fresh on every use. If `op` is not available, it falls back to **manual
  API-key entry** and nudges you to enable the 1Password extension for vault integration.
- **Existing keys keep working.** Any `xai_search`, `xai`, or `grok` key already in
  `~/.pi/agent/auth.json` — a literal key or an `!op read` reference — continues to
  resolve unchanged. No migration action is required.
- **The key is never exposed to the model.** Entry happens entirely in the TUI, and only
  the resolved value is used to call the xAI API.
- **Enable 1Password for vault integration and startup unlock.** Install and enable the
  [`@jmcombs/pi-1password`](https://www.npmjs.com/package/@jmcombs/pi-1password) extension:
  it makes the vault picker available during onboarding and runs a one-time `op read` at
  session startup, so the biometric unlock prompt lands once.

```mermaid
flowchart TD
    A["/grok_setup"] --> B{"xAI OAuth in auth.json?"}
    B -- "Yes" --> C["Setup card: use OAuth<br/>or override with an API key"]
    C -- "Use OAuth" --> D["Persist grokSearch.credential=oauth<br/>in settings.json"]
    C -- "API key" --> E["1Password onboardSecret → grok id"]
    B -- "No" --> E
    E --> F["Persist grokSearch.credential=api_key"]
    D --> G["Each grok_search call"]
    F --> G
    G --> H{"preference"}
    H -- "oauth / unset + OAuth present" --> I["Bearer xAI OAuth access token<br/>(refresh if expired)"]
    H -- "api_key / no OAuth" --> J["xai_search ?? xai ?? grok API key"]
```

> `/grok_setup` never overwrites the shared `xai` OAuth or API-key provider entry.
> API-key onboarding writes the **`grok`** id.

## Install

```bash
# Globally (recommended)
pi install npm:@jmcombs/pi-grok-search

# For a single session, without installing
pi -e npm:@jmcombs/pi-grok-search
```

Credentials: a SuperGrok / X Premium login (`/login xai`) **or** an xAI API key.
[Sign up at x.ai](https://x.ai) if you need a key, then run `/grok_setup`.

## What It Adds

- **Tool**: `grok_search` — performs a web search using the xAI Grok Agent Tools API to
  get real-time information from the internet. The tool is callable by the LLM whenever it
  needs current information from the public web.
- **Command**: `/grok_setup` — if Pi already has xAI OAuth (SuperGrok / X Premium), shows a
  setup card so you can use it or override with an API key. Otherwise runs the
  `@jmcombs/pi-1password` onboarding flow. Input is never visible to the LLM.

## Configuration

The `grok_search` tool resolves a Bearer token on each call:

1. **Preference** in `~/.pi/agent/settings.json` (`grokSearch.credential`: `oauth` or
   `api_key`), written by `/grok_setup`. Both an OAuth login and an API key can exist at
   once; the preference picks which one to send.
2. **xAI OAuth** — Pi's `/login xai` SuperGrok / X Premium entry (`auth.json` `xai` with
   `type: "oauth"`). Used when the preference is `oauth` or unset. Expired access tokens
   are refreshed automatically.
3. **API key chain** — `resolveSecret("xai_search")`, then `resolveSecret("xai")` (API-key
   shaped only), then `resolveSecret("grok")`. Used when the preference is `api_key`, or
   when no OAuth is present.

If nothing resolves, the tool auto-runs API-key onboarding on first use. If you chose OAuth
in `/grok_setup` but the token is gone, it errors and asks you to `/login xai` or run
`/grok_setup` again — it will not silently switch to an API key.

### Option 1 — `/grok_setup` (recommended)

Run the command and follow the flow:

```
/grok_setup
```

- When the `op` CLI is available, pick your key from the live vault picker (or paste an
  `op://vault/item/field` reference); it is stored as a `!op read '…'` entry under the
  `grok` id that resolves fresh on every use.
- When `op` is not available, enter the key on a masked prompt; it is stored as a literal
  `api_key` entry under the `grok` id.

Either way the value is written to `~/.pi/agent/auth.json` (`0600`) and never shown to the
model. The `grok` id is written so your shared `xai` provider key stays untouched.

### Option 2 — edit `~/.pi/agent/auth.json` directly

The stored entry is provider-shaped. Any of these resolve (highest precedence first):

#### Dedicated key (`xai_search`)

```json
{
  "xai_search": {
    "type": "api_key",
    "key": "xai-..."
  }
}
```

#### Reuse your existing xAI provider key (`xai`)

```json
{
  "xai": {
    "type": "api_key",
    "key": "xai-..."
  }
}
```

#### Onboarding-written key (`grok`)

```json
{
  "grok": {
    "type": "api_key",
    "key": "xai-..."
  }
}
```

#### Shell-resolved key (1Password)

```json
{
  "xai_search": {
    "type": "api_key",
    "key": "!op read 'op://Personal/xai_search/credential'"
  }
}
```

#### Shell-resolved key (macOS Keychain)

```json
{
  "xai_search": {
    "type": "api_key",
    "key": "!security find-generic-password -ws xai_search"
  }
}
```

The `!`-prefixed value is executed by your shell at lookup time, so no secret is
ever stored on disk in plaintext.

## Behavior Notes

- Uses the current xAI Responses + Agent Tools API (`web_search` tool).
- The tool honors Pi's abort signal — pressing **Esc** during a search cancels the
  HTTP request.
- If no credential resolves, the tool returns a result guiding you to `/grok_setup`
  (or `/login xai` when OAuth is the selected source) instead of throwing.
- 401 / 429 / other non-2xx responses from xAI surface as tool results (with status and
  a helpful hint) rather than throwing. Recoverable errors are reported through the tool's
  `content` so the agent can guide you, never via a returned `isError` (which pi ignores).

## Requirements

- Pi `>= 0.80.8` (credentials via the `@jmcombs/pi-1password` API and `ExtensionAPI`)
- Node `>= 22.19.0`
- xAI OAuth (`/login xai` SuperGrok / X Premium) **or** an xAI API key
- Optional: the `op` (1Password) CLI for vault-backed API-key onboarding and startup unlock

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).

```bash
# From the repo root
npm ci
npm run check       # full quality gate

# Try local changes against a real pi session
pi -e ./packages/grok-search
```

Tests do **not** mock the xAI API. `index.test.ts` checks registration shape;
`auth.test.ts` / `setup.test.ts` exercise real temp `auth.json` / `settings.json`
and the setup card. Live search is still `pi -e`.

## License

[MIT](./LICENSE) © Jeremy Combs
