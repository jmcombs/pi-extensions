# @jmcombs/pi-tavily-search

A [Pi coding agent](https://pi.dev) extension that adds real-time web search via the
[Tavily API](https://tavily.com).

## Install

```bash
# Globally (recommended)
pi install npm:@jmcombs/pi-tavily-search

# For a single session, without installing
pi -e npm:@jmcombs/pi-tavily-search
```

A Tavily API key is required. [Sign up at tavily.com](https://tavily.com) (free tier
available) to get one, then configure it using one of the methods below.

## What It Adds

- **Tool**: `tavily_search` — performs an advanced Tavily web search and returns up to
  five formatted results (title, URL, content) plus the raw API response under
  `details.raw`. The tool is callable by the LLM whenever it needs current
  information from the public web.

## Configuration

You must configure a Tavily API key. Pi resolves the key in this order:

1. `AuthStorage` under the `tavily` key (`~/.pi/agent/auth.json`) — **recommended**.
2. The `TAVILY_API_KEY` environment variable.

### Option 1 — `~/.pi/agent/auth.json` (recommended)

#### Plain key

```json
{
  "tavily": {
    "type": "api_key",
    "key": "tvly-..."
  }
}
```

#### Shell-resolved key (macOS Keychain)

```json
{
  "tavily": {
    "type": "api_key",
    "key": "!security find-generic-password -ws tavily"
  }
}
```

#### Shell-resolved key (1Password)

```json
{
  "tavily": {
    "type": "api_key",
    "key": "!op read 'op://Personal/tavily/credential'"
  }
}
```

#### Shell-resolved key (`pass`)

```json
{
  "tavily": {
    "type": "api_key",
    "key": "!pass show tavily"
  }
}
```

The `!`-prefixed value is executed by your shell at lookup time, so no secret is
ever stored on disk in plaintext.

### Option 2 — environment variable

```bash
export TAVILY_API_KEY="tvly-..."
```

## Behavior Notes

- Search depth: `advanced`
- Max results returned: 5
- The tool honors Pi's abort signal — pressing **Esc** during a search cancels the
  HTTP request.
- If the API key is missing the tool returns an error result with a helpful
  configuration hint instead of throwing.
- Non-2xx responses from Tavily surface as tool errors (with status, status text,
  and response body) rather than throwing.

## Requirements

- Pi `>= 0.72.0` (uses `AuthStorage` and `ExtensionAPI`)
- Node `>= 20.6.0`
- A Tavily API key

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).

```bash
# From the repo root
npm ci
npm run check       # full quality gate

# Try local changes against a real pi session
pi -e ./packages/tavily-search
```

The smoke test in `index.test.ts` does **not** mock the Tavily API; it only
verifies registration shape. Real end-to-end behavior is exercised via `pi -e`.

## License

[MIT](./LICENSE) © Jeremy Combs
