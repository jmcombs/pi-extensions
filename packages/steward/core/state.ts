/**
 * The dashboard's own state — everything the operator changes that the server
 * does not know about, plus the log ring buffer the stream feeds.
 *
 * The reducer is pure and total: the browser holds one `UiState`, dispatches
 * actions at it, and re-renders from the result. Keep this module free of Node
 * and DOM APIs — see `./types.ts`.
 */

import type {
  LogFamily,
  LogLevel,
  LogLine,
  LogSourceState,
  ModelAction,
  ModelStatus,
  ServiceAction,
} from "./types.js";

/**
 * How many SIGNAL lines the browser keeps — every line whose kind is not
 * `proxy`. Older ones fall off the front.
 *
 * Signal and poll traffic get separate budgets because they arrive at wildly
 * different rates: an idle router emits no signal at all and ~1.25 proxied
 * requests per second per loaded model, most of them Steward's own status
 * polling. Under one shared budget that metronome evicts the boot banner — the
 * thing the operator opened the console to read — within minutes, and hiding
 * proxy lines in the VIEW does nothing about it, because the eviction already
 * happened in the buffer.
 */
export const LOG_BUFFER_LIMIT = 500;

/**
 * How many `proxy` lines the browser keeps. Deliberately much smaller than
 * {@link LOG_BUFFER_LIMIT}: this class is a recency window ("what has been
 * asked of the router lately"), not a history, and it is the only class that
 * can arrive faster than an operator can read.
 */
export const POLL_BUFFER_LIMIT = 200;

/** The level filter, where `all` means "do not filter". */
export type LevelFilter = LogLevel | "all";

/** The record-type filter, where `any` means "do not filter". */
export type FamilyFilter = LogFamily | "any";

/**
 * The request being traced: every line one llama-server task wrote, in file
 * order.
 *
 * Keyed on `(port, task)` and never on `task` alone. Task ids are a per-process
 * counter starting at 0, so task `0` appears under eight different ports in a
 * single measured corpus — a trace keyed on the id would mix two models' lines
 * together and call it one request.
 */
export interface TraceRef {
  port: number;
  task: number;
  /**
   * `seq` of the row that opened it. Retained so a later phase can narrow to
   * one occurrence when an OS reuses a port, without a state-shape change.
   */
  anchorSeq: number;
}

/**
 * The SSE connection's own state, which is not the same question as whether a
 * log source exists: a live stream can be carrying nothing, and a dead stream
 * can leave a full buffer on screen.
 */
export type LogStreamState = "connecting" | "live" | "reconnecting";

/**
 * `system` follows the OS `prefers-color-scheme` and is the default; `light` and
 * `dark` pin the palette. The one control cycles system → light → dark → system.
 */
export type Theme = "light" | "dark" | "system";

/** A service action that did not take, with the reason the server reported. */
export interface ServiceFailure {
  action: ServiceAction;
  /** The command's own words (`launchctl: permission denied`), or `null`. */
  detail: string | null;
}

