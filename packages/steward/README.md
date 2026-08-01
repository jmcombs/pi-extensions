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

> **Steward — the llama.cpp control panel for [Pi](https://pi.dev).** *How may we serve your models?*

A single-page operator dashboard for the local `llama-server` behind Pi's llama.cpp provider, plus a
status bar inside Pi itself. It answers four questions at a glance, and lets you act on all of them
without leaving your editor:

1. **Is the service up**, and for how long?
2. **Which models are resident**, and what is each costing you in memory?
3. **Is the box healthy** — GPU, CPU, memory, temperature?
4. **What is the server doing right now** — slots, throughput, requests, and its live log?

Start, stop and restart the service; load and unload models; watch the log — all from the dashboard.

## Requirements

| | |
| --- | --- |
| **Node** | ≥ 22.13 |
| **[Pi](https://pi.dev)** | any recent version |
| **`llama-server`** | running in **router mode** — `--models-dir` and/or `--models-preset`, with no `-m`/`--model`/`-hf`. Pi's own llama.cpp provider requires this too. |
| **A [Nerd Font](https://www.nerdfonts.com)** | for the status bar's mark and separators. Set `STEWARD_GLYPH=""` to drop the mark if you would rather not install one. |

`/steward_initialize` checks everything else — metrics, slots, log capture, host sensors — and offers
to fix whatever is missing.

## Install

```bash
# Globally (recommended)
pi install npm:@jmcombs/pi-steward

# For a single session, without installing
pi -e ./packages/steward
```

See the [Pi packages documentation](https://pi.dev/docs/packages) for git, local path,
project-scoped install, and filtering options.

## Quick start

Start Pi, then:

```
/steward_initialize     1. connect this machine — review, approve, done
/steward_start          2. start the dashboard service
/steward_dashboard      3. open it in your browser
```

That is the whole path. Step 1 is once per machine; steps 2 and 3 are once per session — and
`/steward_dashboard` starts the service for you, so you can skip straight to it.

## Commands

| Command | What it does |
| --- | --- |
| `/steward_initialize` | Connects this machine to Steward. Works out how `llama-server` runs here, proposes the changes it needs, and writes `steward.json` — **asking before every change**. Run once per machine, or again whenever the setup moves. |
| `/steward_start` | Starts the dashboard service on `127.0.0.1:8788` for this session. Prints the URL and opens nothing — useful on a headless box, or when you only want the status bar. |
| `/steward_dashboard` | Opens the dashboard in your browser, starting the service first if it is not already running. |
| `/steward_stop` | Stops the dashboard service. It also stops on its own when the Pi session ends. |

## The status bar

Steward draws a line above the editor whenever it has something to say. It reports **Steward's own
state** first, with llama.cpp as detail:

```
󰢍 Steward   :8788   llama :8080 · 1/10     dashboard up, server up, 1 of 10 models resident
󰢍 Steward   :8788   llama: stopped         dashboard up, server down
󰢍 Steward   :8788   llama —                dashboard up, server not read yet
󰢍 Steward   stopped                        dashboard not running
󰢍 Steward   chat still on :8080 · restart pi to use :8091
```

Three colours, and only three: **green** started, **red** stopped, **orange** running but something
needs a person. That last line is the orange case — Pi is dialling a different address than the
server Steward is watching, so chat fails while the dashboard looks perfectly healthy. The bar names
which fix applies.

It refreshes while the dashboard is up and reads the same data the dashboard does, so it costs no
extra connection to your server.

## What `/steward_initialize` does

It establishes how this machine supervises services, what it can measure, and where Pi already
expects `llama.cpp` — then proposes the smallest set of changes that makes Steward work, and asks
once whether to apply them all or one at a time.

In practice that usually means enabling `--metrics`, capturing **both** stdout and stderr to one
durable file, nominating a host-metrics collector, and recording start/stop/restart commands.

Two things it will not do. It never guesses a command at runtime — everything Steward may run is
recorded with a hash you approved. And it never edits Pi's own configuration: if the server is on the
wrong port, it moves the **server**, so nothing about Pi has to be reloaded.

It shows a diff and a revert command before touching anything.

## Configuration

`/steward_initialize` writes `~/.config/steward/steward.json` at mode `0600`. Steward refuses to read
that file if it is not owned by you or is world-writable, because it is a code-execution surface.

It records the memory topology, the host-metrics collector and its cadence, the log path, the base
URL to watch, the start/stop/restart commands, the launch argv to check drift against, and a consent
hash for every command Steward may run.

Editing a recorded command by hand invalidates its hash, and Steward then declines to run it — which
shows up as a missing button rather than an error. Re-run `/steward_initialize` instead of writing
hashes yourself.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `STEWARD_CONFIG` | `~/.config/steward/steward.json` | Where the artifact lives. |
| `STEWARD_PORT` | `8788` | Dashboard port. `0` asks the OS for any free port; a port already taken costs an ephemeral one, not the dashboard. |
| `STEWARD_LOG_FILE` | — | Overrides the recorded `log.path` for the log console. |
| `STEWARD_GLYPH` | `󰢍` | The status bar's mark. `""` drops it; any other value replaces it. |

## Honesty

Steward never invents a reading. A gauge with no data renders as **no reading**, never as zero — a
real 0% and an unmeasurable value are different facts and must not be confused. A machine it cannot
see reports itself disconnected rather than showing a plausible dashboard made of nothing. Where it
cannot tell two states apart, it says so instead of picking the likelier one.

That is the whole design. A dashboard you cannot trust at a glance is worse than no dashboard.

## Development

```bash
# From the repo root
npx vitest run packages/steward     # tests
node scripts/typecheck.mjs          # types
npx biome check packages/steward    # lint and format

# Run the dashboard without Pi
npx tsx packages/steward/scripts/dev.ts
```

## License

MIT © [Jeremy Combs](https://github.com/jmcombs)
