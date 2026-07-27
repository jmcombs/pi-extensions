# Handoff: Steward — the llama.cpp control panel for pi

## Brand

**Name:** Steward · **Tagline:** *How may we serve your models?* (the Netservant house line,
carried through) · **Mark:** a serving dome over two trays, the lower one at 55% opacity.

The name is the only thing being branded. llama.cpp is the engine and pi is the client — both
are credited in the chrome, never in the name or the icon:

| Surface | String |
|---|---|
| Window title | `Steward — llama.cpp` |
| Rail header | mark + **Steward** + status dot, engine line `llama.cpp b6122 · 127.0.0.1:8080` |
| Requests tile sub-line | `pi agent · 3 sessions` |
| Slot cards | `pi · edit-session`, `pi · inline-fim` |
| CLI | `steward status`, `steward stop`, `steward logs --model …` |
| Supervisor label | `app.netservant.steward` |
| Docs H1 | Steward — the llama.cpp control panel for pi |
| About box | `Steward 1.0` / tagline / `engine · llama.cpp b6122 (Metal)` / `serving · pi 0.9.4 — 3 sessions` |

Rules: say "Steward for llama.cpp" on first mention, then just "Steward". Never "pi Steward",
"Steward for pi", or "llama Steward" — pi is a consumer and other clients will appear in those
same slots. If the engine is ever swapped, only the engine line changes.

The mark, at 40×40 viewBox, drawn with `currentColor` so it inverts with the theme:

```svg
<path d="M8 17C8 10.9 13.4 6 20 6s12 4.9 12 11" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
<rect x="4" y="21" width="32" height="5" rx="2.5" fill="currentColor"/>
<rect x="4" y="29.6" width="32" height="5" rx="2.5" fill="currentColor" opacity="0.55"/>
```

App icon: this glyph in `--accent-fg` on an `--accent` rounded square (radius ≈ 24% of the
tile). Inverse variants: glyph `--surface-page` on `--text-primary`, or glyph `--accent` on
`--surface-raised`. Never hardcode hex — the tile sets `color` and the glyph uses
`currentColor`.

## Overview

A single-page operator dashboard for one local `llama-server` instance that serves several
models to the `pi` coding agent. It answers four questions at a glance and lets the operator
act on all of them without a terminal:

1. Is the service up, and for how long?
2. Which models are resident, which are hot, what are they costing in VRAM?
3. Is the box healthy (VRAM / GPU / RAM / CPU + temperatures)?
4. What is the server actually doing right now — streamed logs, filterable per model.

Controls: start / stop / restart the service, load / unload individual models, pause the log
stream, copy or download the visible log.

## About the design files

The files in this bundle are **design references created in HTML** — a working prototype of the
intended look and behavior, not production code to lift. Recreate it in the target codebase's
environment (React, Svelte, SwiftUI, a Go+htmx admin, whatever the project already uses) with
that project's established patterns and component library. If no environment exists yet, pick
the framework that fits the deployment (this is a localhost operator tool — a small React or
Svelte SPA served by the supervisor process is a natural fit) and implement there.

The prototype's data is **simulated**. Every value shown is generated locally on timers. The
real implementation must replace that with the endpoints listed under *Data layer*.

## Fidelity

**High fidelity.** Colors, type, spacing, and interaction states are final and come from the
Netservant design system (Catppuccin-Latte-derived palette, Path Blue accent). Recreate the UI
faithfully, substituting the codebase's own components where equivalents exist. Dark mode is
part of the design, not an extra.

---

## Screen: Dashboard (single page, no navigation)

Full-viewport, two-column CSS grid: `grid-template-columns: 340px 1fr;`
`grid-template-rows: minmax(0, 1fr); height: 100vh; overflow: hidden;`
Both columns get `min-height: 0` so they scroll internally rather than growing the page.
Design target 1280px wide and up; below ~1100px the rail should collapse to a top bar.

### Left rail (340px, `--surface-panel`, 1px right border, `overflow-y: auto`)

Four stacked blocks, each separated by a 1px `--border` divider.

**1. Service block** — padding `20px 20px 18px`
- Lockup row: 20px Steward mark in `--accent`, "Steward" in `--font-heading` 17px/800
  `--text-primary`, then a 9px status dot (`--success` running / `--error` stopped).
- Engine line `--font-mono` 11.5px `--text-muted`: `llama.cpp b6122 · 127.0.0.1:8080`.
- Button row, 8px gap: primary Start/Stop (flex 1, 36px tall), "Restart" (36px, secondary),
  theme toggle (36×36, glyph ☾ / ☀).
  - Running → button reads "Stop service", `background: color-mix(in srgb, var(--error) 14%, transparent)`, text `--error`.
  - Stopped → "Start service", `background: var(--accent)`, text `--accent-fg`.
