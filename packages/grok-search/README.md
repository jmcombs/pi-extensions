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

## Install

```bash
# Globally (recommended)
pi install npm:@jmcombs/pi-grok-search

# For a single session, without installing
pi -e npm:@jmcombs/pi-grok-search
```

An xAI API key is required. [Sign up at x.ai](https://x.ai) to get one, then configure it using one of the methods below.

## What It Adds

- **Tool**: `grok_search` — performs a web search using the xAI Grok Agent Tools API to get real-time information from the internet. The tool is callable by the LLM whenever it needs current information from the public web.

## Configuration

You must configure an xAI API key. Pi resolves the key in this order:

1. `AuthStorage` under the `xai_search` key (preferred when using a dedicated key) or `xai` key (reuses your existing xAI model provider key) — **recommended**.
2. The `XAI_API_KEY` environment variable.

### Option 1 — `~/.pi/agent/auth.json` (recommended)

#### Plain key (dedicated)

```json
{
  "xai_search": {
    "type": "api_key",
    "key": "xai-..."
  }
}
```

#### Reuse existing xAI key (from model provider)

```json
{
  "xai": {
    "type": "api_key",
    "key": "xai-..."
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

#### Shell-resolved key (1Password)

```json
{
  "xai_search": {
    "type": "api_key",
    "key": "!op read 'op://Personal/xai_search/credential'"
  }
}
```

The `!`-prefixed value is executed by your shell at lookup time, so no secret is
ever stored on disk in plaintext.

### Option 2 — environment variable

```bash
export XAI_API_KEY="xai-..."
```

## Behavior Notes

- Uses the current xAI Responses + Agent Tools API (`web_search` tool).
- The tool honors Pi's abort signal — pressing **Esc** during a search cancels the
  HTTP request.
- If the API key is missing the tool returns an error result with a helpful
  configuration hint instead of throwing.
- Non-2xx responses from xAI surface as tool errors (with status, status text,
  and response body) rather than throwing.
- Running `/grok_authenticate` allows you to choose between reusing your existing `xai` key or storing a dedicated key under `xai_search`.

## Requirements

- Pi `>= 0.72.0` (uses `AuthStorage` and `ExtensionAPI`)
- Node `>= 22.0.0`
- An xAI API key

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).

```bash
# From the repo root
npm ci
npm run check       # full quality gate

# Try local changes against a real pi session
pi -e ./packages/grok-search
```

The smoke test in `index.test.ts` does **not** mock the xAI API; it only
verifies registration shape. Real end-to-end behavior is exercised via `pi -e`.

## License

[MIT](./LICENSE) © Jeremy Combs
