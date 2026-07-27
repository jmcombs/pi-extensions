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
import { createConfigBlock } from "./components/config.js";
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

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function applyTheme(theme: Theme): void {
  if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
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
  onService: (action) => {
    void runService(action);
  },
  onToggleTheme: () => {
    dispatch({ type: "theme/toggle" });
    applyTheme(ui.theme);
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

const configBlock = createConfigBlock();
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

rail.append(serviceBlock.el, hostBlock.el, modelsBlock.el, configBlock.el);
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
  configBlock.update(vm.config);
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

async function post(path: string): Promise<boolean> {
  try {
    const response = await fetch(path, { method: "POST", cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Actions are never reflected optimistically: the control shows that it is
 * working, and the state only moves once a snapshot confirms it did.
 */
async function runService(action: ServiceAction): Promise<void> {
  if (ui.pendingService !== null) return;
  dispatch({ type: "service/pending", action });
  const ok = await post(`/api/service/${action}`);
  if (!ok) announce(`Could not ${action} the service.`);
  await refresh();
  dispatch({ type: "service/pending", action: null });
}

async function runModel(modelId: string, action: ModelAction): Promise<void> {
  if (ui.pendingModels[modelId] !== undefined) return;
  dispatch({ type: "model/pending", modelId, action });
  announce(`${action === "load" ? "Loading" : "Unloading"} ${modelId}.`);
  const ok = await post(`/api/models/${encodeURIComponent(modelId)}/${action}`);
  if (!ok) announce(`Could not ${action} ${modelId}.`);
  await refresh();
  dispatch({ type: "model/pending", modelId, action: null });
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
void refresh();
connectLogs();
window.setInterval(() => {
  void refresh();
}, SNAPSHOT_INTERVAL_MS);
window.setInterval(render, CLOCK_INTERVAL_MS);
