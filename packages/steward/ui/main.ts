/**
 * Bootstrap for the Steward dashboard.
 *
 * This module is the only place in the browser that touches the network or the
 * clock: it polls `/api/snapshot`, holds the log stream open, dispatches
 * actions at the reducer, and hands the resulting view model to the components.
 * Nothing here derives a displayed value — that all lives in `core/select.ts`.
 */

import {
  CONTEXT_LOST_QUERY,
  consoleAnnouncement,
  driftAnnouncement,
  foldAnnouncement,
  selectDashboard,
  selectLogExportSummary,
  selectLogText,
  truncationAnnouncement,
} from "../core/select.js";
import type { FamilyFilter, LevelFilter, Theme, UiAction, UiState } from "../core/state.js";
import { initialUiState, reduce } from "../core/state.js";
import type { TemperaturePreference, TemperatureUnit } from "../core/temperature.js";
import {
  parseTemperaturePreference,
  resolveTemperatureUnit,
  temperatureUnitForLocales,
} from "../core/temperature.js";
import type {
  LogLine,
  LogStreamStatus,
  ModelAction,
  ServiceAction,
  Snapshot,
} from "../core/types.js";
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

/**
 * How long typing settles before the search result is announced. Announcing per
 * keystroke would machine-gun the polite region; announcing the RESULT COUNT
 * once the operator stops is the useful half of it.
 */
const QUERY_ANNOUNCE_MS = 500;

const THEME_KEY = "steward.theme";

const TEMPERATURE_KEY = "steward.temperature";

const rail = document.getElementById("steward-rail");
const main = document.getElementById("steward-main");
const status = document.getElementById("steward-status");
if (rail === null || main === null) throw new Error("Steward: the page shell is missing.");

let ui: UiState = initialUiState(readTheme(), applyTemperature(readTemperaturePreference()));
let snapshot: Snapshot | null = null;
let snapshotAt = 0;
let copyTimer = 0;
let queryTimer = 0;
/** The drift notice already announced, so the poll cannot repeat it. */
let announcedDrift: string | null = null;
/** The console state already announced, so the render clock cannot repeat it. */
let announcedConsole: string | null = null;
/** Set once the truncation banner has been announced, so it is said once. */
let announcedTruncation = false;

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

// ---------------------------------------------------------------------------
// Temperature unit
// ---------------------------------------------------------------------------

/**
 * The locales this browser reports, most specific intent first.
 *
 * `Intl.DateTimeFormat` is asked first because it answers with the locale the
 * runtime actually RESOLVED — the one it is already formatting dates and numbers
 * with — while `navigator.language`/`languages` is the request list. In practice
 * they agree; when they do not, the resolved one is what the rest of the page
 * looks like. Every read is guarded: a browser that refuses any of them
 * contributes nothing to the list rather than taking the page down.
 */
function browserLocales(): (string | null | undefined)[] {
  const locales: (string | null | undefined)[] = [];
  try {
    locales.push(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    // No usable Intl data; the navigator list below may still name a region.
  }
  try {
    const nav = globalThis.navigator as Navigator | undefined;
    if (nav !== undefined) {
      locales.push(nav.language);
      for (const locale of nav.languages ?? []) locales.push(locale);
    }
  } catch {
    // Same reasoning: an absent or hostile navigator is not an error here.
  }
  return locales;
}

/**
 * The unit this browser's region implies. Celsius whenever nothing names a
 * region — the honest answer for a browser that did not say where it is, and
 * the right one for the overwhelming majority of regions that do.
 */
function detectTemperatureUnit(): TemperatureUnit {
  return temperatureUnitForLocales(browserLocales());
}

/** The stored preference, defaulting to `auto` when unset or unrecognized. */
function readTemperaturePreference(): TemperaturePreference {
  try {
    return parseTemperaturePreference(localStorage.getItem(TEMPERATURE_KEY));
  } catch {
    // Storage refused (private mode): fall through to the default.
    return "auto";
  }
}

/**
 * Applies a preference and returns the unit to label with — `auto` resolved
 * against the detected browser region, an explicit choice taken as given.
 *
 * The *preference* is what persists, not the resolved unit, so an operator on
 * `auto` who travels or changes their OS region follows it rather than being
 * pinned to whatever their first visit detected. That is the same split
 * {@link applyTheme} makes between the `system` mode and the palette it resolves
 * to. There is no control that calls this with anything but the stored value
 * yet; when one lands, this is the function it calls.
 */
function applyTemperature(preference: TemperaturePreference): TemperatureUnit {
  try {
    localStorage.setItem(TEMPERATURE_KEY, preference);
  } catch {
    // Storage is optional; the choice simply will not survive a reload.
  }
  return resolveTemperatureUnit(preference, detectTemperatureUnit());
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
  onDismissDrift: (key) => {
    dispatch({ type: "drift/dismiss", key });
    announce("Drift notice dismissed. It returns while the mismatch is still there.");
  },
});

