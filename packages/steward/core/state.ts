/**
 * The dashboard's own state — everything the operator changes that the server
 * does not know about, plus the log ring buffer the stream feeds.
 *
 * The reducer is pure and total: the browser holds one `UiState`, dispatches
 * actions at it, and re-renders from the result. Keep this module free of Node
 * and DOM APIs — see `./types.ts`.
 */

import type { LogLevel, LogLine, ModelAction, ModelStatus, ServiceAction } from "./types.js";

/** How many lines the browser keeps. Older lines fall off the front. */
export const LOG_BUFFER_LIMIT = 500;

/** The level filter, where `all` means "do not filter". */
export type LevelFilter = LogLevel | "all";

export type Theme = "light" | "dark";

export interface UiState {
  /** Live buffer, oldest first, capped at {@link LOG_BUFFER_LIMIT}. */
  log: LogLine[];
  /** Buffer snapshot taken when the operator paused, or `null` when live. */
  frozen: LogLine[] | null;
  paused: boolean;
  /** Model id the console is scoped to, or `null` for all models. */
  filterModel: string | null;
  filterLevel: LevelFilter;
  /** Case-insensitive substring, matched against the message text only. */
  query: string;
  theme: Theme;
  /** Set for a beat after Copy, so the button can acknowledge. */
  copied: boolean;
  /** Service action awaiting its POST, or `null`. */
  pendingService: ServiceAction | null;
  /** Model actions awaiting their POST, keyed by model id. */
  pendingModels: Record<string, ModelAction>;
}

export type UiAction =
  | { type: "logs/append"; lines: readonly LogLine[] }
  | { type: "filter/model"; modelId: string | null }
  | { type: "filter/model-toggle"; modelId: string }
  | { type: "filter/level"; level: LevelFilter }
  | { type: "filter/query"; query: string }
  | { type: "logs/pause-toggle" }
  | { type: "theme/toggle" }
  | { type: "copy/flag"; copied: boolean }
  | { type: "service/pending"; action: ServiceAction | null }
  | { type: "model/pending"; modelId: string; action: ModelAction | null }
  | { type: "models/observed"; models: readonly { id: string; status: ModelStatus }[] };

export function initialUiState(theme: Theme): UiState {
  return {
    log: [],
    frozen: null,
    paused: false,
    filterModel: null,
    filterLevel: "all",
    query: "",
    theme,
    copied: false,
    pendingService: null,
    pendingModels: {},
  };
}

function cap(lines: LogLine[]): LogLine[] {
  return lines.length > LOG_BUFFER_LIMIT ? lines.slice(lines.length - LOG_BUFFER_LIMIT) : lines;
}

/** Two deliveries of one line, as opposed to two lines sharing a number. */
function sameLine(a: LogLine, b: LogLine): boolean {
  return a.ts === b.ts && a.level === b.level && a.modelId === b.modelId && a.message === b.message;
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
function appendLines(log: LogLine[], incoming: readonly LogLine[]): LogLine[] {
  const newest = incoming.at(-1);
  if (newest === undefined) return log;
  const last = log.at(-1);
  const oldest = log[0];
  if (last === undefined || oldest === undefined) return cap(incoming.slice());

  if (incoming.some((line) => line.seq <= last.seq)) {
    // A batch that ends below everything held cannot be a replay: the source
    // would have had to go backwards to produce it.
    if (newest.seq < oldest.seq) return cap(incoming.slice());

    const held = new Map(log.map((line) => [line.seq, line]));
    for (const line of incoming) {
      const previous = held.get(line.seq);
      if (previous !== undefined && !sameLine(previous, line)) return cap(incoming.slice());
    }
  }

  const fresh = incoming.filter((line) => line.seq > last.seq);
  return fresh.length === 0 ? log : cap(log.concat(fresh));
}

/**
 * Returns the same object when an action is a no-op, so callers can skip a
 * repaint on the many ticks that change nothing.
 */
export function reduce(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "logs/append": {
      const log = appendLines(state.log, action.lines);
      return log === state.log ? state : { ...state, log };
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
    case "filter/query": {
      if (state.query === action.query) return state;
      return { ...state, query: action.query };
    }
    case "logs/pause-toggle": {
      // Pausing freezes what is on screen; the live buffer keeps filling behind
      // it so Resume drops the operator back into the present, not the past.
      if (state.paused) return { ...state, paused: false, frozen: null };
      return { ...state, paused: true, frozen: state.log.slice() };
    }
    case "theme/toggle":
      return { ...state, theme: state.theme === "dark" ? "light" : "dark" };
    case "copy/flag": {
      if (state.copied === action.copied) return state;
      return { ...state, copied: action.copied };
    }
    case "service/pending": {
      if (state.pendingService === action.action) return state;
      return { ...state, pendingService: action.action };
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