export interface UiState {
  /** Live buffer, oldest first, capped at {@link LOG_BUFFER_LIMIT}. */
  log: LogLine[];
  /** Buffer snapshot taken when the operator paused, or `null` when live. */
  frozen: LogLine[] | null;
  paused: boolean;
  /**
   * True once the buffer has evicted a SIGNAL line, so the console can say that
   * older lines are gone rather than letting the window look complete. Proxy
   * evictions do not set it: that class is a recency window by design, and a
   * permanent banner about it would say nothing.
   */
  bufferDropped: boolean;
  /** Model id the console is scoped to, or `null` for all models. */
  filterModel: string | null;
  filterLevel: LevelFilter;
  /**
   * Which record type the console is scoped to, or `any`. A second filter axis
   * beside the level chips, single-select for exactly the same reason they are:
   * a chip's count means one thing, and pressing it yields that many rows.
   */
  filterFamily: FamilyFilter;
  /**
   * Case-insensitive substring, matched against the line's text — the frame
   * included, so a task id that is visible on the row is findable in the box.
   */
  query: string;
  /**
   * Whether proxied-request lines are shown. Default `false`: they are 86.9% of
   * a real log and most of them are Steward polling itself. Never a hard drop —
   * on a router serving external clients they are the only inbound-traffic
   * evidence in the file — and the toolbar always counts out loud what the
   * toggle is holding back.
   *
   * Deliberately NOT persisted: an operator who left it on would come back to a
   * console filling at 1.25 lines/second with no memory of why.
   */
  showProxy: boolean;
  /**
   * The args folds the operator has opened, keyed by the `seq` of the run's
   * first line. Absent means collapsed; a run that falls out of the buffer takes
   * its entry's meaning with it and the stale key simply never matches again.
   */
  expandedArgs: Record<number, true>;
  /**
   * The request being traced, or `null`. A trace ignores every filter and says
   * so out loud, so this is not a filter — it REPLACES the filter stack while
   * it is set, and every `filter/*` action clears it.
   */
  trace: TraceRef | null;
  /** The log stream's connection state, fed by the `EventSource` lifecycle. */
  logStream: LogStreamState;
  /**
   * Whether the server has a log source at all, and how it is failing when it
   * does not. `ok` until the stream says otherwise, so a console that has not
   * heard yet does not accuse anything.
   */
  logSource: LogSourceState;
  /** The path the server is watching, so the console can name the file it misses. */
  logSourcePath: string | null;
  /**
   * The server's own reason the source is not `ok` (`… could not be read
   * (EACCES)`), or `null`. Rendered verbatim rather than paraphrased: it is the
   * difference between an operator fixing a permission and hunting a bug that
   * does not exist.
   */
  logSourceDetail: string | null;
  theme: Theme;
  /** Set for a beat after Copy, so the button can acknowledge. */
  copied: boolean;
  /** Service action awaiting its POST, or `null`. */
  pendingService: ServiceAction | null;
  /**
   * The disruptive action whose confirm strip is open, or `null`. Stop and
   * restart unload models and drop in-flight requests, so they are never one
   * click away — the strip names the consequence first.
   */
  confirmService: ServiceAction | null;
  /**
   * The last service action that failed, or `null`. Kept structured (not a
   * sentence) because `core/select.ts` is the one place a displayed string is
   * derived. Cleared when the next action starts.
   */
  serviceFailure: ServiceFailure | null;
  /** Model actions awaiting their POST, keyed by model id. */
  pendingModels: Record<string, ModelAction>;
  /**
   * The key of the drift notice the operator dismissed, or `null`.
   *
   * Deliberately in memory and deliberately keyed: it is forgotten on reload,
   * and a mismatch that CHANGES gets a new key and reappears. Dismissal buys
   * quiet for this session, never a dashboard that looks compliant while it is
   * not — which is the one thing this notice exists to prevent.
   */
  dismissedDrift: string | null;
}

export type UiAction =
  | { type: "logs/append"; lines: readonly LogLine[] }
  | { type: "filter/model"; modelId: string | null }
  | { type: "filter/model-toggle"; modelId: string }
  | { type: "filter/level"; level: LevelFilter }
  | { type: "filter/family"; family: FamilyFilter }
  | { type: "filter/query"; query: string }
  | { type: "filter/proxy-toggle" }
  | { type: "logs/pause-toggle" }
  | { type: "logs/trace"; trace: TraceRef | null }
  | { type: "logs/fold-toggle"; seq: number }
  | { type: "logs/stream-status"; status: LogStreamState }
  | {
      type: "logs/source-status";
      source: LogSourceState;
      path: string | null;
      detail: string | null;
    }
  | { type: "theme/toggle" }
  | { type: "copy/flag"; copied: boolean }
  | { type: "service/pending"; action: ServiceAction | null }
  | { type: "service/confirm"; action: ServiceAction | null }
  | { type: "service/failure"; failure: ServiceFailure | null }
  | { type: "drift/dismiss"; key: string | null }
  | { type: "model/pending"; modelId: string; action: ModelAction | null }
  | { type: "models/observed"; models: readonly { id: string; status: ModelStatus }[] };