const hostBlock = createHostBlock();

/**
 * `88 of 340 lines` for the polite region — the result of a filter change, not
 * the change itself. An operator who cannot see the console needs to know what
 * the control did, and the count is the whole of what it did.
 */
function filterResult(): string {
  if (snapshot === null) return "";
  const counts = selectDashboard(snapshot, ui, snapshot.now).logCounts;
  const hidden = counts.hiddenProxy > 0 ? ` ${counts.hiddenProxy} proxied lines are hidden.` : "";
  return `${counts.matched} of ${counts.buffered} lines.${hidden}`;
}

/**
 * The clause a filter announcement carries when it also closed a trace.
 *
 * The reducer clears the trace on every `filter/*` action, so a handler cannot
 * forget it — but the OPERATOR still has to be told, in the same sentence as
 * the thing they actually asked for. Read before the dispatch, since afterwards
 * the trace is already gone.
 */
function traceClosedPrefix(): string {
  return ui.trace === null ? "" : "Trace closed. ";
}

const modelsBlock = createModelsBlock({
  onFilterModel: (modelId) => {
    const closed = traceClosedPrefix();
    dispatch({ type: "filter/model-toggle", modelId });
    announce(
      ui.filterModel === null
        ? `${closed}Log showing all models — ${filterResult()}`
        : `${closed}Log scoped to ${ui.filterModel} — ${filterResult()}`,
    );
  },
  onShowAllLogs: () => {
    const closed = traceClosedPrefix();
    dispatch({ type: "filter/model", modelId: null });
    announce(`${closed}Log showing all models — ${filterResult()}`);
  },
  onModelAction: (modelId, action) => {
    void runModel(modelId, action);
  },
});

const sparkline = createSparkline();
const metricsBand = createMetricsBand(sparkline.el);