- Footer row `--font-mono` 11.5px `--text-tertiary`: state left ("running"), "uptime 3h 34m" right.

**2. Host block** — eyebrow "HOST" (mono 10.5px, uppercase, 0.09em tracking, `--text-muted`).
Six gauge rows, 12px gap. Each row: label + value on one line (mono 11.5px; value bold in the
gauge color), then a 6px `--surface-raised` track with a rounded fill, `transition: width 400ms var(--ease-out)`.

| Gauge | Value format | Color | Bar scale |
|---|---|---|---|
| VRAM | `29.8 / 48 GB` | `--latte-teal` | used / total |
| GPU | `78%` | `--latte-mauve` | utilization |
| GPU temp | `64°C` | threshold (below) | 30–95 °C mapped to 0–100% |
| RAM | `52 / 128 GB` | `--accent` | used / total |
| CPU | `17%` | `--latte-peach` | utilization |
| CPU temp | `47°C` | threshold (below) | 30–95 °C mapped to 0–100% |

Temperature thresholds: `≤75°C --success`, `>75 --warning`, `>85 --error`.

**3. Models block** — eyebrow "MODELS" with an "all logs" pill on the right (active when no
model filter is set). One card per model, 8px gap, padding `12px 13px`, `--radius-md`:
- Color dot (7px) + model short name, mono 12px/700, ellipsis on overflow.
- Meta line, mono 11px `--text-muted`: `Q4_K_M · 18.4 GB · ctx 65536 · 48 gpu layers`.
- Footer: status + rate (`active · 63 t/s` / `resident · idle` / `unloaded · —`) and a
  Load/Unload button (26px). Unload = outline in `--error`; Load = solid `--accent`.
- **Clicking the card body filters the log to that model** (click again to clear). Selected
  card: `background: color-mix(in srgb, <modelColor> 10%, transparent)`, border at 50% of the
  model color. The Load/Unload button must `stopPropagation`.

Model color assignments (used consistently in cards, log rows, slots, filter pill):

| Model | Role | Color token |
|---|---|---|
| `qwen3.6-moe-a3b-instruct-q4_k_m` | chat | `--latte-mauve` |
| `qwen3.6-moe-30b-thinking-q5_k_m` | reason | `--latte-teal` |
| `qwen3.6-moe-coder-fim-q4_k_m` | fim | `--latte-peach` |
| `nomic-embed-text-v1.5-f16` | embed | `--latte-blue` |

**4. Config block** — eyebrow "CONFIG", then key/value rows (mono 11.5px, key `--text-muted`
left, value `--text-secondary` right-aligned): binary, listen, parallel slots, ctx per slot,
n_gpu_layers, flash attn, kv cache, router, supervisor. Read-only; sourced from `/props` plus
the launch arguments.

### Main column

**A. Metrics band** — `grid-template-columns: repeat(3, 1fr) 1.4fr;` with 1px `--border` gaps,
each cell `--surface-page`, padding `16px 20px`.

Three KPI tiles, each: eyebrow (mono 11px uppercase), big value (mono 26px/700 in the tile
color) + unit (12px `--text-tertiary`), 4px progress bar, sub-line (12px `--text-tertiary`).

| Tile | Value | Unit | Sub | Color | Bar |
|---|---|---|---|---|---|
| service | uptime `3h 34m`, or `stopped` | uptime | `pid 4821 · port 8080` | `--success` / `--error` | 100% / 0% |
| requests | `14` | req/min | `pi agent · 3 sessions` | `--accent` | value / 30 |
| throughput | `72` | tok/s | `generation, all slots` | `--latte-mauve` | value / 120 |

Fourth cell — **Throughput history**: header row with eyebrow "THROUGHPUT HISTORY" and
`avg 61 · peak 98 tok/s` on the right; a 46px bar chart of the last 42 samples (2 min, one
sample per ~3 s) with 2px gaps; a dashed `--border-strong` average line positioned at the
average's height; the newest bar is solid `--accent`, older bars
`color-mix(in srgb, var(--accent) 38%, transparent)`; axis row "−2 min" / "now" (mono 10.5px
`--text-subtle`).

