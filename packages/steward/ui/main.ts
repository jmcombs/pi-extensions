/**
 * Bootstrap for the Steward dashboard.
 *
 * This module is the only place in the browser that touches the network or the
 * clock: it polls `/api/snapshot`, holds the log stream open, dispatches
 * actions at the reducer, and hands the resulting view model to the components.
 * Nothing here derives a displayed value — that all lives in `core/select.ts`.
 */

import { selectDashboard, selectLogText } from "../core/select.js";
import type { LevelFilter, Theme, UiAction, UiState } from "../core/state.js";
import { initialUiState, reduce } from "../core/state.js";
import type { LogLine, ModelAction, ServiceAction, Snapshot } from "../core/types.js";
import { createLogConsole } from "./components/console.js";
import { createHostBlock } from "./components/gauges.js";
import { createMetricsBand } from "./components/metrics.js";
import { createModelsBlock } from "./components/models.js";
import { createServiceBlock } from "./components/service.js";
import { createSlotsStrip } from "./components/slots.js";
import { createSparkline } from "./components/sparkline.js";
import { createToolbar } from "./components/toolbar.js";

/** Matches the server's metrics cadence. */
const SNAPSHOT_INTERVAL_MS = 1600;

/** The uptime readouts tick between polls. */
const CLOCK_INTERVAL_MS = 1000;

/** How long the Copy button acknowledges for. */
const COPY_FEEDBACK_MS = 1400;

/** Backoff before re-opening a dropped log stream. */
const RECONNECT_DELAY_MS = 2000;

const THEME_KEY = "steward.theme";

const rail = document.getElementById("steward-rail");
const main = document.getElementById("steward-main");
const status = document.getElementById("steward-status");
if (rail === null || main === null) throw new Error("Steward: the page shell is missing.");

let ui: UiState = initialUiState(readTheme());
let snapshot: Snapshot | null = null;
let snapshotAt = 0;
let copyTimer = 0;

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** The stored mode, defaulting to `system` when unset or unrecognized. */
function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light" || stored === "system") return stored;
  } catch {
    // Storage refused (private mode): fall through to the default.
  }
  return "system";
}

/** True when the OS currently asks for a dark palette. */
function prefersDark(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  } catch {
    return false;
  }
}

/**
 * Applies a mode by resolving it to the light/dark palette. `system` follows the
 * OS; the CSS contract is unchanged — `data-theme="dark"` present means dark, its
 * absence means light — so `system` simply computes which to set. The persisted
 * value is the *mode*, not the resolved palette, so `system` survives a reload.
 */
function applyTheme(theme: Theme): void {
  const dark = theme === "dark" || (theme === "system" && prefersDark());
  if (dark) document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage is optional; the choice simply will not survive a reload.
  }
}

function announce(message: string): void {
  if (status !== null) status.textContent = message;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const serviceBlock = createServiceBlock({
  onToggleTheme: () => {
    dispatch({ type: "theme/toggle" });
    applyTheme(ui.theme);
    announce(`Theme set to ${ui.theme}.`);
  },
  onService: (action) => {
    void runService(action);
  },
  onConfirmService: (action) => {
    dispatch({ type: "service/confirm", action });
  },
  onCancelService: () => {
    if (ui.confirmService === null) return;
    announce("Cancelled.");
    dispatch({ type: "service/confirm", action: null });
  },
});

const hostBlock = createHostBlock();

const modelsBlock = createModelsBlock({
  onFilterModel: (modelId) => {
    dispatch({ type: "filter/model-toggle", modelId });
  },
  onShowAllLogs: () => {
    dispatch({ type: "filter/model", modelId: null });
  },
  onModelAction: (modelId, action) => {
    void runModel(modelId, action);
  },
});

const sparkline = createSparkline();
const metricsBand = createMetricsBand(sparkline.el);

const toolbar = createToolbar({
  onLevel: (level: LevelFilter) => {
    dispatch({ type: "filter/level", level });
  },
  onQuery: (query) => {
    dispatch({ type: "filter/query", query });
  },
  onTogglePause: () => {
    dispatch({ type: "logs/pause-toggle" });
    announce(ui.paused ? "Log paused." : "Log resumed.");
  },
  onCopy: () => {
    void copyLog();
  },
  onDownload: downloadLog,
});

const logConsole = createLogConsole();
const slotsStrip = createSlotsStrip();

rail.append(serviceBlock.el, hostBlock.el, modelsBlock.el);
main.append(metricsBand.el, toolbar.el, logConsole.el, slotsStrip.el);

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function dispatch(action: UiAction): void {
  const next = reduce(ui, action);
  if (next === ui) return;
  ui = next;
  render();
}

function render(): void {
  if (snapshot === null) return;
  // The snapshot carries the server's clock, so the uptime readouts tick
  // against it rather than against a browser clock that may be minutes off.
  const now = snapshot.now + (Date.now() - snapshotAt);
  const vm = selectDashboard(snapshot, ui, now);

  serviceBlock.update(vm.service);
  hostBlock.update(vm.gauges);
  modelsBlock.update({ models: vm.models, allLogsPill: vm.allLogsPill });
  metricsBand.update(vm.kpis);
  sparkline.update(vm.spark);
  toolbar.update(vm.toolbar);
  logConsole.update({ lines: vm.lines, paused: ui.paused });
  slotsStrip.update(vm.slots);
}

function currentLogText(): string {
  if (snapshot === null) return "";
  return selectLogText(selectDashboard(snapshot, ui, snapshot.now));
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function refresh(): Promise<void> {
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) {
      announce(`Steward server returned ${response.status}.`);
      return;
    }
    snapshot = (await response.json()) as Snapshot;
    snapshotAt = Date.now();
    // The reducer, not this module, decides when a load/unload is done: it
    // clears a model's pending flag once this fresh snapshot shows the status
    // it was waiting for. The POST returned while the model was still
    // `loading`, so only the poll can confirm the transition.
    dispatch({ type: "models/observed", models: snapshot.models });
    render();
  } catch {
    announce("Lost contact with the Steward server.");
  }
}