export function initialUiState(theme: Theme): UiState {
  return {
    log: [],
    frozen: null,
    paused: false,
    bufferDropped: false,
    filterModel: null,
    filterLevel: "all",
    filterFamily: "any",
    query: "",
    showProxy: false,
    expandedArgs: {},
    trace: null,
    logStream: "connecting",
    logSource: "ok",
    logSourcePath: null,
    logSourceDetail: null,
    theme,
    copied: false,
    pendingService: null,
    confirmService: null,
    serviceFailure: null,
    pendingModels: {},
    dismissedDrift: null,
  };
}

/** A capped buffer, plus whether capping it cost the operator any signal. */
interface CappedBuffer {
  lines: LogLine[];
  /** True when at least one line that was NOT proxy traffic had to be evicted. */
  droppedSignal: boolean;
  /**
   * True when the batch REPLACED the buffer rather than extending it — a source
   * that started over. It means precisely "nothing held is older than this
   * buffer", so whatever the previous source dropped is no longer a fact about
   * what is on screen.
   */
  restarted: boolean;
}

/**
 * Trims the buffer to its two budgets: {@link LOG_BUFFER_LIMIT} signal lines
 * and {@link POLL_BUFFER_LIMIT} proxy lines.
 *
 * The walk goes newest-first so each budget is spent on the most recent lines
 * of its class, and the survivors are re-reversed — so the result is still ONE
 * array, still ascending by `seq`, which is what `appendLines`' replay/restart
 * detection reads. The same array object comes back when nothing was dropped,
 * so an append that changes nothing stays a no-op.
 */
function cap(lines: LogLine[]): CappedBuffer {
  let signal = 0;
  let poll = 0;
  let dropped = false;
  let droppedSignal = false;
  const kept: LogLine[] = [];

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.kind === "proxy") {
      if (poll < POLL_BUFFER_LIMIT) {
        poll += 1;
        kept.push(line);
      } else {
        dropped = true;
      }
    } else if (signal < LOG_BUFFER_LIMIT) {
      signal += 1;
      kept.push(line);
    } else {
      dropped = true;
      droppedSignal = true;
    }
  }

  if (!dropped) return { lines, droppedSignal: false, restarted: false };
  kept.reverse();
  return { lines: kept, droppedSignal, restarted: false };
}

/** {@link cap}, for a batch that replaces the buffer instead of extending it. */
function adopt(lines: LogLine[]): CappedBuffer {
  return { ...cap(lines), restarted: true };
}

/**
 * Two deliveries of one line, as opposed to two lines sharing a number.
 *
 * **The task id is load-bearing here.** With the pipe frame relocated out of
 * the message, two different requests' `print_timing: eval time = …` lines can
 * compare equal on every other field — same stamp resolution, same level, same
 * model, byte-identical message. {@link appendLines} reads this to tell a
 * stream replay from a source that restarted its numbering, so without the task
 * id a restarted server's whole backlog is mistaken for a replay and discarded,
 * and the console sits there holding the dead source's lines forever.
 */
function sameLine(a: LogLine, b: LogLine): boolean {
  return (
    a.ts === b.ts &&
    a.level === b.level &&
    a.modelId === b.modelId &&
    a.frame?.task === b.frame?.task &&
    a.message === b.message
  );
}