**B. Console toolbar** — `--surface-chrome`, padding `12px 18px`, 10px gap, wraps.
Order: "filter" label · active-model pill (tinted in the model's color) · level chips
(`all levels`, `INFO`, `WARN`, `ERROR`) · search input (flex 1, min-width 140px, mono 12px,
placeholder "search log…") · "N lines" count · Pause/Resume · Copy · Download.
Chip active state: `background: color-mix(in srgb, <color> 18%, transparent)`,
`color: <color>`, `border: color-mix(in srgb, <color> 45%, transparent)`. Inactive: page
surface, `--text-tertiary`, `--border`. Pause active uses `--warning`.

**C. Log console** — `flex: 1; min-height: 0; overflow-y: auto;` on `--surface-chrome`,
10px vertical padding. Each line is a grid `92px 54px minmax(0, 200px) minmax(0, 1fr)` with 12px gaps, mono 12px,
line-height 1.6, padding `3px 18px`:
`HH:MM:SS.mmm` (`--text-subtle`) · level (bold, `--info` / `--warning` / `--error`) ·
model short name (in the model color when showing all models, `--text-muted` when already
filtered to one) · message (`--text-secondary`, `white-space: pre-wrap`).
Autoscrolls to the bottom on each append unless paused.

**D. Slots strip** (grid `repeat(4, minmax(0, 1fr))`, cards `min-width: 0` so long model
names ellipsize instead of forcing the page wide) — bottom of the main column, `--surface-page`, top border. Eyebrow "SLOTS"
with "2 of 4 processing" on the right, then a 4-up grid of cards (padding `9px 11px`,
`--radius-md`, 1px border): `slot 0` + state pill (processing → `--success` at 16% tint; idle →
`--surface-raised` / `--text-tertiary`), model short name in the model color, and
`pi · edit-session · 12.4k · 268 tok`. Free slots render "free" in `--text-subtle`.

---

## Interactions & behavior

- **Start / Stop service** — toggles service state. Stopped: status dot and service KPI go
  `--error`, KPI values fall to 0/`stopped`, all slots read idle, the log stops appending.
  Wire to the supervisor; show an in-flight state on the button and reflect the real
  `/health` result rather than optimistic state.
- **Restart** — restarts and resets uptime.
- **Load / Unload model** — per-model. Unloaded: card status "unloaded", rate "—", its slots
  go idle, and it stops producing log lines. Expect this to be slow (tens of seconds for a
  20 GB model) — the real build needs a pending state and failure handling.
- **Model filter** — click a model card (or its dot) to scope the log; click again, or the
  "all logs" pill, to clear. The active model pill in the toolbar mirrors the selection.
- **Level filter** — single-select across all/INFO/WARN/ERROR.
- **Search** — case-insensitive substring match on the message text only, applied on top of
  the model and level filters.
- **Pause/Resume** — freezes the visible buffer (snapshot at the moment of pause) and stops
  autoscroll; the underlying stream keeps collecting. Resume returns to live.
- **Copy / Download** — act on the *currently filtered* lines, formatted
  `HH:MM:SS.mmm LEVEL model message`, one per line. Download filename `llama-server.log`.
  Copy shows "Copied" for 1.4 s.
- **Theme toggle** — sets/removes `data-theme="dark"` on `<html>`; every token flips. Persist
  the choice.
- **Motion** — bar widths transition `400ms var(--ease-out)`. No other animation.

### Control states (required on every button, chip, pill, card and the search input)

Transitions run at `var(--dur-fast)` (120ms) `var(--ease-out)`; card shadows at
`var(--dur-base)` (180ms).

| Control | Hover | Press | Focus |
|---|---|---|---|
| Neutral buttons (Restart, theme, Copy, Download) | `background: var(--surface-raised)`, `border-color: var(--border-strong)` | `transform: translateY(0.5px) scale(0.99)` | `box-shadow: var(--ring)` |
| Filled / tinted buttons (Start-Stop, Load-Unload) | darken one step (`filter: brightness(0.94)`; in a component library use the DS Button's hover color map) | same nudge | `var(--ring)` |
| Chips & pills (levels, "all logs", Pause) | `filter: brightness(0.95)`, `border-color: var(--border-strong)` | same nudge | `var(--ring)` |
| Model cards | `box-shadow: var(--shadow-md)` | `transform: translateY(0.5px)` | `var(--ring)` |
| Search input | `border-color: var(--border-strong)` | — | `border-color: var(--border-active)`, `box-shadow: var(--ring)` |

`--ring` is `0 0 0 3px color-mix(in srgb, var(--psl-path-blue) 35%, transparent)` — always Path
Blue, never the browser default outline. If the codebase already wraps the design system's
`Button` component, use it instead of hand-rolling these: it implements the same hover map,
`translateY(0.5px) scale(0.99)` press, and ring focus, with sizes sm 28 / md 34 / lg 42px.
Destructive controls (Stop service, Unload) keep `--error` as their text/border color in every
state.

## State

| State | Type | Source / trigger |
|---|---|---|
| `running` | boolean | `/health` poll; start/stop actions |
| `startedAt` | timestamp | service start; drives uptime, ticked once per second |
| `models[]` | id, short, role, quant, sizeGB, ctx, gpuLayers, loaded | `/v1/models` + `/props` |
| `slots[]` | id, model, client, ctxUsed, tokens, state | `/slots` poll (~1.5 s) |
| `metrics` | tps, reqPerMin, vram, ram, cpu, gpu, gpuTemp, cpuTemp | `/metrics` + host sensors |
| `spark[42]` | rolling tok/s samples | one push per metrics tick |
| `log[]` | ts, level, model, msg — capped ring buffer (default 500) | log stream |
| `filterModel` / `filterLevel` / `query` | string | toolbar + model cards |
| `paused` / `frozen[]` | boolean / snapshot | Pause button |
| `theme` | 'light' \| 'dark' | toggle, persisted |

## Data layer

The prototype funnels everything through one adapter object at the top of the logic class —
mirror that structure so mock and live sources are swappable.

```
GET  {base}/health                          service up?
GET  {base}/v1/models                       loaded models
GET  {base}/props                           ctx, n_gpu_layers, build info
GET  {base}/slots                           per-slot state  (needs --slots)
GET  {base}/metrics                         prometheus text (needs --metrics)
GET  {base}/logs/stream                     SSE log tail, or tail the launchd/systemd unit
POST {supervisor}/service/{start|stop|restart}
POST {supervisor}/models/{id}/{load|unload}
```

Notes for the implementer:
- llama.cpp has no log-streaming endpoint of its own. Either run it under a supervisor that
  tails stdout and re-publishes it as SSE/WebSocket, or read the log file with a tail follower.
  The dashboard expects structured lines; if you only have raw text, parse level and model
  out of it (llama.cpp prefixes slot lines with `slot <fn>: id N | task N |`) and attach the
  model by resolving the slot → model mapping from `/slots`.
- Model attribution is the reason multi-model filtering exists. If the deployment uses one
  `llama-server` per model behind a router instead of one multi-model server, keep the same UI
  and make each "model" a process — start/stop then maps to per-process supervision.
- Temperatures are not available from llama.cpp; read them from the host
  (`powermetrics` / `iStats` on macOS, `nvidia-smi` or `lm-sensors` on Linux). Hide the two
  temperature gauges if the platform can't supply them, rather than showing zeros.
- Poll intervals used in the prototype: metrics 1.6 s, uptime clock 1 s, logs pushed as they
  arrive. Cap the log buffer client-side.

## Design tokens

From the Netservant design system (`_ds/.../tokens/colors.css` in this bundle). Light values
shown; dark mode is a Catppuccin Mocha ramp with a lightened Path Blue.

**Surfaces** `--surface-page #eff1f5` · `--surface-panel #e6e9ef` · `--surface-chrome #dce0e8` ·
`--surface-raised #ccd0da`
**Text** `--text-primary #4c4f69` · `--text-secondary #5c5f77` · `--text-tertiary #6c6f85` ·
`--text-muted #8c8fa1` · `--text-subtle #9ca0b0`
**Borders** `--border #ccd0da` · `--border-strong #9ca0b0`
**Accent** `--accent #3465a4` (Path Blue) · `--accent-hover #2855a3` · `--accent-fg #eff1f5`
**Status** `--success #40a02b` · `--warning #df8e1d` · `--error #d20f39` · `--info #179299`
**Model palette** `--latte-mauve #8839ef` · `--latte-teal #179299` · `--latte-peach #fe640b` ·
`--latte-blue #1e66f5`

**Type** — UI/headings **Manrope**; all numerals, log text, labels, and metadata
**JetBrains Mono**. Sizes in use: 26 (KPI value), 16 (rail title), 12–13 (body/controls),
11–11.5 (meta), 10.5 (eyebrows, uppercase, 0.09em tracking).

**Spacing** 4px base. Rail blocks `18–20px` padding; metric cells `16px 20px`; console rows
`3px 18px`. Gaps 6/8/10/12px.

**Radius** `--radius-md` 6px (buttons, inputs, cards) · `--radius-lg` 10px (outer shell) ·
999px pills. **Shadows** `--shadow-sm` / `--shadow-md`, cool and low-opacity.
**Motion** 120–300ms `ease-out`; bar fills 400ms.

## Assets

None. No images or icon fonts — the only glyphs are the theme toggle's ☾ / ☀ and the "−"
in the chart axis. Fonts load from Google Fonts (Manrope, JetBrains Mono, Instrument Serif).
If the target codebase already has an icon set, swapping the theme glyphs for icons is fine.

## Files in this bundle

- `Llama Dashboard Console Rail.dc.html` — the locked design (this spec's subject).
- `Dashboard Naming.dc.html` — naming exploration; Steward (2a) is the locked outcome.
- `Llama Dashboard.dc.html` — the earlier exploration with both layout options (1a "command
  deck", 1b "console-first rail"). Reference only; 1b is the chosen one.
- `support.js`, `_ds/` — runtime and design-system tokens so the HTML opens locally.
  Serve the folder over HTTP (`python3 -m http.server`) rather than opening via `file://`.