const toolbar = createToolbar({
  onLevel: (level: LevelFilter) => {
    const closed = traceClosedPrefix();
    dispatch({ type: "filter/level", level });
    announce(`${closed}Level filter: ${level === "all" ? "any level" : level} — ${filterResult()}`);
  },
  onFamily: (family: FamilyFilter) => {
    const closed = traceClosedPrefix();
    dispatch({ type: "filter/family", family });
    announce(`${closed}Kind filter: ${family === "any" ? "any kind" : family} — ${filterResult()}`);
  },
  onQuery: (query) => {
    const closed = traceClosedPrefix();
    dispatch({ type: "filter/query", query });
    window.clearTimeout(queryTimer);
    queryTimer = window.setTimeout(() => {
      const trimmed = ui.query.trim();
      announce(
        trimmed === ""
          ? `${closed}Search cleared — ${filterResult()}`
          : `${closed}Search "${trimmed}": ${filterResult()}`,
      );
    }, QUERY_ANNOUNCE_MS);
  },
  onToggleProxy: () => {
    const closed = traceClosedPrefix();
    dispatch({ type: "filter/proxy-toggle" });
    if (snapshot === null) return;
    const counts = selectDashboard(snapshot, ui, snapshot.now).logCounts;
    announce(
      ui.showProxy
        ? `${closed}Proxied requests shown. ${counts.matched} of ${counts.buffered} lines.`
        : `${closed}Proxied requests hidden. ${counts.matched} of ${counts.buffered} lines. Most were Steward's own status polls.`,
    );
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

const logConsole = createLogConsole({
  onFold: (seq, forced, count) => {
    dispatch({ type: "logs/fold-toggle", seq });
    // Read back off the NEW state. Announced once — the lines themselves are
    // never announced, not even for a user-initiated expansion: the console is
    // not a live region and that rule does not bend for 31 argument lines.
    announce(foldAnnouncement(count, forced, ui.expandedArgs[seq] === true));
  },
  onTrace: (port, task, anchorSeq) => {
    dispatch({ type: "logs/trace", trace: { port, task, anchorSeq } });
    if (snapshot === null) return;
    const counts = selectDashboard(snapshot, ui, snapshot.now).logCounts;
    announce(
      `Tracing task ${task} on port ${port} — ${counts.traced} lines. Filters do not apply inside a trace.`,
    );
  },
  onExitTrace: () => {
    if (ui.trace === null) return;
    dispatch({ type: "logs/trace", trace: null });
    announce(`Trace closed. ${filterResult()}`);
  },
  onAction: (kind) => {
    if (kind === "exit-trace") {
      if (ui.trace === null) return;
      dispatch({ type: "logs/trace", trace: null });
      announce(`Trace closed. ${filterResult()}`);
      return;
    }
    if (kind === "query-truncated") {
      // A search, not a fourth filter axis: the box visibly fills with the
      // literal the message carries, and the operator can edit or clear it.
      const closed = traceClosedPrefix();
      dispatch({ type: "filter/query", query: CONTEXT_LOST_QUERY });
      announce(`${closed}Search "${CONTEXT_LOST_QUERY}": ${filterResult()}`);
      return;
    }
    if (kind === "show-all-models") {
      const closed = traceClosedPrefix();
      dispatch({ type: "filter/model", modelId: null });
      announce(`${closed}Log showing all models — ${filterResult()}`);
      return;
    }
    const closed = traceClosedPrefix();
    dispatch({ type: "filter/model", modelId: null });
    dispatch({ type: "filter/level", level: "all" });
    dispatch({ type: "filter/family", family: "any" });
    dispatch({ type: "filter/query", query: "" });
    announce(`${closed}Filters cleared — ${filterResult()}`);
  },
});
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

  // Drift is announced when it is NEW, never on every poll: the same mismatch
  // is still there 1.6 s later, and repeating it would make the status region
  // unusable. `driftAnnouncement` owns that decision (and the watermark reset
  // that lets a mismatch which comes back be announced again).
  const drift = driftAnnouncement(vm.service.drift, announcedDrift);
  announcedDrift = drift.key;
  if (drift.message !== null) announce(drift.message);

  // The console's own state — no source, file gone, reconnecting, stopped,
  // quiet — speaks through the same polite region and by the same rule: once
  // per transition, never per poll and never per line.
  const spoken = consoleAnnouncement(vm.console, ui.logSourcePath, announcedConsole);
  announcedConsole = spoken.key;
  if (spoken.message !== null) announce(spoken.message);

  // Losing lines is worth saying once, when it first happens — and in the same
  // two forms the banner uses, so it can never read "showing the latest 300 of
  // 300". A source restart clears the flag and re-arms the announcement,
  // because the next drop is a new thing that happened.
  if (!vm.logCounts.bufferDropped) announcedTruncation = false;
  else if (!announcedTruncation) {
    announcedTruncation = true;
    announce(truncationAnnouncement(vm.logCounts));
  }

  serviceBlock.update(vm.service);
  hostBlock.update(vm.gauges);
  modelsBlock.update({ models: vm.models, allLogsPill: vm.allLogsPill });
  metricsBand.update(vm.kpis);
  sparkline.update(vm.spark);
  toolbar.update(vm.toolbar);
  logConsole.update(vm.console);
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
  source.addEventListener("open", () => {
    dispatch({ type: "logs/stream-status", status: "live" });
  });
  source.addEventListener("message", (event) => {
    if (!(event instanceof MessageEvent)) return;
    try {
      enqueue(JSON.parse(String(event.data)) as LogLine);
    } catch {
      // A malformed frame is not worth tearing the stream down for.
    }
  });
  // The health of the log SOURCE is a different question from the health of
  // this connection: the server can be streaming perfectly and have no file to
  // read, or be watching a path that macOS deleted out from under it. It rides
  // its own named event so an old client's `message` handler never sees it.
  source.addEventListener("source", (event) => {
    if (!(event instanceof MessageEvent)) return;
    try {
      const status = JSON.parse(String(event.data)) as LogStreamStatus;
      dispatch({
        type: "logs/source-status",
        source: status.source,
        path: status.path,
        detail: status.detail,
      });
    } catch {
      // Same reasoning as a malformed line: not worth a teardown.
    }
  });
  source.addEventListener("error", () => {
    // EventSource retries on its own, but only while the connection is merely
    // interrupted. A closed stream (server restart) needs a fresh one.
    dispatch({ type: "logs/stream-status", status: "reconnecting" });
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

/** What was exported, said honestly — it is not what is on screen. */
function exportSummary(): string {
  if (snapshot === null) return "";
  return selectLogExportSummary(selectDashboard(snapshot, ui, snapshot.now).logCounts);
}

async function copyLog(): Promise<void> {
  const text = currentLogText();
  const summary = exportSummary();
  try {
    await navigator.clipboard.writeText(text);
    announce(`Copied ${summary}`);
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
  const summary = exportSummary();
  const url = URL.createObjectURL(new Blob([currentLogText()], { type: "text/plain" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "llama-server.log";
  anchor.click();
  announce(`Downloading llama-server.log — ${summary}`);
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