/**
 * The stream replays its backlog on every connect, so a reconnect re-delivers
 * lines already on screen — and because the browser coalesces stream events per
 * frame, that replay arrives as several batches which can be wholly or partly
 * older than the buffer. Sequence numbers are monotonic per source, so
 * "strictly newer than what we hold" is the de-duplication rule.
 *
 * A source that restarts begins numbering again, and that rule alone would then
 * discard everything it sends forever. The sequence number cannot tell a replay
 * from a restart when the two ranges overlap, but the content can: a restarted
 * source writes different lines under the numbers the buffer already holds. So
 * an overlap that disagrees is a new source and its batch is adopted whole,
 * while an overlap that agrees is a replay and only the genuinely new lines are
 * kept.
 */
function appendLines(log: LogLine[], incoming: readonly LogLine[]): CappedBuffer {
  const newest = incoming.at(-1);
  if (newest === undefined) return { lines: log, droppedSignal: false, restarted: false };
  const last = log.at(-1);
  const oldest = log[0];
  if (last === undefined || oldest === undefined) return adopt(incoming.slice());

  if (incoming.some((line) => line.seq <= last.seq)) {
    // A batch that ends below everything held cannot be a replay: the source
    // would have had to go backwards to produce it.
    if (newest.seq < oldest.seq) return adopt(incoming.slice());

    const held = new Map(log.map((line) => [line.seq, line]));
    for (const line of incoming) {
      const previous = held.get(line.seq);
      if (previous !== undefined && !sameLine(previous, line)) return adopt(incoming.slice());
    }
  }

  const fresh = incoming.filter((line) => line.seq > last.seq);
  return fresh.length === 0
    ? { lines: log, droppedSignal: false, restarted: false }
    : cap(log.concat(fresh));
}

/**
 * Returns the same object when an action is a no-op, so callers can skip a
 * repaint on the many ticks that change nothing.
 *
 * **Every `filter/*` action also closes an open trace**, and it happens here
 * rather than in the handlers — one rule, in one place, that a new control
 * cannot forget. It is why no chip, pill or toggle is ever disabled while a
 * trace is open: pressing WARN during a trace exits the trace and applies the
 * filter, which is the answer an operator expects and the one they get.
 */
export function reduce(state: UiState, action: UiAction): UiState {
  const next = apply(state, action);
  if (next.trace === null || !action.type.startsWith("filter/")) return next;
  return { ...next, trace: null };
}

