<div align="center">
  <img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/steward/preview.png" width="250" alt="@jmcombs/pi-steward">
  <br>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-steward"><img src="https://img.shields.io/npm/v/@jmcombs/pi-steward.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-steward"><img src="https://img.shields.io/npm/dm/@jmcombs/pi-steward.svg" alt="npm downloads"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/jmcombs/pi-extensions/stargazers"><img src="https://img.shields.io/github/stars/jmcombs/pi-extensions?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/jmcombs/pi-extensions/issues"><img src="https://img.shields.io/github/issues/jmcombs/pi-extensions" alt="Open issues"></a>
  <a href="https://github.com/sponsors/jmcombs"><img src="https://img.shields.io/badge/Sponsor-30363D?style=flat&logo=GitHub-Sponsors&logoColor=EA4AAA" alt="Sponsor"></a>
</div>

# @jmcombs/pi-steward

> **Steward — the llama.cpp control panel for Pi.** *How may we serve your models?*

Steward is a single-page operator dashboard for the local `llama-server` that backs
[Pi's llama.cpp provider](https://pi.dev/docs/latest/llama-cpp). It answers four questions at a
glance, and lets you act on all of them without a terminal:

1. Is the service up, and for how long?
2. Which models are resident, which are hot, and what are they costing in VRAM?
3. Is the box healthy — VRAM, GPU, RAM, CPU, temperatures?
4. What is the server actually doing right now — streamed logs, filterable per model.

llama.cpp is the engine and Pi is the client; both are credited in the chrome, never in the
name. Say "Steward for llama.cpp" on first mention, then just "Steward".

> **Status: live where it counts, simulated where it doesn't yet.** Set
> `STEWARD_SOURCE=llama` and the config, service, models, slots and throughput panels read a
> real `llama-server` (`/props`, `/models`, `/slots`, `/metrics`), with real load/unload; the
> host-metrics band, the requests tile, and the log console are still generated locally. Left
> unset (the default) the whole dashboard is simulated, so it needs nothing running. The live
> reader plugs into the same seam the simulation uses (`core/source.ts`), so the interface you
> see now is the interface you will get, and the remaining panels move to live over time.

## Quick Start

1. Install:

   ```bash
   pi install npm:@jmcombs/pi-steward
   ```

2. (Optional) Try without installing:

   ```bash
   pi -e ./packages/steward
   ```

See the [Pi packages documentation](https://pi.dev/docs/packages) for git, local path,
project-scoped install, and filtering options.

## What It Adds

- **Command**: `/steward` — starts the dashboard server for the session and opens it in your
  browser. Running it again reuses the server already listening.
- **Command**: `/steward-stop` — shuts the dashboard server down. It also stops on its own when
  the session ends.

The dashboard is served on loopback only, and nothing it shows leaves the machine.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `STEWARD_PORT` | `8788` | Port the dashboard binds on loopback. `0` picks a free one. |
| `STEWARD_SOURCE` | `mock` | `llama` drives the live panels (config, service, models, slots, throughput) from a real `llama-server`; anything else keeps the fully simulated dashboard. |
| `LLAMA_BASE_URL` | `http://127.0.0.1:8080` | Where to read `llama-server` when running outside Pi (e.g. the dev server). Inside Pi the provider auth is used instead. |
| `LLAMA_API_KEY` | _(none)_ | Bearer key for a key-gated `llama-server`, outside Pi. |

If the preferred port is already taken — a second Pi session, say — Steward falls back to an
ephemeral port and tells you which one it landed on.

## Requirements

- Node `>= 22.13.0`
- A local `llama-server` (llama.cpp) instance in router mode (Pi's default)
- For live **throughput** and **tokens/sec**, start `llama-server` with `--metrics` — the
  Prometheus endpoint is off by default. (`--slots`, which powers the slots panel, is on by
  default.)

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
pi -e ./packages/steward
```

## License

[MIT](./LICENSE) © Jeremy Combs
