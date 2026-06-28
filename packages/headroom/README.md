<div align="center">
  <img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/headroom/preview.png" width="250" alt="@jmcombs/pi-headroom">
  <br>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-headroom"><img src="https://img.shields.io/npm/v/@jmcombs/pi-headroom.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-headroom"><img src="https://img.shields.io/npm/dm/@jmcombs/pi-headroom.svg" alt="npm downloads"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/jmcombs/pi-extensions/stargazers"><img src="https://img.shields.io/github/stars/jmcombs/pi-extensions?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/jmcombs/pi-extensions/issues"><img src="https://img.shields.io/github/issues/jmcombs/pi-extensions" alt="Open issues"></a>
  <a href="https://github.com/sponsors/jmcombs"><img src="https://img.shields.io/badge/Sponsor-30363D?style=flat&logo=GitHub-Sponsors&logoColor=EA4AAA" alt="Sponsor"></a>
</div>

# @jmcombs/pi-headroom

> Context-compression for the Pi coding agent. It compresses the whole
> conversation before each LLM call through a local [Headroom](https://www.npmjs.com/package/headroom-ai)
> proxy, recovers any elided detail on demand, and degrades to pure passthrough
> whenever the proxy is unreachable.

> **Status:** scaffold (Phase 1). This release wires up the proxy client and
> status/auth commands. Whole-conversation compression and the
> `headroom_retrieve` recovery tool land in later phases.

## Requirement: the Headroom Python proxy

The npm `headroom-ai` package is a thin HTTP client; the compression engine is
a **local Python proxy that you run and manage yourself**. The extension never
starts, stops, or installs it — it only health-checks it. Install once into a
virtualenv:

```bash
python3 -m venv ~/.headroom-venv
~/.headroom-venv/bin/pip install "headroom-ai[proxy]"
```

Then run the proxy (default `http://127.0.0.1:8787`):

```bash
~/.headroom-venv/bin/headroom proxy --port 8787
```

Confirm it is healthy:

```bash
curl -s http://127.0.0.1:8787/health   # → {"status":"healthy",...}
```

If the proxy is **not** running, the extension stays fully usable: it emits a
single non-fatal notice at session start and runs in passthrough mode.

## Quick Start

1. Install:

   ```bash
   pi install @jmcombs/pi-headroom
   ```

2. (Optional) Try without installing:

   ```bash
   pi -e ./packages/headroom
   ```

See the [Pi packages documentation](https://pi.dev/docs/packages) for git, local
path, project-scoped install, and filtering options.

## What It Adds

- **Command**: `/headroom-status` — reports whether the proxy is reachable and,
  when healthy, its version.
- **Command**: `/headroom-authenticate` — securely stores a proxy API key (the
  input is captured by the TUI and never enters the LLM's context).
- **Event**: `session_start` — a one-time, non-fatal notice when the proxy is
  unreachable so you know compression is in passthrough mode.

## Configuration

The proxy endpoint and optional API key are resolved in this order:

1. An explicit argument passed to the client (used internally).
2. `AuthStorage` under the `headroom` key (`~/.pi/agent/auth.json`).
3. The `HEADROOM_BASE_URL` / `HEADROOM_API_KEY` environment variables.
4. Default base URL `http://127.0.0.1:8787`.

A local proxy typically needs **no** API key. Configure one only if you front
the proxy with authentication.

#### Environment variables

```bash
export HEADROOM_BASE_URL="http://127.0.0.1:8787"
export HEADROOM_API_KEY="…"   # only if your proxy requires it
```

#### `~/.pi/agent/auth.json`

```json
{
  "headroom": {
    "type": "api_key",
    "key": "HEADROOM_API_KEY",
    "env": { "HEADROOM_BASE_URL": "http://127.0.0.1:8787" }
  }
}
```

The extension reads the key with:

```ts
import { AuthStorage } from "@earendil-works/pi-coding-agent";
const auth = AuthStorage.create();
const apiKey = (await auth.getApiKey("headroom")) ?? process.env.HEADROOM_API_KEY;
```

## Requirements

- Pi `>= 0.1.0`
- Node `>= 22.0.0`
- A running Headroom Python proxy (see above).

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).
See `CONTRIBUTING.md` at the repo root for project conventions.

```bash
# From the repo root
npm ci
npm run check       # full quality gate
npm run test        # this package's smoke test
```

To try local changes against a real Pi session:

```bash
pi -e ./packages/headroom
```

## License

[MIT](./LICENSE) © Jeremy Combs