function apply(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "logs/append": {
      const { lines: log, droppedSignal, restarted } = appendLines(state.log, action.lines);
      // Once true it stays true — the operator has lost lines and the console
      // keeps saying so — EXCEPT across a restart, which replaces the buffer
      // whole. Carrying the flag over would leave a permanent "older lines
      // dropped" banner on a console holding every line the new source ever
      // wrote, which is the opposite of the truth it was added to tell.
      const bufferDropped = restarted ? droppedSignal : state.bufferDropped || droppedSignal;
      if (log === state.log && bufferDropped === state.bufferDropped) return state;
      return { ...state, log, bufferDropped };
    }
    case "filter/model": {
      if (state.filterModel === action.modelId) return state;
      return { ...state, filterModel: action.modelId };
    }
    case "filter/model-toggle": {
      const next = state.filterModel === action.modelId ? null : action.modelId;
      return { ...state, filterModel: next };
    }
    case "filter/level": {
      if (state.filterLevel === action.level) return state;
      return { ...state, filterLevel: action.level };
    }
    case "filter/family": {
      if (state.filterFamily === action.family) return state;
      return { ...state, filterFamily: action.family };
    }
    case "filter/query": {
      if (state.query === action.query) return state;
      return { ...state, query: action.query };
    }
    case "logs/trace": {
      const current = state.trace;
      const next = action.trace;
      if (current === null && next === null) return state;
      if (
        current !== null &&
        next !== null &&
        current.port === next.port &&
        current.task === next.task &&
        current.anchorSeq === next.anchorSeq
      ) {
        return state;
      }
      return { ...state, trace: next };
    }
    case "filter/proxy-toggle": {
      return { ...state, showProxy: !state.showProxy };
    }
    case "logs/pause-toggle": {
      // Pausing freezes what is on screen; the live buffer keeps filling behind
      // it so Resume drops the operator back into the present, not the past.
      if (state.paused) return { ...state, paused: false, frozen: null };
      return { ...state, paused: true, frozen: state.log.slice() };
    }
    case "logs/fold-toggle": {
      const expandedArgs = { ...state.expandedArgs };
      if (expandedArgs[action.seq] === true) delete expandedArgs[action.seq];
      else expandedArgs[action.seq] = true;
      return { ...state, expandedArgs };
    }
    case "logs/stream-status": {
      if (state.logStream === action.status) return state;
      return { ...state, logStream: action.status };
    }
    case "logs/source-status": {
      if (
        state.logSource === action.source &&
        state.logSourcePath === action.path &&
        state.logSourceDetail === action.detail
      ) {
        return state;
      }
      return {
        ...state,
        logSource: action.source,
        logSourcePath: action.path,
        logSourceDetail: action.detail,
      };
    }
    case "theme/toggle": {
      const next: Theme =
        state.theme === "system" ? "light" : state.theme === "light" ? "dark" : "system";
      return { ...state, theme: next };
    }
    case "copy/flag": {
      if (state.copied === action.copied) return state;
      return { ...state, copied: action.copied };
    }
    case "service/pending": {
      if (state.pendingService === action.action) return state;
      return { ...state, pendingService: action.action };
    }
    case "service/confirm": {
      if (state.confirmService === action.action) return state;
      return { ...state, confirmService: action.action };
    }
    case "service/failure": {
      if (state.serviceFailure === null && action.failure === null) return state;
      return { ...state, serviceFailure: action.failure };
    }
    case "drift/dismiss": {
      if (state.dismissedDrift === action.key) return state;
      return { ...state, dismissedDrift: action.key };
    }
    case "model/pending": {
      const pendingModels = { ...state.pendingModels };
      if (action.action === null) {
        if (!(action.modelId in pendingModels)) return state;
        delete pendingModels[action.modelId];
      } else {
        if (pendingModels[action.modelId] === action.action) return state;
        pendingModels[action.modelId] = action.action;
      }
      return { ...state, pendingModels };
    }
    case "models/observed": {
      // The POST that started a load/unload returns while the model is still in
      // flight, so the optimistic pending flag has to persist until a *later*
      // snapshot shows the transition finished. A load is done once the model is
      // loaded (active or resident); an unload once it is unloaded (or gone from
      // the list). Until then the flag stays and the button keeps spinning.
      const status = new Map(action.models.map((model) => [model.id, model.status]));
      let pendingModels: Record<string, ModelAction> | null = null;
      for (const [id, pending] of Object.entries(state.pendingModels)) {
        const current = status.get(id);
        // A load finishes once the model is loaded (active or resident); a load
        // that the router accepted but then failed reverts to unloaded, which
        // resolves the flag too — otherwise the button would spin forever. The
        // card still reads `loading`/`downloading` straight off the status, so a
        // flag cleared a poll early (the model briefly still unloaded right after
        // the POST) re-shows as loading on its own. An unload finishes when the
        // model is unloaded or gone.
        const done =
          pending === "load"
            ? current === "active" ||
              current === "resident" ||
              current === "unloaded" ||
              current === undefined
            : current === "unloaded" || current === undefined;
        if (!done) continue;
        if (pendingModels === null) pendingModels = { ...state.pendingModels };
        delete pendingModels[id];
      }
      return pendingModels === null ? state : { ...state, pendingModels };
    }
    default:
      return state;
  }
}

/** The buffer the console renders from: frozen while paused, live otherwise. */
export function visibleBuffer(state: UiState): readonly LogLine[] {
  return state.paused && state.frozen !== null ? state.frozen : state.log;
}