let inbox: LogLine[] = [];
let flushHandle = 0;

/**
 * The stream replays its backlog one event at a time on connect. Coalescing a
 * frame's worth of lines turns that into a single reducer pass and a single
 * paint instead of two hundred.
 */
function enqueue(line: LogLine): void {
  inbox.push(line);
  if (flushHandle !== 0) return;
  flushHandle = requestAnimationFrame(() => {
    flushHandle = 0;
    const lines = inbox;
    inbox = [];
    dispatch({ type: "logs/append", lines });
  });
}

function connectLogs(): void {
  const source = new EventSource("/api/logs/stream");
  source.addEventListener("message", (event) => {
    if (!(event instanceof MessageEvent)) return;
    try {
      enqueue(JSON.parse(String(event.data)) as LogLine);
    } catch {
      // A malformed frame is not worth tearing the stream down for.
    }
  });
  source.addEventListener("error", () => {
    // EventSource retries on its own, but only while the connection is merely
    // interrupted. A closed stream (server restart) needs a fresh one.
    if (source.readyState !== EventSource.CLOSED) return;
    window.setTimeout(connectLogs, RECONNECT_DELAY_MS);
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** What a POST did, plus the server's reason when it did not. */
interface PostOutcome {
  ok: boolean;
  /** The command's own words, for the inline notice. `null` when unavailable. */
  detail: string | null;
}

/**
 * The server answers a refused action with a JSON `{ error }` naming what
 * actually happened (`launchctl: permission denied`). That detail is the whole
 * point of the notice, so it is read off the body rather than reduced to a
 * status code.
 */
async function readError(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const error = (body as { error?: unknown }).error;
      if (typeof error === "string" && error.trim() !== "") return error;
    }
  } catch {
    // Not JSON, or no body at all: fall back to the status line.
  }
  return `the Steward server returned ${response.status}`;
}

async function post(path: string): Promise<PostOutcome> {
  try {
    const response = await fetch(path, { method: "POST", cache: "no-store" });
    if (response.ok) return { ok: true, detail: null };
    return { ok: false, detail: await readError(response) };
  } catch {
    return { ok: false, detail: "the Steward server could not be reached" };
  }
}

/**
 * Runs a service action. The POST returning is not the outcome — a command can
 * exit 0 and leave the service exactly as it was (a `KeepAlive` job relaunches
 * itself after a stop) — so the refresh that follows is what tells the operator
 * what happened, and the button stays pending until that snapshot lands. A
 * refused command leaves an honest notice instead of a silent no-op.
 */
async function runService(action: ServiceAction): Promise<void> {
  if (ui.pendingService !== null) return;
  dispatch({ type: "service/confirm", action: null });
  dispatch({ type: "service/failure", failure: null });
  dispatch({ type: "service/pending", action });
  announce(`Running ${action} on the llama.cpp service.`);

  const outcome = await post(`/api/service/${action}`);
  if (outcome.ok) {
    announce(`${action} sent; confirming with the next poll.`);
  } else {
    dispatch({ type: "service/failure", failure: { action, detail: outcome.detail } });
    announce(`Could not ${action} the service: ${outcome.detail ?? "no reason given"}.`);
  }

  // The poll is the source of truth either way — including after a failure,
  // where the service may still have moved.
  await refresh();
  dispatch({ type: "service/pending", action: null });
}

/**
 * Load/unload is slow and asynchronous — the POST returns in tens of
 * milliseconds while the model is still spawning — so the button is not cleared
 * here. It is marked pending, and it stays pending until a polled snapshot
 * shows the model reached its target status (the reducer clears it from
 * `models/observed`). Only a rejected POST clears the flag directly, so a
 * request that never took does not spin forever.
 */
async function runModel(modelId: string, action: ModelAction): Promise<void> {
  if (ui.pendingModels[modelId] !== undefined) return;
  dispatch({ type: "model/pending", modelId, action });
  announce(`${action === "load" ? "Loading" : "Unloading"} ${modelId}.`);
  const { ok } = await post(`/api/models/${encodeURIComponent(modelId)}/${action}`);
  if (!ok) {
    announce(`Could not ${action} ${modelId}.`);
    dispatch({ type: "model/pending", modelId, action: null });
    return;
  }
  await refresh();
}

async function copyLog(): Promise<void> {
  const text = currentLogText();
  try {
    await navigator.clipboard.writeText(text);
    announce("Copied the visible log.");
  } catch {
    announce("The browser refused clipboard access.");
    return;
  }
  dispatch({ type: "copy/flag", copied: true });
  window.clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => {
    dispatch({ type: "copy/flag", copied: false });
  }, COPY_FEEDBACK_MS);
}

function downloadLog(): void {
  const url = URL.createObjectURL(new Blob([currentLogText()], { type: "text/plain" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "llama-server.log";
  anchor.click();
  announce("Downloading llama-server.log.");
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 2000);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

applyTheme(ui.theme);
// While in System mode, a live OS light/dark switch must repaint the palette.
// The mode itself does not change, so only the resolved attribute is re-applied.
globalThis.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (ui.theme === "system") applyTheme(ui.theme);
});
void refresh();
connectLogs();
window.setInterval(() => {
  void refresh();
}, SNAPSHOT_INTERVAL_MS);
window.setInterval(render, CLOCK_INTERVAL_MS);
