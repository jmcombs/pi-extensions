/**
 * The one place a `Snapshot` plus the operator's `UiState` becomes something
 * renderable.
 *
 * Every string, color, percentage and enabled/disabled decision on screen is
 * derived here, which is what lets the `ui/` modules stay a dumb translation of
 * view models into elements. Colors come out as CSS custom-property references
 * because the design assigns them per model and per threshold — the stylesheet
 * cannot know which. Keep this module free of Node and DOM APIs.
 */

import type { ConsentDrift, LaunchDrift } from "./drift.js";
import {
  barPercent,
  contextHeadroomColor,
  formatClock,
  formatClockSeconds,
  formatContextField,
  formatCount,
  formatFlashField,
  formatGpuLayersField,
  formatKvCacheField,
  formatLines,
  formatLogText,
  formatMemory,
  formatPercent,
  formatQuantField,
  formatSizeField,
  formatTemperature,
  formatTokenCount,
  formatTps,
  formatTypeField,
  formatUptime,
  NA,
  temperatureBarPercent,
  temperatureColor,
} from "./format.js";
import { modelColor } from "./model-color.js";
import type { FamilyFilter, LevelFilter, TraceRef, UiState } from "./state.js";
import { LOG_BUFFER_LIMIT, visibleBuffer } from "./state.js";
import type { TemperatureUnit } from "./temperature.js";
import type {
  ConfigEntry,
  LogFamily,
  LogKind,
  LogLevel,
  LogLine,
  ModelAction,
  ModelInfo,
  ServiceAction,
  SlotInfo,
  SlotState,
  Snapshot,
} from "./types.js";

// A model's color is a stable hash of its id (embedders get a reserved hue);
// re-exported here because it is part of this module's view-model surface.
export { modelColor } from "./model-color.js";

/**
 * How many filtered lines reach the DOM.
 *
 * Set to the signal buffer's own size on purpose: with proxied requests hidden
 * — the default — the matched set can never exceed it, so the cap does not bite
 * and the console never posts a truncation banner while holding the whole
 * buffer. It bites exactly when proxy lines are shown, which is the one time
 * truncation is honest and expected.
 */
export const LOG_RENDER_LIMIT = 500;

/**
 * How long a console with lines in it must go without a new matching line
 * before it reports itself quiet.
 *
 * A guess, and knowingly so — nothing measured argues for 60 s over 30 s or
 * 120 s. It only decides when a footer appears under content that is already
 * fully readable, so being wrong costs an operator nothing.
 */
export const QUIET_AFTER_MS = 60_000;

/** Throughput tile: the bar reads full at this many tokens per second. */
const THROUGHPUT_FULL_SCALE = 120;

const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: "var(--text-muted)",
  INFO: "var(--info)",
  WARN: "var(--warning)",
  ERROR: "var(--error)",
};

const LEVEL_FILTERS: LevelFilter[] = ["all", "INFO", "WARN", "ERROR"];

/**
 * The record-type chips. Four families and a reset, not the research's six:
 * proxied requests are already a toggle whose default is additive suppression
 * (which no member of a single-select set can express), and the launch-args
 * block is already a fold that collapses 31 rows to 1 without leaving the
 * scrollback.
 */
const FAMILY_FILTERS: FamilyFilter[] = ["any", "requests", "models", "startup", "other"];

/**
 * The literal the context-lost banner puts in the search box.
 *
 * A search, deliberately, and not a fourth filter axis: the token is in the
 * message text, the box visibly fills with it, the operator can edit or clear
 * it, and the existing count grammar reports the result honestly. It also
 * degrades perfectly — if llama.cpp renames the token, nothing matches, the
 * count is 0 and the banner never appears.
 */
export const CONTEXT_LOST_QUERY = "truncated = 1";

/**
 * How far apart two members of one trace may sit before they are two different
 * requests that happen to share an id.
 *
 * The measured maximum gap INSIDE a real request is 7 buffer lines (p99 = 5),
 * so 16 leaves better than a 2× margin over anything a genuine request has ever
 * produced while still catching a child that died and respawned on the same
 * ephemeral port a few seconds later — a reuse observed 20 lines apart, which a
 * wider threshold swallows whole and reports as one request.
 *
 * It errs toward splitting, and that is the right direction: a split trace
 * announces itself in the banner and shows the run that was clicked, while a
 * merged one silently presents two operators' requests as one.
 */
const TRACE_SPLIT_GAP = 16;

/** Shown wherever a reading the source could not supply would otherwise print. */
const NO_READING = "—";

function tint(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

/**
 * A KPI tile's value. The mock rounds its counters; a live source reports
 * whatever `llama-server` gave it, which can be fractional or missing, and
 * neither `61.837` nor `NaN` is something an operator can read at a glance.
 */
function countLabel(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value)) : NO_READING;
}

/** A memory gauge's label, or a dash when either figure is not a reading. */
function memoryLabel(usedGB: number, totalGB: number, decimals: number): string {
  return Number.isFinite(usedGB) && Number.isFinite(totalGB)
    ? formatMemory(usedGB, totalGB, decimals)
    : NO_READING;
}

/** One button in the SERVICE block's control row. */
export interface ServiceControlVm {
  action: ServiceAction;
  /** `Restart`, or the optimistic verb (`Restarting…`) while it is in flight. */
  label: string;
  /** True while this is the action awaiting its POST. */
  busy: boolean;
  disabled: boolean;
  /**
   * Why the button is inert (`The service is already started.`), or `""` when
   * it is not. Rendered as its title and folded into the accessible name, so
   * the reason is never left to the greyed-out fill alone.
   */
  disabledReason: string;
  /** True for the disruptive actions: the click opens the confirm strip. */
  confirms: boolean;
  /** Danger-toned (stop, restart). Never the only signal — the verb says it. */
  danger: boolean;
  /** `Restart the llama.cpp service` — the label alone is ambiguous out of context. */
  ariaLabel: string;
}

/** The inline confirm strip for a disruptive action. */
export interface ServiceConfirmVm {
  action: ServiceAction;
  /** `Restart unloads gpt-oss-20b and drops in-flight requests.` */
  consequence: string;
  /** The affirmative verb, e.g. `Restart`. */
  confirmLabel: string;
  confirmAriaLabel: string;
  cancelLabel: string;
}

/**
 * The drift notice — the one surface both drift producers write to.
 *
 * It exists only when something is actually wrong. A compliant machine renders
 * NOTHING here: no "all good" badge, no reassurance. That is the point of the
 * whole check — the dashboard's silence has to mean something, so it may never
 * be spent on a machine Steward could not verify (a `unknown` launch check is
 * silent too, and the operator is told nothing rather than told it is fine).
 */
export interface DriftNoticeVm {
  /**
   * Identity of this exact mismatch. A dismissal is bound to it, so dismissing
   * "`--metrics` removed" cannot also hide "`--slots` removed" arriving later:
   * the key changes and the notice comes back.
   */
  key: string;
  title: string;
  /** One line per thing that no longer matches; never empty. */
  messages: string[];
  /** What to do about it, in words, naming the command that does it. */
  fix: string;
  dismissLabel: string;
  /** Says out loud that dismissing does not make the mismatch go away. */
  dismissAriaLabel: string;
  /** The notice region's accessible name. */
  ariaLabel: string;
  /** The whole notice as one sentence, for the polite status region. */
  announcement: string;
}

/** The affordance shown in place of controls when none are configured. */
export interface ServiceSetupVm {
  label: string;
  /** Names the skill that configures control — the only way to get buttons. */
  detail: string;
  command: string;
}

export interface ServiceControlsVm {
  /** One per consented action, in start/stop/restart order. Empty = unconfigured. */
  buttons: ServiceControlVm[];
  /** The single setup affordance, present only when {@link buttons} is empty. */
  setup: ServiceSetupVm | null;
  /** The open confirm strip, or `null`. */
  confirm: ServiceConfirmVm | null;
  /** `Restart failed — launchctl: permission denied`, or `null`. */
  notice: string | null;
  /** True while any action is in flight: the whole row disables and reads busy. */
  pending: boolean;
}

export interface ServiceVm {
  running: boolean;
  /** `started` / `stopped` — the monitor-only status indicator's text. */
  statusLabel: string;
  /** The dot and label color: success when up, error when down. */
  statusColor: string;
  /** The indicator's tinted fill and border, matching the state color. */
  statusTint: string;
  statusBorder: string;
  /** The theme control's current-state glyph: `◐` system, `☀` light, `☾` dark. */
  themeGlyph: string;
  themeLabel: string;
  /** The start/stop/restart row, its confirm strip, and any failure notice. */
  controls: ServiceControlsVm;
  /**
   * The config-drift notice, or `null` when there is nothing to report (or the
   * operator dismissed this exact one). It lives in this block because this is
   * where the router facts `steward.json` claims are rendered — the notice says
   * those facts have stopped being true.
   */
  drift: DriftNoticeVm | null;
  /**
   * The router facts (role, binary, listen, …) folded in from what was the
   * separate CONFIG block. They render below the status as this block's third
   * zone, sourced from `/props` so the listen address and build have one home.
   */
  config: ConfigEntry[];
}

export interface GaugeVm {
  key: string;
  label: string;
  value: string;
  percent: number;
  color: string;
  /**
   * How the bar's track is drawn, so an empty bar cannot be mistaken for a real
   * reading. `solid` is a genuine figure (INCLUDING a real 0%); `hatched` means
   * "no reading" — the value dashed to `—` because a memory figure was `null`
   * or `NaN`; `dashed` is reserved for a future "last-seen" state and is not
   * produced yet. The value token (`—`) is the primary signal; the track
   * reinforces it, and is never color-only.
   */
  track: "solid" | "hatched" | "dashed";
}

/**
 * One labeled cell of a model card's body grid: `Quant: 4-bit (Q4_0)`. The label
 * set and order are identical on every card; only the values change. `na` is set
 * when the value is the {@link NA} token, so the UI can dim an unconfirmed field
 * without re-parsing the string.
 */
export interface ModelFieldVm {
  label: string;
  value: string;
  na: boolean;
}

export interface ModelCardVm {
  id: string;
  short: string;
  /**
   * The card body: the same seven labeled fields on every card, in a fixed order
   * (`Type` last), each carrying its value or the `n/a` token when the fact is
   * not confirmed. Only `Type` is ever confirmed while unloaded.
   */
  fields: ModelFieldVm[];
  color: string;
  selected: boolean;
  cardBackground: string;
  cardBorder: string;
  buttonAction: ModelAction;
  buttonLabel: string;
  buttonBackground: string;
  buttonColor: string;
  buttonBorder: string;
  pending: boolean;
}

export interface PillVm {
  label: string;
  active: boolean;
  background: string;
  color: string;
  borderColor: string;
}

export interface KpiVm {
  key: string;
  label: string;
  value: string;
  unit: string;
  sub: string;
  color: string;
  percent: number;
}

export interface SparkBarVm {
  height: number;
  color: string;
}

export interface SparkVm {
  bars: SparkBarVm[];
  /** `avg 61 · peak 98 tok/s` */
  summary: string;
  /** Height of the dashed average rule, in percent of the plot area. */
  averageLine: number;
}

export interface LevelChipVm extends PillVm {
  level: LevelFilter;
  /**
   * How many lines this chip would show — every OTHER filter applied and this
   * one lifted. So the number is a promise, and an empty ERROR chip is visibly
   * empty BEFORE it is pressed rather than after.
   *
   * A zero is never styled as reassurance: llama-server logs nothing at all for
   * a rejected request and reports a failed model load at INFO, so `ERROR 0` is
   * a fact about the file, not a health check.
   */
  count: number;
  countLabel: string;
  /** `WARN — 2 lines`, so the count is not left to a bare numeral. */
  ariaLabel: string;
}

/** How a row's model column is attributed. */
export type LineScope = "model" | "router" | "unknown";

/** The collapsed launch-argument block, rendered as one expandable row. */
export interface FoldVm {
  /** `seq` of the run's first line — the toggle key and the fold's identity. */
  seq: number;
  /** Lines in the run actually held, which is what the label counts. */
  count: number;
  /** Open right now, whether the operator asked or a query hit forced it. */
  expanded: boolean;
  /** The operator's own setting — what the fold returns to once a query clears. */
  sticky: boolean;
  /** The run reaches the front of the window, so older members may be gone. */
  truncated: boolean;
  /** Hits inside the fold for the active query; 0 when there is no query. */
  matches: number;
  /** True when a query hit forced it open, overriding the collapsed state. */
  forced: boolean;
  /** `▸ 31 launch arguments`, plus the truncation and match clauses. */
  label: string;
  /** The glyph is silence to a screen reader, so the name says the verb. */
  ariaLabel: string;
}

/**
 * The task cell — a control, not a readout. `null` on an unframed line, on a
 * line whose port Steward never saw, and on `get_availabl` (task `-1`: no task
 * is attached yet, and inventing one would be the first mis-attribution in a
 * console built to avoid exactly that).
 */
export interface TaskCellVm {
  port: number;
  task: number;
  /** Stable identity for focus restoration across a repaint. */
  key: string;
  /** `▸81259` collapsed, `▾81259` while this task is being traced. */
  label: string;
  /**
   * Says what a task id IS, which the numeral cannot: llama-server's own handle
   * for the request, sparse, reused across children and not a request number.
   */
  ariaLabel: string;
  /** True while this row's task is the one being traced. */
  active: boolean;
}

/**
 * A trailing annotation on a row's message.
 *
 * Trailing, not leading: a leading badge shifts the message's left edge per row
 * and breaks the column rhythm that makes a log scannable. Severity is carried
 * in FORM — a glyph and a tinted ground with the text at full contrast — never
 * by an amber that is 2.16:1 on the light theme's console ground.
 */
export interface LogBadgeVm {
  key: "context-lost" | "cache" | "slot";
  label: string;
  title: string;
  tone: "warn" | "neutral";
}

export interface LogRowVm {
  /**
   * Row identity for the incremental patcher. A fold row and the first line of
   * its run share a `seq`, so `seq` alone cannot key the DOM: toggling a fold
   * would patch a `<button>`'s text into a `<div>` and leave the wrong element
   * on screen.
   */
  key: string;
  seq: number;
  time: string;
  level: LogLevel;
  model: string;
  modelColor: string;
  /** Why the model cell reads what it does, or `""` for a plain model name. */
  modelTitle: string;
  scope: LineScope;
  kind: LogKind;
  /** The trace entry point, or `null` when this row has no task to trace. */
  task: TaskCellVm | null;
  /**
   * The pipe frame this row's task cell stands in for, or `""`. Carried so an
   * export can write the file's own line back; never painted.
   */
  frameRaw: string;
  message: string;
  /** Absent enrichments render NOTHING — not an empty box, not a dash. */
  badges: LogBadgeVm[];
  /** True while this row is part of the open trace. */
  traced: boolean;
  /** True for a line rendered inside an expanded fold. */
  folded: boolean;
  /** Non-null only on the fold row itself. */
  fold: FoldVm | null;
}

/** The toolbar's proxied-request toggle. */
export interface ProxyToggleVm {
  /** `▸ 1,203 proxied` / `▸ proxied` / `▾ proxied shown`. */
  label: string;
  /** Tracks SHOWN, so pressed means the extra lines are in. */
  pressed: boolean;
  /** Says what the chip has no room for: why these are hidden by default. */
  ariaLabel: string;
  title: string;
}

/** One record-type chip. The same component as a level chip, a different axis. */
export interface FamilyChipVm extends PillVm {
  family: FamilyFilter;
  /** What pressing it yields — every OTHER filter applied and this axis lifted. */
  count: number;
  countLabel: string;
  ariaLabel: string;
}

export interface ToolbarVm {
  activeModelLabel: string;
  activeModelBackground: string;
  activeModelColor: string;
  familyChips: FamilyChipVm[];
  levelChips: LevelChipVm[];
  proxyToggle: ProxyToggleVm;
  query: string;
  lineCountLabel: string;
  paused: boolean;
  pauseLabel: string;
  pauseBackground: string;
  pauseColor: string;
  pauseBorder: string;
  copyLabel: string;
}

/** Everything the console and toolbar count, in one place. */
export interface LogCountsVm {
  /** Lines in the painted window — never more than {@link LOG_RENDER_LIMIT}. */
  rendered: number;
  /** Lines passing the whole filter stack, before the render cap. */
  matched: number;
  /** Lines in the buffer the console is reading (frozen while paused). */
  buffered: number;
  /**
   * Lines excluded ONLY by the proxy toggle — already past the model scope, the
   * level chip and the query. That makes the number a promise: this many more
   * rows appear if the toggle is pressed.
   */
  hiddenProxy: number;
  /** Proxy lines currently shown, for the toggle's pressed-state name. */
  proxyShown: number;
  /** Router-wide lines an active model scope suppressed. */
  hiddenRouter: number;
  /** Matching lines that live inside an args fold, expanded or not. */
  folded: number;
  /** The buffer has evicted at least one signal line this session. */
  bufferDropped: boolean;
  /** The render cap bit: {@link matched} exceeds {@link LOG_RENDER_LIMIT}. */
  renderCapped: boolean;
  /** Per-chip counts, each with the other filters applied and its own lifted. */
  levels: Record<LevelFilter, number>;
  /** The same promise on the second axis. */
  families: Record<FamilyFilter, number>;
  /**
   * Matched lines carrying a pipe frame. Drives the task column's existence —
   * over the MATCHED SET, not the painted window, so it flips at most once per
   * session instead of on every scroll.
   */
  framed: number;
  /**
   * Buffered lines that said `truncated = 1`. Counted over the buffer, not the
   * matched set, because the banner it drives says "of the N buffered" and the
   * two numbers have to be about the same population.
   */
  contextLost: number;
  /** Lines in the open trace, or 0 when nothing is being traced. */
  traced: number;
}

/**
 * Which single truth the console is telling, first match wins. The order is
 * load-bearing: `empty-filtered` precedes `cold` so a filter that excludes
 * everything cannot masquerade as a cold start, and `paused` precedes `quiet`
 * because a frozen buffer necessarily goes stale and calling that "quiet" would
 * be a lie about the router.
 */
export type ConsoleState =
  | "no-source"
  | "file-missing"
  | "reconnecting"
  | "stopped"
  | "paused"
  // A trace outranks `empty-filtered` — it ignores the filters, so a filter
  // that matches nothing says nothing about what a trace is showing — but not
  // the four source-health states, which are facts about the source itself.
  | "tracing"
  | "empty-filtered"
  | "cold"
  | "quiet"
  | "streaming";

export type ConsoleTone = "info" | "warn" | "muted" | "trace";

/** What a notice or banner offers to do about itself. */
export interface ConsoleActionVm {
  label: string;
  kind: "clear-filters" | "show-all-models" | "exit-trace" | "query-truncated";
  ariaLabel: string;
}

/** The full-height notice that takes the place of rows (or sits above them). */
export interface ConsoleNoticeVm {
  state: ConsoleState;
  /** Decoration. Never load-bearing — the title carries the meaning. */
  glyph: string;
  title: string;
  detail: string;
  tone: ConsoleTone;
  action: ConsoleActionVm | null;
}

/** A strip that coexists with rows, at the top or the bottom of the console. */
export interface ConsoleBannerVm {
  key: string;
  placement: "top" | "bottom";
  tone: ConsoleTone;
  text: string;
  /** Extra sentences under the strip, or `""` when the strip says it all. */
  detail: string;
  action: ConsoleActionVm | null;
}

/** The open trace, as its banner renders it. */
export interface TraceVm {
  port: number;
  task: number;
  /**
   * The model, from the port map. `""` when the port is unmapped — never
   * invented, and never read off the neighbouring `proxy_reques` line, which is
   * the only line that names a model and carries no task id.
   */
  modelLabel: string;
  count: number;
  /** `▾ tracing task 81259 · port 53691 · gpt-oss-20b · 9 lines`, plus guards. */
  title: string;
  /** The sentences that answer "what IS a task id", said where it matters. */
  detail: string;
  backLabel: string;
  backAriaLabel: string;
  /** The earliest member sits at the front of a buffer that has dropped lines. */
  partial: boolean;
  /** The port was reused and another request shares this id; only one is shown. */
  splitRuns: boolean;
}

export interface ConsoleVm {
  state: ConsoleState;
  lines: LogRowVm[];
  notice: ConsoleNoticeVm | null;
  banners: ConsoleBannerVm[];
  paused: boolean;
  /** The open trace, or `null`. */
  trace: TraceVm | null;
  /**
   * Whether the row grid carries a task column at all. False collapses it —
   * an idle router showing eleven banner lines gets the original four-column
   * grid back, not 64px of dead space.
   */
  showTaskColumn: boolean;
  /** Lines that arrived behind a frozen buffer, so Pause can say what it costs. */
  frozenBehind: number;
  /** The visually-hidden heading inside the region. */
  heading: string;
}

export interface SlotDotVm {
  id: number;
  /**
   * `unknown` where the lane's occupancy was never established — a child that
   * has only just spawned, or a stream Steward lost track of. It is not a
   * synonym for idle and must never be rendered as one.
   */
  state: SlotState;
  /**
   * Context fill, 0–100, for a mini bar: `promptTokens / ctxTotal`. `null` when
   * either half is unmeasured, so nothing draws an empty bar for a lane whose
   * fill nobody reported.
   */
  headroomPct: number | null;
  /** `27 / 40k ctx · 5 decoded`, `40k ctx · idle`, or `40k ctx · state unknown`. */
  detail: string;
}

export interface SlotGroupVm {
  modelId: string;
  /** The model's short name. */
  modelLabel: string;
  modelColor: string;
  /** Slots in this group that are processing. */
  busy: number;
  /** Slots in this group whose occupancy could not be established. */
  unknown: number;
  /** Slots in this group. */
  total: number;
  /** `2/4 busy`, plus ` · 1 unknown` when a lane could not be spoken for. */
  summary: string;
  /** `63 t/s` while the model is generating; `""` when idle or the rate is unknown. */
  rateLabel: string;
  /**
   * The busiest lane's context fill, 0–100 — the group's overflow signal — or
   * `null` when no lane reported one.
   */
  peakPct: number | null;
  /**
   * `61%`, the peak as a label, or `""` when there is no peak to show. Shown
   * only on a busy chip; the number is never color-only.
   */
  peakLabel: string;
  /** Threshold color for {@link peakLabel}: tertiary, then warning, then error. */
  peakColor: string;
  slots: SlotDotVm[];
}

export interface SlotsVm {
  /** One group per loaded model, in models order. */
  groups: SlotGroupVm[];
  /** True when no model is loaded (no groups). */
  empty: boolean;
  emptyLabel: string;
  /** `3 of 8 busy · peak 92% ctx`; the peak clause is dropped when nothing is busy. */
  totalSummary: string;
}

export interface DashboardVm {
  service: ServiceVm;
  gauges: GaugeVm[];
  models: ModelCardVm[];
  allLogsPill: PillVm;
  kpis: KpiVm[];
  spark: SparkVm;
  toolbar: ToolbarVm;
  console: ConsoleVm;
  logCounts: LogCountsVm;
  /**
   * Every matching buffered line, folds expanded, with no render cap — what
   * Copy and Download write out. Deliberately NOT the painted rows: those stop
   * at {@link LOG_RENDER_LIMIT} and hide the launch arguments behind a fold,
   * which is the single most likely thing an operator is copying.
   */
  exportLines: LogRowVm[];
  slots: SlotsVm;
}

/** The button verb for each action, and its in-flight form. */
const SERVICE_LABELS: Record<ServiceAction, string> = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
};
const SERVICE_BUSY_LABELS: Record<ServiceAction, string> = {
  start: "Starting…",
  stop: "Stopping…",
  restart: "Restarting…",
};

/** The order the control row renders, whatever order the source listed them in. */
const SERVICE_ACTION_ORDER: readonly ServiceAction[] = ["start", "stop", "restart"];

/** `a`, `a and b`, `a, b and c` — never a bare comma list. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What a disruptive action will actually cost, naming the real models that are
 * loaded right now. Vague warnings get clicked through; "Restart unloads
 * gpt-oss-20b and drops in-flight requests" does not. With nothing loaded there
 * is no model to name and the strip says so rather than inventing a stake.
 */
function serviceConsequence(action: ServiceAction, snapshot: Snapshot): string {
  const verb = SERVICE_LABELS[action];
  const loaded = snapshot.models
    .filter((model) => model.status === "active" || model.status === "resident")
    .map((model) => model.short);

  if (loaded.length === 0) {
    return `${verb} drops any in-flight requests. No model is loaded right now.`;
  }
  // The comma before "and drops" keeps the two clauses apart once the model
  // list itself contains an "and".
  const separator = loaded.length > 1 ? "," : "";
  return `${verb} unloads ${joinNames(loaded)}${separator} and drops in-flight requests.`;
}

/**
 * The SERVICE control row.
 *
 * Which actions exist is config, not a guess: the snapshot carries exactly the
 * actions `steward.json` declares a consented command for. None configured is
 * its own state — one setup affordance naming `/initialize-steward`, never
 * three dead buttons that would 400 if pressed. An action that cannot apply
 * right now (starting a started service) disables WITH a reason, so the
 * greyed-out fill is never the only thing carrying it.
 */
function selectServiceControls(snapshot: Snapshot, ui: UiState): ServiceControlsVm {
  const running = snapshot.service.running;
  const pending = ui.pendingService !== null;
  const available = SERVICE_ACTION_ORDER.filter((action) =>
    snapshot.service.controls.includes(action),
  );

  const buttons: ServiceControlVm[] = available.map((action) => {
    const busy = ui.pendingService === action;
    // Restart stays live while stopped — it is the one command a machine that
    // only consented to `restart` has, and launchd/systemd both start from it.
    const reason =
      running && action === "start"
        ? "The service is already started."
        : !running && action === "stop"
          ? "The service is already stopped."
          : "";
    const label = busy ? SERVICE_BUSY_LABELS[action] : SERVICE_LABELS[action];
    return {
      action,
      label,
      busy,
      disabled: pending || reason !== "",
      disabledReason: reason,
      confirms: action !== "start",
      danger: action !== "start",
      ariaLabel:
        reason === ""
          ? `${label} the llama.cpp service`
          : `${label} the llama.cpp service. ${reason}`,
    };
  });

  // The strip stands only while its own button would still act. Anything that
  // disables that button — a poll showing the service already stopped, an
  // action going out, the config dropping the command — closes the strip too,
  // so it can never sit there stating a consequence that has become false
  // ("unloads gpt-oss-20b" after the service died on its own) over an Accept
  // that would still POST.
  const opener = buttons.find((button) => button.action === ui.confirmService);
  const confirming = opener !== undefined && !opener.disabled ? opener.action : null;

  const failure = ui.serviceFailure;
  return {
    buttons,
    setup:
      buttons.length > 0
        ? null
        : {
            label: "Service control is not set up.",
            detail:
              "Steward runs only the start, stop and restart commands this machine has declared and you have approved.",
            command: "/initialize-steward",
          },
    confirm:
      confirming === null
        ? null
        : {
            action: confirming,
            consequence: serviceConsequence(confirming, snapshot),
            confirmLabel: SERVICE_LABELS[confirming],
            confirmAriaLabel: `Confirm: ${SERVICE_LABELS[confirming].toLowerCase()} the llama.cpp service`,
            cancelLabel: "Cancel",
          },
    // The command's own words, not a paraphrase: "permission denied" tells the
    // operator what to fix, where "something went wrong" tells them nothing.
    notice:
      failure === null
        ? null
        : failure.detail === null || failure.detail === ""
          ? `${SERVICE_LABELS[failure.action]} failed.`
          : `${SERVICE_LABELS[failure.action]} failed — ${failure.detail}`,
    pending,
  };
}

/** How many flag groups a notice names before it summarises the rest. */
const DRIFT_LIST_LIMIT = 3;

/** The Pi command that re-detects this machine and rewrites `steward.json`. */
const SETUP_COMMAND = "/initialize-steward";

/** Human-readable action names for the consent-drift sentence. */
const CONTROL_NAMES: Record<ServiceAction, string> = {
  start: "start",
  stop: "stop",
  restart: "restart",
};

/** `--metrics and --slots`, or `--a, --b, --c and 4 more` past the limit. */
function driftList(groups: readonly string[]): string {
  if (groups.length <= DRIFT_LIST_LIMIT) return joinNames([...groups]);
  const head = groups.slice(0, DRIFT_LIST_LIMIT).join(", ");
  return `${head} and ${groups.length - DRIFT_LIST_LIMIT} more`;
}

/**
 * The launch-argv half of the notice: one line naming exactly what changed.
 * Only a `drifted` verdict speaks. `clean` says nothing (a compliant machine is
 * not nagged), and `unknown` says nothing either — Steward could not check, so
 * it has nothing to report and does not pretend otherwise.
 */
function launchDriftMessages(launch: LaunchDrift): string[] {
  if (launch.status !== "drifted") return [];
  const messages: string[] = [];
  const changes: string[] = [];
  if (launch.removed.length > 0) changes.push(`${driftList(launch.removed)} removed`);
  if (launch.added.length > 0) changes.push(`${driftList(launch.added)} added`);
  if (changes.length > 0) {
    messages.push(`Launch flags changed since setup: ${changes.join(", ")}.`);
  }
  if (launch.program !== null) {
    // Spelled out rather than arrowed: an arrow glyph is silence to a screen
    // reader, and this line is the whole content of the alert.
    messages.push(
      `The server binary changed since setup: it was ${launch.program.recorded}, and is now ${launch.program.observed}.`,
    );
  }
  return messages;
}

/**
 * The consent half: a command `steward.json` declares that the operator has not
 * approved. Steward refusing to run it is the gate working as designed — but an
 * inert panel with no explanation looks exactly like one that was never set up,
 * so the reason is said out loud.
 */
function consentDriftMessages(consent: ConsentDrift): string[] {
  const messages: string[] = [];
  if (consent.hostCollector) {
    messages.push(
      "The host-metrics collector is declared but not approved, so no host readings are being collected.",
    );
  }
  if (consent.controls.length > 0) {
    const names = consent.controls.map((action) => CONTROL_NAMES[action]);
    messages.push(
      names.length === 1
        ? `The ${names[0]} command is declared but not approved, so it is not offered.`
        : `The ${joinNames(names)} commands are declared but not approved, so they are not offered.`,
    );
  }
  return messages;
}

/**
 * The drift notice, or `null` when there is nothing honest to say.
 *
 * Dismissal is bound to {@link DriftNoticeVm.key} and lives in memory only: the
 * notice returns on the next reload, and immediately if what drifted changes.
 * A mismatch that is still there must never be hidden by a click the operator
 * made ten minutes ago — the whole feature is a promise that silence means
 * compliance.
 */
function selectDrift(snapshot: Snapshot, ui: UiState): DriftNoticeVm | null {
  const { launch, consent } = snapshot.drift;
  const messages = [...launchDriftMessages(launch), ...consentDriftMessages(consent)];
  if (messages.length === 0) return null;

  const key = [
    launch.status === "drifted"
      ? `launch:-${launch.removed.join("\u0000")}:+${launch.added.join("\u0000")}:${
          launch.program === null ? "" : launch.program.observed
        }`
      : "",
    consent.hostCollector ? "collector" : "",
    consent.controls.length > 0 ? `controls:${consent.controls.join(",")}` : "",
  ].join("|");
  if (ui.dismissedDrift === key) return null;

  const fix = `Re-run ${SETUP_COMMAND} to re-detect this machine.`;
  return {
    key,
    title: "Configuration drift",
    messages,
    fix,
    dismissLabel: "Dismiss",
    dismissAriaLabel:
      "Dismiss the configuration drift notice. It returns while the mismatch is still there.",
    ariaLabel: "Configuration drift",
    announcement: `Configuration drift. ${messages.join(" ")} ${fix}`,
  };
}

/** What the polite status region should say about drift, and the new watermark. */
export interface DriftAnnouncement {
  /** The sentence to announce, or `null` when nothing has changed. */
  message: string | null;
  /** The key to remember, so the same notice is not announced twice. */
  key: string | null;
}

/**
 * Decides whether a drift notice is worth announcing.
 *
 * The snapshot poll runs every 1.6 s and drift persists across all of them, so
 * announcing per repaint would turn a screen reader into a metronome. The notice
 * is announced when it is NEW — a different mismatch, or the first one after a
 * clean stretch — and stays silent otherwise. Losing the notice resets the
 * watermark, so a mismatch that returns is announced again.
 */
export function driftAnnouncement(
  notice: DriftNoticeVm | null,
  lastKey: string | null,
): DriftAnnouncement {
  if (notice === null) return { message: null, key: null };
  if (notice.key === lastKey) return { message: null, key: lastKey };
  return { message: notice.announcement, key: notice.key };
}

function selectService(snapshot: Snapshot, ui: UiState): ServiceVm {
  const { service } = snapshot;
  const running = service.running;
  const color = running ? "var(--success)" : "var(--error)";
  // The glyph reports the current mode, not the destination — with three states
  // "next" is ambiguous — and the label names both so the change is announced.
  const themeGlyph = ui.theme === "system" ? "◐" : ui.theme === "light" ? "☀" : "☾";
  const themeLabel =
    ui.theme === "system"
      ? "Theme: System (matches your OS). Switch to light."
      : ui.theme === "light"
        ? "Theme: Light. Switch to dark."
        : "Theme: Dark. Switch to system.";

  return {
    running,
    statusLabel: running ? "started" : "stopped",
    statusColor: color,
    statusTint: tint(color, 14),
    statusBorder: tint(color, 40),
    themeGlyph,
    themeLabel,
    controls: selectServiceControls(snapshot, ui),
    drift: selectDrift(snapshot, ui),
    config: snapshot.config,
  };
}

/**
 * A memory gauge (VRAM, RAM, or Unified). `solid` when both figures are real,
 * else the value dashes and the track hatches — an empty bar for a reading the
 * host could not supply, told apart from a genuine 0%.
 */
function memoryGauge(
  key: string,
  label: string,
  usedGB: number,
  totalGB: number,
  decimals: number,
  color: string,
): GaugeVm {
  const read = Number.isFinite(usedGB) && Number.isFinite(totalGB);
  return {
    key,
    label,
    value: memoryLabel(usedGB, totalGB, decimals),
    percent: barPercent(totalGB === 0 ? 0 : usedGB / totalGB),
    color,
    track: read ? "solid" : "hatched",
  };
}

/**
 * A utilisation gauge (GPU, CPU). A real 0% is a reading and stays `solid`; only
 * a non-finite figure the source could not supply hatches.
 */
function utilGauge(key: string, label: string, util: number, color: string): GaugeVm {
  return {
    key,
    label,
    value: formatPercent(util),
    percent: barPercent(util),
    color,
    track: Number.isFinite(util) ? "solid" : "hatched",
  };
}

/**
 * A temperature gauge. Only ever built from a finite reading, so always solid.
 *
 * The unit reaches the LABEL and nothing else: the bar's position and the
 * threshold color are computed from the Celsius reading whichever unit is on
 * screen, so switching units moves the text and moves nothing else.
 */
function tempGauge(key: string, label: string, celsius: number, unit: TemperatureUnit): GaugeVm {
  return {
    key,
    label,
    value: formatTemperature(celsius, unit),
    percent: temperatureBarPercent(celsius),
    color: temperatureColor(celsius),
    track: "solid",
  };
}

/**
 * The HOST block's gauge set, laid out for the machine's memory topology. A
 * `discrete` box shows the VRAM+RAM pair; a `unified` one (Apple Silicon) shares
 * one pool and cannot read a VRAM total — so it shows a single Unified RAM gauge
 * and NEVER an invented VRAM ceiling. Both share the GPU/CPU util and temperature
 * rows.
 *
 * The temperature rows are labelled in `ui.temperatureUnit` — the operator's
 * browser region, resolved before it got here. It is a labelling choice only;
 * nothing about which gauges exist, or where their bars sit, depends on it.
 */
function selectGauges(snapshot: Snapshot, ui: UiState): GaugeVm[] {
  const m = snapshot.metrics;
  const gauges: GaugeVm[] =
    snapshot.memoryTopology === "unified"
      ? // Unified memory takes the place of the VRAM+RAM pair; there is no
        // separate VRAM figure to show, so no VRAM gauge is built at all.
        [
          memoryGauge(
            "unified-memory",
            "Unified RAM",
            m.ramUsedGB,
            m.ramTotalGB,
            1,
            "var(--latte-teal)",
          ),
        ]
      : [memoryGauge("vram", "VRAM", m.vramUsedGB, m.vramTotalGB, 1, "var(--latte-teal)")];

  gauges.push(utilGauge("gpu", "GPU", m.gpuUtil, "var(--latte-mauve)"));

  // Temperatures come from host sensors, not llama.cpp. Where the platform
  // cannot supply them the design drops the row rather than plotting a zero,
  // and a reading that is not a number is no more of a reading than `null`.
  if (m.gpuTempC !== null && Number.isFinite(m.gpuTempC)) {
    gauges.push(tempGauge("gpu-temp", "GPU temp", m.gpuTempC, ui.temperatureUnit));
  }

  // Discrete machines carry a separate RAM gauge after the temps; unified
  // machines already accounted for RAM in the single Unified RAM gauge.
  if (snapshot.memoryTopology === "discrete") {
    gauges.push(memoryGauge("ram", "RAM", m.ramUsedGB, m.ramTotalGB, 0, "var(--accent)"));
  }

  gauges.push(utilGauge("cpu", "CPU", m.cpuUtil, "var(--latte-peach)"));

  if (m.cpuTempC !== null && Number.isFinite(m.cpuTempC)) {
    gauges.push(tempGauge("cpu-temp", "CPU temp", m.cpuTempC, ui.temperatureUnit));
  }
  return gauges;
}

function selectModels(snapshot: Snapshot, ui: UiState): ModelCardVm[] {
  return snapshot.models.map((model) => {
    const color = modelColor(model.id, model.embedding);
    const selected = ui.filterModel === model.id;
    const loaded = model.status !== "unloaded";
    const pendingAction = ui.pendingModels[model.id];
    // The card shows the loading state whenever the model is mid-transition,
    // whether this operator started it (a local pending flag) or the polled
    // status arrived already `loading`/`downloading` (someone else did).
    const statusPending = model.status === "loading" || model.status === "downloading";

    // A model's facts — quant, size, context, tuning — are only known for
    // certain once it is loaded and reporting them; before that they are
    // inference (a filename) or intent (launch args), not confirmed, so every
    // field but `Type` reads `n/a` and every unloaded card reads the same. The
    // type is confirmed even unloaded (the router reports the modalities), so it
    // always carries a real value.
    const confirmed = model.status === "active" || model.status === "resident";

    // The card body: a fixed label set in a fixed order (`Type` last). `na`
    // rides along so the view can dim a field without re-reading its string.
    const fields: ModelFieldVm[] = [
      { label: "Quant", value: formatQuantField(model.quant, confirmed) },
      { label: "Size", value: formatSizeField(model.sizeGB, confirmed) },
      { label: "Context", value: formatContextField(model.ctx, confirmed) },
      { label: "GPU Layers", value: formatGpuLayersField(model.gpuLayers, confirmed) },
      { label: "Flash", value: formatFlashField(model.flashAttn, confirmed) },
      { label: "KV Cache", value: formatKvCacheField(model.kvCache, confirmed) },
      { label: "Type", value: formatTypeField(model.embedding) },
    ].map((f) => ({ ...f, na: f.value === NA }));

    return {
      id: model.id,
      short: model.short,
      fields,
      color,
      selected,
      cardBackground: selected ? tint(color, 10) : "var(--surface-page)",
      cardBorder: selected ? tint(color, 50) : "var(--border)",
      buttonAction: loaded ? "unload" : "load",
      // The button is the only place a transition is announced (the header says
      // nothing now). It distinguishes a download — which pulls weights over the
      // network and can run minutes — from a load into VRAM, since the wait is so
      // different; an operator-started action shows its optimistic verb first.
      buttonLabel:
        pendingAction === "unload"
          ? "Unloading…"
          : model.status === "downloading"
            ? "Downloading…"
            : pendingAction === "load" || statusPending
              ? "Loading…"
              : loaded
                ? "Unload"
                : "Load",
      buttonBackground: loaded ? "var(--surface-page)" : "var(--accent)",
      buttonColor: loaded ? "var(--error)" : "var(--accent-fg)",
      buttonBorder: loaded ? tint("var(--error)", 40) : "var(--accent)",
      pending: pendingAction !== undefined || statusPending,
    };
  });
}

function selectKpis(snapshot: Snapshot, now: number): KpiVm[] {
  const { service } = snapshot;
  const running = service.running;
  const uptime = service.startedAt === null ? "—" : formatUptime(now - service.startedAt);
  // Port lives in the `address` fact now (the Steward block); the tile owns
  // uptime and pid, so it does not repeat the port.
  const pid = service.pid === null ? "no process" : `pid ${service.pid}`;

  // The requests tile reports live counts (in flight, queued) — llama.cpp has
  // no request-rate metric. The bar fills as the slots fill.
  //
  // Either figure can be genuinely unavailable, and each for its own reason. In
  // flight is `null` when a slot's occupancy is unknown, so the true count can
  // only be bounded below. Queued has no log line behind it at all, so a Steward
  // reading occupancy from the log — which is every Steward with a log source —
  // simply cannot know it. Both print a dash and neither prints a `0`, because
  // "none" and "we cannot tell" are the two answers an operator most needs to
  // tell apart on this tile.
  const inFlight = running ? snapshot.requestsInFlight : 0;
  const queued = running ? snapshot.requestsQueued : 0;
  const slotTotal = snapshot.slots.length;
  const requestsFill =
    inFlight === null ? 0 : slotTotal > 0 ? inFlight / slotTotal : inFlight > 0 ? 1 : 0;
  const throughput = running ? snapshot.throughputTps : 0;

  return [
    {
      key: "service",
      label: "service",
      value: running ? uptime : "stopped",
      unit: running ? "uptime" : "",
      sub: running ? pid : "no process",
      color: running ? "var(--success)" : "var(--error)",
      percent: running ? 100 : 0,
    },
    {
      key: "requests",
      label: "requests",
      value: inFlight === null ? NO_READING : String(inFlight),
      unit: "in flight",
      sub: queued === null ? "queued n/a" : `${queued} queued`,
      color: "var(--accent)",
      percent: barPercent(requestsFill),
    },
    {
      key: "throughput",
      label: "throughput",
      // A dash here means a slot is working and no rate reading covers it yet,
      // which is a different thing from `0` — and `0` is what an idle server
      // honestly reads, so the two must not share a glyph.
      value: throughput === null ? NO_READING : countLabel(throughput),
      unit: "tok/s",
      sub: "generation, all slots",
      color: "var(--latte-mauve)",
      percent: barPercent((throughput ?? 0) / THROUGHPUT_FULL_SCALE),
    },
  ];
}

function selectSpark(snapshot: Snapshot): SparkVm {
  const samples = snapshot.throughputHistory;
  // Bars are plotted against the window's own peak, not a fixed ceiling, so a
  // quiet two minutes still shows shape instead of a flat line at the bottom.
  const peak = samples.reduce((hi, v) => Math.max(hi, v), 1);
  const average =
    samples.length === 0 ? 0 : samples.reduce((total, v) => total + v, 0) / samples.length;
  const newest = samples.length - 1;

  return {
    bars: samples.map((value, index) => ({
      height: barPercent(value / peak),
      color: index === newest ? "var(--accent)" : tint("var(--accent)", 38),
    })),
    summary: `avg ${Math.round(average)} · peak ${Math.round(peak)} tok/s`,
    averageLine: barPercent(average / peak),
  };
}

/**
 * Who wrote a line, from the operator's point of view.
 *
 * A missing `origin` means the source predates the field, and every measured
 * unattributed line was router-wide — so an unattributed line defaults to
 * `router`, and the dash is reserved for a source that positively says a CHILD
 * wrote it and Steward still could not name the model. Those are two different
 * facts and the console must not spend one glyph on both.
 */
function lineScope(line: LogLine): LineScope {
  if (line.modelId !== null) return "model";
  return line.origin === "child" ? "unknown" : "router";
}

const ROUTER_TITLE = "router-wide — this line is not about any one model";
const UNKNOWN_TITLE =
  "model unknown — this line came from a child process on a port Steward has not mapped yet";

/**
 * One line after the model scope, with every filter axis staged as a boolean.
 *
 * Staging them rather than applying them in sequence is what makes two axes of
 * honest chip counts possible: one walk over the grouped set can lift any one
 * axis and leave the rest applied, which is exactly what a chip's number
 * promises.
 */
interface StagedLine {
  line: LogLine;
  scope: LineScope;
  kind: LogKind;
  family: LogFamily;
  /** True when the active query matches, or when there is no query. */
  hit: boolean;
  /** False only for a proxy line while the toggle is off. */
  shown: boolean;
  /** Passes the level chip as it is set right now. */
  levelPass: boolean;
  /** Passes the record-type chip as it is set right now. */
  familyPass: boolean;
  /** `seq` of the args run this belongs to, or `null` for a standalone line. */
  runId: number | null;
}

/** A line that survived the whole filter stack, with its fold membership. */
interface KeptLine {
  line: LogLine;
  scope: LineScope;
  kind: LogKind;
  /** `seq` of the args run this belongs to, or `null` for a standalone line. */
  runId: number | null;
  hit: boolean;
  /** True while this row belongs to the open trace. */
  traced: boolean;
}

/** The text a query is matched against: the file's line, frame included. */
function lineText(line: LogLine): string {
  return `${line.frame?.raw ?? ""}${line.message}`;
}

/** The trace key, composed at the call site rather than stored on the record. */
export function taskKey(port: number, task: number): string {
  return `${port}:${task}`;
}

/** Everything one pass over the buffer produces. */
interface LogSelection {
  rows: LogRowVm[];
  /** The open trace's membership and guards, or `null`. */
  trace: TraceSelection | null;
  exportLines: LogRowVm[];
  counts: LogCountsVm;
  /** Arrival stamp of the newest matching line, or `null` when none match. */
  newestMatchedAt: number | null;
  /**
   * Arrival stamp of the newest line in the BUFFER, matching or not. The gap
   * between this and {@link newestMatchedAt} is how the console knows the
   * difference between a router that has gone silent and a filter that is
   * hiding everything the router is currently saying.
   */
  newestBufferedAt: number | null;
}

interface RowContext {
  shorts: Map<string, ModelInfo>;
  /** The model the console is scoped to, or `null`. */
  scoped: string | null;
  /** The open trace, so a row can say whether its task is the one being traced. */
  trace: TraceRef | null;
}

/**
 * The trace entry point for a row, or `null`.
 *
 * `null` for an unframed line, for a line whose port Steward never saw (half
 * the trace key is missing, and a trace on the other half would be a
 * mis-attribution), and for `get_availabl`, which is `task -1` in 217/217
 * measured cases because no task is attached yet. That last one joins its trace
 * by adjacency instead, and the banner says so.
 */
function taskCell(line: LogLine, trace: TraceRef | null): TaskCellVm | null {
  const frame = line.frame;
  const port = line.port;
  if (frame === undefined || port === undefined || frame.task < 0) return null;
  const active = trace !== null && trace.port === port && trace.task === frame.task;
  return {
    port,
    task: frame.task,
    key: taskKey(port, frame.task),
    // `▸` already means "press to reveal more" in this console and `▾` means
    // "showing"; the task cell reuses the args fold's vocabulary exactly.
    label: `${active ? "▾" : "▸"}${frame.task}`,
    ariaLabel: `Trace task ${frame.task} on port ${port}. This is llama-server's own handle for the request, not a request number.`,
    active,
  };
}

/**
 * A row's trailing annotations. Every one is a nullable enrichment: an absent
 * reading renders nothing at all, so a llama.cpp that renames a payload costs
 * one missing badge and never a row.
 */
function logBadges(line: LogLine, model: ModelInfo | undefined): LogBadgeVm[] {
  const badges: LogBadgeVm[] = [];
  // Only ever for `= 1`. A `truncated: no` badge on 217 of 217 rows is the
  // definition of crying wolf: it trains the eye to skip the exact pixel where
  // the real thing will appear.
  if (line.contextLost === true) {
    badges.push({
      key: "context-lost",
      label: "▲ context lost",
      title:
        "A context shift discarded the front of this conversation before the reply was written.",
      tone: "warn",
    });
  }
  // The one extraction that TRANSLATES rather than repeats: an operator knows
  // what "cache 47%" means and does not know what `sim_best = 0.473` means.
  if (line.cacheHit !== undefined && Number.isFinite(line.cacheHit)) {
    const percent = Math.round(line.cacheHit * 100);
    badges.push({
      key: "cache",
      label: `cache ${percent}%`,
      title: `${percent}% of this prompt was already in the slot's KV cache, so only the rest had to be prefilled.`,
      tone: "neutral",
    });
  }
  // Revealed by the model's own `--parallel`, which the snapshot already
  // carries — an authoritative rule rather than one inferred from the values
  // seen so far. On a one-slot server every slot id is 0 and a column of zeros
  // teaches an operator that the column is meaningless.
  const parallel = model?.parallel ?? null;
  if (line.frame !== undefined && parallel !== null && parallel > 1) {
    badges.push({
      key: "slot",
      label: `slot ${line.frame.slot}`,
      title: `Decode slot ${line.frame.slot} of this model's ${parallel}.`,
      tone: "neutral",
    });
  }
  return badges;
}

function logRow(
  ctx: RowContext,
  entry: KeptLine,
  key: string,
  message: string,
  folded: boolean,
  fold: FoldVm | null,
): LogRowVm {
  const { line, scope, kind } = entry;
  const model = line.modelId === null ? undefined : ctx.shorts.get(line.modelId);
  return {
    key,
    seq: line.seq,
    time: formatClock(line.ts),
    level: line.level,
    // The word is the signal. A screen reader reads "router", which is the
    // truth, where it would read an em dash as nothing at all.
    model:
      scope === "router"
        ? "router"
        : scope === "unknown"
          ? NO_READING
          : (model?.short ?? line.modelId ?? NO_READING),
    // Once the console is scoped to one model the color carries no information,
    // so the column recedes to plain muted text.
    modelColor:
      scope === "unknown"
        ? "var(--text-subtle)"
        : scope !== "model" || ctx.scoped !== null || model === undefined
          ? "var(--text-muted)"
          : modelColor(model.id, model.embedding),
    modelTitle: scope === "router" ? ROUTER_TITLE : scope === "unknown" ? UNKNOWN_TITLE : "",
    scope,
    kind,
    // A fold row stands for a whole args run, which is unframed and carries no
    // enrichment of its own; both come back empty on their own merits.
    task: taskCell(line, ctx.trace),
    frameRaw: line.frame?.raw ?? "",
    badges: fold === null ? logBadges(line, model) : [],
    traced: entry.traced,
    message,
    folded,
    fold,
  };
}

function foldLabel(
  expanded: boolean,
  count: number,
  truncated: boolean,
  matches: number,
  query: string,
): string {
  const noun = `launch argument${count === 1 ? "" : "s"}`;
  // "dropped", never "trimmed" and never "rotated": launchd appends across
  // router restarts, so nothing here ever rotates.
  const cut = truncated ? " (older lines dropped)" : "";
  const hits = matches > 0 ? ` · ${formatCount(matches)} match "${query}"` : "";
  return `${expanded ? "▾" : "▸"} ${formatCount(count)} ${noun}${cut}${hits}`;
}

/**
 * Marks the contiguous launch-argument runs, in place.
 *
 * Membership is decided BEFORE the query, the level chip and the record-type
 * chip, on purpose: 31 argument lines are one artifact — the exact launch
 * command — and a search for `ctx-size` that returned 2 of them and hid the
 * other 29 would answer a question nobody asked.
 *
 * The scan walks the SHOWN lines only, so a suppressed proxy line interleaved
 * with a spawn cannot split one launch command into two folds.
 */
function groupRuns(staged: readonly StagedLine[]): void {
  let runId: number | null = null;
  let inRun = false;
  for (const entry of staged) {
    if (!entry.shown) continue;
    if (entry.kind !== "args") {
      inRun = false;
      runId = null;
      continue;
    }
    if (!inRun) runId = entry.line.seq;
    entry.runId = runId;
    inRun = true;
  }
}

/**
 * The membership of one trace, and the two things that can be wrong with it.
 *
 * Both guards are surfaced rather than silently handled: a partial trace and a
 * reused port are things the operator has to know, and a console that quietly
 * showed half a request would be worse than one that says it is showing half.
 */
export interface TraceSelection {
  members: LogLine[];
  /** The earliest member is the oldest line held, and the buffer HAS evicted. */
  partial: boolean;
  /** The id belongs to more than one run on this port; only one is shown. */
  splitRuns: boolean;
  /** The model the port maps to, or `null` when Steward never mapped it. */
  modelId: string | null;
  /** True when the first member joined by adjacency rather than by task id. */
  adjacent: boolean;
}

/**
 * Every line one llama-server task wrote, in file order.
 *
 * Keyed on `(port, task)`. The opening `get_availabl` line carries `task -1` —
 * no task is attached when the slot is chosen — so it joins by ADJACENCY, and
 * only when the line immediately before the earliest member is on the same
 * port, framed, and carries `-1`. Anything else and the trace simply starts at
 * `launch_slot_`: the rule breaks by omitting a line, which is the safe
 * direction for a console built to avoid mis-attribution.
 *
 * Deliberately NOT joined: the `proxy_reques` line. It is the only line that
 * names the model and it carries no task id, so joining it would be adjacency
 * at 1.25 lines/second of Steward's own polling. The model comes from the port
 * map instead, or the banner names no model at all.
 */
export function selectTrace(
  buffer: readonly LogLine[],
  trace: TraceRef,
  /** The buffer has evicted a signal line this session — see {@link TraceSelection.partial}. */
  bufferDropped: boolean,
): TraceSelection {
  const matches: number[] = [];
  buffer.forEach((line, index) => {
    if (line.port === trace.port && line.frame?.task === trace.task) matches.push(index);
  });

  // An id can belong to two different requests: ports are ephemeral, and a
  // child that died and respawned on the same one starts its task counter at 0
  // again. Members more than a request's width apart are therefore two runs,
  // and merging them would present one operator's request as another's — the
  // exact mis-attribution this console is built to avoid. `anchorSeq` says
  // which one was actually clicked, so only that run is shown.
  const runs: number[][] = [];
  for (const index of matches) {
    const current = runs.at(-1);
    const previous = current?.at(-1);
    if (current === undefined || previous === undefined || index - previous > TRACE_SPLIT_GAP) {
      runs.push([index]);
    } else {
      current.push(index);
    }
  }

  // The run holding the row that opened the trace. If that row has since been
  // evicted there is nothing to disambiguate with, so the newest run wins —
  // still one request, never a merge of two.
  const chosen =
    runs.find((run) => run.some((index) => buffer[index]?.seq === trace.anchorSeq)) ??
    runs.at(-1) ??
    [];
  const indices = [...chosen];

  const first = indices[0];
  let adjacent = false;
  if (first !== undefined && first > 0) {
    const before = buffer[first - 1];
    if (before !== undefined && before.port === trace.port && before.frame?.task === -1) {
      indices.unshift(first - 1);
      adjacent = true;
    }
  }

  const members = indices
    .map((index) => buffer[index])
    .filter((line): line is LogLine => line !== undefined);

  return {
    members,
    // Only true when lines were ACTUALLY evicted. A trace that simply starts at
    // the front of a buffer nothing has fallen out of is complete, and saying
    // otherwise would be a warning about a loss that never happened.
    partial: indices[0] === 0 && bufferDropped,
    splitRuns: runs.length > 1,
    // Read off the traced lines themselves, never off "some line that used this
    // port once": a child that respawned on a reused port would otherwise have
    // the banner name the model that USED to be there.
    modelId: members.find((line) => line.modelId !== null)?.modelId ?? null,
    adjacent,
  };
}

/**
 * The whole log pipeline for one repaint: stage every axis, group the
 * launch-argument runs, count honestly, and cap what reaches the DOM.
 *
 * Two filter axes mean the counts cannot be a sequence of narrowing passes.
 * Each is staged as a boolean on the line, the runs are grouped once, and a
 * single walk lifts one axis at a time — so `levels[WARN]` is what pressing
 * WARN yields with the record-type chip still applied, `families[models]` is
 * what pressing `models` yields with the level chip still applied, and
 * `hiddenProxy` is what the toggle would reveal with both applied. Every one of
 * those numbers is literally true under every combination of the others.
 */
function selectLog(snapshot: Snapshot, ui: UiState): LogSelection {
  const ctx: RowContext = {
    shorts: new Map(snapshot.models.map((m) => [m.id, m])),
    scoped: ui.filterModel,
    trace: ui.trace,
  };
  const rawQuery = ui.query.trim();
  const query = rawQuery.toLowerCase();
  const buffer = visibleBuffer(ui);

  let hiddenRouter = 0;
  let contextLost = 0;
  const staged: StagedLine[] = [];

  for (const line of buffer) {
    // Counted over the whole buffer, matching or not: the banner it drives says
    // "of the N buffered", and both halves of that sentence have to be about
    // the same population.
    if (line.contextLost === true) contextLost += 1;
    const scope = lineScope(line);
    if (ui.filterModel !== null && line.modelId !== ui.filterModel) {
      // Scoping to one model silently removes the boot banner, the preset
      // catalogue and the launch arguments, because none of them belong to a
      // model. Count them so the console can say so instead.
      if (scope === "router") hiddenRouter += 1;
      continue;
    }
    const kind = line.kind ?? "event";
    const family = line.family ?? "other";
    staged.push({
      line,
      scope,
      kind,
      family,
      // Matched against the file's own line, frame included: the task id is
      // visible on the row, so it has to be findable in the box.
      hit: query === "" || lineText(line).toLowerCase().includes(query),
      shown: kind !== "proxy" || ui.showProxy,
      levelPass: ui.filterLevel === "all" || line.level === ui.filterLevel,
      familyPass: ui.filterFamily === "any" || family === ui.filterFamily,
      runId: null,
    });
  }

  groupRuns(staged);

  // A run is one artifact, so a hit anywhere in it counts for all of it.
  const runHit = new Map<number, boolean>();
  for (const entry of staged) {
    if (entry.runId === null) continue;
    runHit.set(entry.runId, (runHit.get(entry.runId) ?? false) || entry.hit);
  }
  for (const entry of staged) {
    if (entry.runId !== null) entry.hit = query === "" || (runHit.get(entry.runId) ?? false);
  }

  const levels: Record<LevelFilter, number> = { all: 0, DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
  const families: Record<FamilyFilter, number> = {
    any: 0,
    requests: 0,
    models: 0,
    startup: 0,
    other: 0,
  };
  const kept: KeptLine[] = [];
  let hiddenProxy = 0;
  let proxyShown = 0;
  let folded = 0;
  let framed = 0;

  for (const entry of staged) {
    if (!entry.hit) continue;
    if (!entry.shown) {
      // Dropped ONLY for being proxy traffic — already past the model scope,
      // the query, the level chip and the record-type chip. That is what makes
      // the toggle's number a promise rather than an upper bound.
      if (entry.levelPass && entry.familyPass) hiddenProxy += 1;
      continue;
    }
    if (entry.familyPass) {
      levels.all += 1;
      levels[entry.line.level] += 1;
    }
    if (entry.levelPass) {
      families.any += 1;
      families[entry.family] += 1;
    }
    if (!entry.levelPass || !entry.familyPass) continue;
    kept.push({
      line: entry.line,
      scope: entry.scope,
      kind: entry.kind,
      runId: entry.runId,
      hit: true,
      traced: false,
    });
    if (entry.kind === "proxy") proxyShown += 1;
    if (entry.runId !== null) folded += 1;
    if (entry.line.frame !== undefined) framed += 1;
  }

  const matched = kept.length;
  const renderCapped = matched > LOG_RENDER_LIMIT;
  const cutAt = renderCapped ? matched - LOG_RENDER_LIMIT : 0;
  const painted = renderCapped ? kept.slice(cutAt) : kept;
  /** The oldest line the buffer still holds — the boundary an eviction cut at. */
  const oldestHeld = buffer[0]?.seq;

  const rows: LogRowVm[] = [];
  for (let i = 0; i < painted.length; ) {
    const entry = painted[i];
    if (entry === undefined) {
      i += 1;
      continue;
    }
    if (entry.runId === null) {
      rows.push(logRow(ctx, entry, String(entry.line.seq), entry.line.message, false, null));
      i += 1;
      continue;
    }

    let end = i;
    while (end < painted.length && painted[end]?.runId === entry.runId) end += 1;
    const run = painted.slice(i, end);
    const matches =
      query === ""
        ? 0
        : run.filter((member) => lineText(member.line).toLowerCase().includes(query)).length;
    // A hit inside a collapsed fold opens it and says why, without touching
    // what the operator set: clearing the query puts the fold back.
    const forced = matches > 0;
    const sticky = ui.expandedArgs[entry.runId] === true;
    const expanded = sticky || forced;
    // Truncation is a fact about THIS run, not about the buffer. Only the front
    // of the window can have lost members, and only two things can have taken
    // them: the render slice cutting into the middle of the run, or the buffer
    // evicting the members that came before its oldest held line. Anything
    // looser puts "(older lines dropped)" on a complete 31-of-31 launch
    // command, which is the exact false claim this label exists to make.
    const cutByRender = i === 0 && cutAt > 0 && kept[cutAt - 1]?.runId === entry.runId;
    const cutByBuffer =
      i === 0 && ui.bufferDropped && oldestHeld !== undefined && entry.line.seq === oldestHeld;
    const truncated = cutByRender || cutByBuffer;
    const count = run.length;
    const noun = `launch argument${count === 1 ? "" : "s"}`;
    const fold: FoldVm = {
      seq: entry.runId,
      count,
      expanded,
      sticky,
      truncated,
      matches,
      forced,
      label: foldLabel(expanded, count, truncated, matches, rawQuery),
      // No model is named: an args line is router-wide and carries no model id,
      // and reading one out of the neighbouring spawn line would be an invented
      // attribution — the one thing the model column exists to avoid.
      //
      // A fold a query holds open cannot be named "Hide …": pressing it would
      // change nothing visible, only what happens once the query clears. So it
      // says what the press actually does.
      ariaLabel: !forced
        ? `${expanded ? "Hide" : "Show"} the ${formatCount(count)} ${noun}`
        : sticky
          ? `${formatCount(count)} ${noun}, open because the search matches inside them. Collapse them once the search is cleared.`
          : `${formatCount(count)} ${noun}, open because the search matches inside them. Keep them open once the search is cleared.`,
    };
    rows.push(logRow(ctx, entry, `fold:${entry.runId}`, fold.label, false, fold));
    if (expanded) {
      for (const member of run) {
        rows.push(logRow(ctx, member, String(member.line.seq), member.line.message, true, null));
      }
    }
    i = end;
  }

  // The trace branch, taken AFTER the counts and BEFORE the rows are handed
  // out: membership ignores every filter, but the chips keep reporting the
  // filtered buffer so they stay live and honest while a trace is open. That is
  // what lets every control stay enabled — pressing one exits the trace and
  // applies itself, and its number was already true.
  let trace: TraceSelection | null = null;
  if (ui.trace !== null) {
    trace = selectTrace(buffer, ui.trace, ui.bufferDropped);
    rows.length = 0;
    for (const line of trace.members.slice(-LOG_RENDER_LIMIT)) {
      rows.push(
        logRow(
          ctx,
          {
            line,
            scope: lineScope(line),
            kind: line.kind ?? "event",
            runId: null,
            hit: true,
            traced: true,
          },
          String(line.seq),
          line.message,
          false,
          null,
        ),
      );
    }
  }

  return {
    rows,
    trace,
    exportLines: kept.map((entry) =>
      logRow(ctx, entry, String(entry.line.seq), entry.line.message, false, null),
    ),
    counts: {
      rendered: painted.length,
      matched,
      buffered: buffer.length,
      hiddenProxy,
      proxyShown,
      hiddenRouter,
      folded,
      bufferDropped: ui.bufferDropped,
      renderCapped,
      levels,
      families,
      framed,
      contextLost,
      traced: trace === null ? 0 : trace.members.length,
    },
    newestMatchedAt: kept.at(-1)?.line.ts ?? null,
    newestBufferedAt: buffer.at(-1)?.ts ?? null,
  };
}

/** The filters an operator has actually set, in the order the toolbar shows them. */
function activeFilters(ui: UiState, shorts: Map<string, ModelInfo>): string[] {
  const clauses: string[] = [];
  if (ui.filterModel !== null) clauses.push(shorts.get(ui.filterModel)?.short ?? ui.filterModel);
  if (ui.filterFamily !== "any") clauses.push(ui.filterFamily);
  if (ui.filterLevel !== "all") clauses.push(ui.filterLevel);
  const query = ui.query.trim();
  if (query !== "") clauses.push(`"${query}"`);
  return clauses;
}

const CLEAR_FILTERS: ConsoleActionVm = {
  label: "Clear filters",
  kind: "clear-filters",
  ariaLabel: "Clear the model, record type, level and search filters",
};

const SHOW_ALL_MODELS: ConsoleActionVm = {
  label: "show all",
  kind: "show-all-models",
  ariaLabel: "Show every model's lines, including the router-wide ones",
};

const EXIT_TRACE: ConsoleActionVm = {
  label: "back",
  kind: "exit-trace",
  ariaLabel: "Close the trace and go back to the filtered log",
};

const SHOW_CONTEXT_LOST: ConsoleActionVm = {
  label: "show them",
  kind: "query-truncated",
  // Named as the search it is, so nobody expects a fourth filter chip to appear.
  ariaLabel: `Search the log for ${CONTEXT_LOST_QUERY}`,
};

/**
 * The strip that makes `truncated = 1` findable.
 *
 * The level is NOT rewritten to make it findable — llama-server says INFO and
 * the console says INFO, because an operator who has learned that the ERROR
 * chip means "llama-server said E" must be able to keep believing that. So the
 * badge alone would be findable only by scrolling, and this is the strip that
 * fixes it.
 *
 * It appears only when the count is above zero. There is no "0 requests lost
 * context" state: that would be a health affirmation about a signal the console
 * can only see a 500-line window of, which is why the copy says "buffered"
 * rather than implying a total.
 */
export function truncatedBanner(counts: LogCountsVm): ConsoleBannerVm | null {
  if (counts.contextLost <= 0) return null;
  // "lines", because lines are what is counted. `buffered` is a LINE count, and
  // a 500-line window is roughly 20 requests — so "500 buffered requests" would
  // be false by a factor of 25, in the one strip whose whole job is to be
  // trusted. The noun also has to agree with the number it sits against, which
  // is the denominator.
  const noun = counts.buffered === 1 ? "line" : "lines";
  return {
    key: "context-lost",
    placement: "top",
    tone: "warn",
    text: `▲ ${formatCount(counts.contextLost)} of the ${formatCount(
      counts.buffered,
    )} buffered ${noun} said the reply lost context`,
    detail: "A context shift discarded the front of the conversation before the reply was written.",
    action: SHOW_CONTEXT_LOST,
  };
}

/** The open trace, as its banner reads it. */
function selectTraceVm(
  trace: TraceRef,
  selection: TraceSelection,
  shorts: Map<string, ModelInfo>,
): TraceVm {
  const modelLabel =
    selection.modelId === null ? "" : (shorts.get(selection.modelId)?.short ?? selection.modelId);
  const model = modelLabel === "" ? "" : ` · ${modelLabel}`;
  // Both guards are said out loud rather than handled quietly. The rows are the
  // same either way; what changes is whether the operator knows.
  const partial = selection.partial ? " · earliest lines dropped from the buffer" : "";
  // Two requests share this id because the port was reused. Only the one that
  // was clicked is shown — merging them would be a mis-attribution — and the
  // banner says so rather than letting a short trace look like the whole story.
  const split = selection.splitRuns
    ? ` · another request on port ${trace.port} shares this id — showing only the one you opened`
    : "";
  // "in file order" closes off sorting; there is no header a reader could take
  // for a sort control, and task ids are not monotonic anyway (a deferred task
  // is allocated its id at enqueue and logs later with a lower one).
  const adjacency = selection.adjacent
    ? " The first line has no task id of its own — it is attached by position."
    : "";
  return {
    port: trace.port,
    task: trace.task,
    modelLabel,
    count: selection.members.length,
    title: `▾ tracing task ${trace.task} · port ${trace.port}${model} · ${formatLines(
      selection.members.length,
    )}${partial}${split}`,
    detail:
      "Every line llama-server wrote for this request, in file order. Filters do not apply inside a trace. Task ids are llama-server's internal handles: sparse, reused across children, and not in order." +
      adjacency,
    backLabel: EXIT_TRACE.label,
    backAriaLabel: EXIT_TRACE.ariaLabel,
    partial: selection.partial,
    splitRuns: selection.splitRuns,
  };
}

/** Paths macOS's `tmp_cleaner` unlinks after three untouched days. */
const TMP_PREFIXES = ["/tmp/", "/private/tmp/"];

/**
 * The file-unlinked copy. Warn-toned and never called an error: nothing failed,
 * the tailer holds its offset, and it re-opens the file the moment it returns.
 * The path is named verbatim — that is what makes this diagnosable, and it is
 * how the operator confirms Steward is watching what they think it is.
 */
function fileMissingCopy(path: string | null): { title: string; detail: string } {
  const named = path === null ? "The log file Steward was watching" : path;
  const temporary = path !== null && TMP_PREFIXES.some((prefix) => path.startsWith(prefix));
  const why = temporary
    ? " macOS clears /tmp files that have gone untouched for three days, so a router that was stopped that long has no log left."
    : "";
  const fix = temporary ? " Fix it for good: point llama-server's log somewhere outside /tmp." : "";
  return {
    title: "The log file is gone",
    detail: `${named} no longer exists.${why} Steward is still watching that path and picks the log back up the moment llama-server writes to it again.${fix}`,
  };
}

function consoleState(
  snapshot: Snapshot,
  ui: UiState,
  counts: LogCountsVm,
  newestMatchedAt: number | null,
  now: number,
): ConsoleState {
  if (ui.logSource === "unavailable") return "no-source";
  if (ui.logSource === "missing") return "file-missing";
  if (ui.logStream === "reconnecting") return "reconnecting";
  if (!snapshot.service.running) return "stopped";
  if (ui.paused) return "paused";
  // Above `empty-filtered`: a trace ignores the filters, so a filter stack that
  // matches nothing says nothing about what the trace is showing.
  if (ui.trace !== null) return "tracing";
  if (counts.matched === 0 && counts.buffered > 0) return "empty-filtered";
  if (counts.buffered === 0) return "cold";
  // `LogLine.ts` is Steward's ARRIVAL stamp, so the newest matching row's stamp
  // already is "when the last visible line arrived". No extra bookkeeping.
  if (newestMatchedAt !== null && now - newestMatchedAt > QUIET_AFTER_MS) return "quiet";
  return "streaming";
}

/**
 * The empty-filtered notice.
 *
 * The ERROR chip gets its own words. An empty ERROR console is the single
 * easiest place in this dashboard to imply "all clear", and it would be false:
 * llama-server writes nothing at all for a rejected request and reports a
 * failed model load at INFO.
 */
function emptyFilteredNotice(ui: UiState, counts: LogCountsVm, clauses: string[]): ConsoleNoticeVm {
  const buffered = formatLines(counts.buffered);
  const proxyClause =
    counts.hiddenProxy > 0
      ? ` ${formatCount(counts.hiddenProxy)} proxied lines are hidden by the toolbar toggle.`
      : "";

  if (ui.filterLevel === "ERROR") {
    const others = clauses.filter((clause) => clause !== "ERROR");
    return {
      state: "empty-filtered",
      glyph: "",
      title:
        others.length === 0
          ? `No ERROR lines among the ${formatCount(counts.buffered)} buffered.`
          : `No ERROR lines match ${others.join(" + ")}.`,
      detail:
        `This is not a health check: llama-server logs nothing at all for rejected requests, and reports a failed model load at INFO. A clean console is not a clean server.` +
        (others.length === 0 ? "" : ` ${buffered} are buffered.`) +
        proxyClause,
      tone: "muted",
      action: CLEAR_FILTERS,
    };
  }

  return {
    state: "empty-filtered",
    glyph: "",
    title:
      clauses.length === 0 ? "No lines are showing." : `No lines match ${clauses.join(" + ")}.`,
    detail: `${buffered} are buffered.${proxyClause}`,
    tone: "muted",
    action: clauses.length === 0 ? null : CLEAR_FILTERS,
  };
}

/**
 * The console's notices and strips.
 *
 * Exactly one state wins, but notices and strips are not the same thing: a
 * state that has real lines under it gets a strip and keeps the lines (those
 * eleven banner lines are what the operator opened the console to read), and
 * only a state with nothing readable takes the whole panel. The truncation and
 * scope strips are orthogonal to all of it and stack on top.
 */
function selectConsole(
  snapshot: Snapshot,
  ui: UiState,
  selection: LogSelection,
  now: number,
  shorts: Map<string, ModelInfo>,
): ConsoleVm {
  const counts = selection.counts;
  const state = consoleState(snapshot, ui, counts, selection.newestMatchedAt, now);
  const banners: ConsoleBannerVm[] = [];
  let notice: ConsoleNoticeVm | null = null;
  const proxyClause =
    counts.hiddenProxy > 0 ? ` · ${formatCount(counts.hiddenProxy)} proxied lines hidden` : "";
  const frozenBehind =
    ui.paused && ui.frozen !== null ? Math.max(0, ui.log.length - ui.frozen.length) : 0;
  const trace =
    ui.trace === null || selection.trace === null
      ? null
      : selectTraceVm(ui.trace, selection.trace, shorts);

  if (trace !== null) {
    banners.push({
      key: "trace",
      placement: "top",
      tone: "trace",
      text: trace.title,
      detail: trace.detail,
      action: EXIT_TRACE,
    });
  }

  if (state === "reconnecting") {
    banners.push({
      key: "reconnecting",
      placement: "top",
      tone: "muted",
      text: "◌ Reconnecting to the log stream…",
      detail: "The lines below are the last Steward read; nothing has been cleared.",
      action: null,
    });
  }

  if (state === "paused") {
    banners.push({
      key: "paused",
      placement: "top",
      tone: "warn",
      text:
        frozenBehind > 0
          ? `⏸ Paused · buffer frozen · ${formatLines(frozenBehind)} arrived behind it`
          : "⏸ Paused · buffer frozen",
      detail: "",
      action: null,
    });
  }

  // Everything below describes the FILTERED view, and filters do not apply
  // inside a trace — so while one is open these strips would be claims about a
  // console nobody is looking at.
  const contextLostStrip = trace === null ? truncatedBanner(counts) : null;
  if (contextLostStrip !== null) banners.push(contextLostStrip);

  if (trace === null && (counts.renderCapped || counts.bufferDropped)) {
    const shown = `showing the latest ${formatCount(counts.rendered)} of ${formatCount(
      counts.matched,
    )} matching`;
    const dropped = `older lines dropped from the ${LOG_BUFFER_LIMIT}-line buffer`;
    banners.push({
      key: "truncation",
      placement: "top",
      tone: "muted",
      text:
        counts.renderCapped && counts.bufferDropped
          ? `${shown} · ${dropped}`
          : counts.renderCapped
            ? `${shown} lines`
            : `${LOG_BUFFER_LIMIT}-line buffer · older lines dropped`,
      detail: "",
      action: null,
    });
  }

  if (trace === null && ui.filterModel !== null && counts.hiddenRouter > 0) {
    const label = shorts.get(ui.filterModel)?.short ?? ui.filterModel;
    banners.push({
      key: "scope",
      placement: "top",
      tone: "muted",
      text: `scoped to ${label} · ${formatCount(counts.hiddenRouter)} router-wide lines hidden`,
      detail: "",
      action: SHOW_ALL_MODELS,
    });
  }

  switch (state) {
    case "no-source":
      // `unavailable` covers two different failures and they need opposite
      // copy. With NO path, nothing was ever wired up and the lines on screen
      // are the fallback's simulation. With a path, a real log was found and
      // could not be read (a permission or I/O problem) — the lines are the
      // server's, and telling that operator they are looking at a simulation
      // would be exactly the false claim this console exists to prevent.
      notice =
        ui.logSourcePath === null
          ? {
              state,
              glyph: "⚠",
              title: "No log source connected",
              detail:
                "Steward is running but has not been pointed at a llama-server log. Ask your agent to wire up log streaming — this console fills on its own once it is." +
                (counts.buffered > 0
                  ? " The lines below are Steward's built-in simulation, not this machine's log."
                  : ""),
              tone: "warn",
              action: null,
            }
          : {
              state,
              glyph: "⚠",
              title: "The log file cannot be read",
              detail:
                // The server's own words, not a paraphrase: "(EACCES)" tells
                // the operator what to fix where "something went wrong" does not.
                `${ui.logSourceDetail ?? `${ui.logSourcePath} could not be read`}. Steward keeps trying, and picks the log back up as soon as it can read it.` +
                (counts.buffered > 0
                  ? " The lines below are what it read before that stopped working."
                  : ""),
              tone: "warn",
              action: null,
            };
      break;
    case "file-missing": {
      const copy = fileMissingCopy(ui.logSourcePath);
      if (counts.buffered === 0) {
        notice = {
          state,
          glyph: "⚠",
          title: copy.title,
          detail: copy.detail,
          tone: "warn",
          action: null,
        };
      } else {
        banners.push({
          key: "file-missing",
          placement: "bottom",
          tone: "warn",
          text: `⚠ ${copy.title}`,
          detail: copy.detail,
          action: null,
        });
      }
      break;
    }
    case "stopped": {
      const newest = ui.log.at(-1)?.ts ?? null;
      if (counts.buffered === 0) {
        notice = {
          state,
          glyph: "⏹",
          title: "The service is stopped",
          detail:
            "llama-server is not running, so nothing is being written. This console fills again as soon as it is started.",
          tone: "muted",
          action: null,
        };
      } else {
        banners.push({
          key: "stopped",
          placement: "bottom",
          tone: "muted",
          text: `⏹ Service stopped · log is idle${
            newest === null ? "" : ` · last line ${formatClockSeconds(newest)}`
          }`,
          detail: "",
          action: null,
        });
      }
      break;
    }
    case "empty-filtered":
      notice = emptyFilteredNotice(ui, counts, activeFilters(ui, shorts));
      break;
    case "cold":
      notice = {
        state,
        glyph: "◷",
        title: "Waiting for the first line",
        detail:
          "Connected to the log. A running router writes its startup banner immediately, so this should fill within a second. If this notice stays, Steward is watching the wrong file.",
        tone: "muted",
        action: null,
      };
      break;
    case "quiet": {
      // "Quiet" is a claim about the ROUTER, and the console can only make it
      // about what it is showing. Anything the operator's own filters are
      // holding back gets said out loud, or the word claims a silence that is
      // not happening — the proxy toggle is only the commonest case of this,
      // not the only one.
      const arriving =
        selection.newestBufferedAt !== null &&
        counts.matched < counts.buffered &&
        now - selection.newestBufferedAt <= QUIET_AFTER_MS;
      const filtering =
        ui.filterModel !== null || ui.filterLevel !== "all" || ui.query.trim() !== "";
      const filteredClause =
        arriving && filtering ? " · lines are still arriving that the filter hides" : "";
      banners.push({
        key: "quiet",
        placement: "bottom",
        tone: "muted",
        text: `▪ quiet · ${formatLines(counts.matched)} · nothing new since ${formatClockSeconds(
          selection.newestMatchedAt ?? 0,
        )}${proxyClause}${filteredClause}`,
        detail: "",
        action: null,
      });
      break;
    }
    default:
      break;
  }

  return {
    state,
    lines: selection.rows,
    notice,
    banners,
    paused: ui.paused,
    trace,
    // A trace is nothing but framed rows, so the column always exists inside
    // one. Outside, it is keyed on the whole matched set rather than the
    // painted window, so it flips at most once per session and never on scroll.
    showTaskColumn: trace !== null || counts.framed > 0,
    frozenBehind,
    // The stamp is Steward's arrival time, not llama-server's own elapsed
    // counter, and nothing on screen says so to a screen reader otherwise.
    heading: "Server log — times are local arrival time",
  };
}

/** What the polite status region should say about the console, and the watermark. */
export interface ConsoleAnnouncement {
  message: string | null;
  key: string | null;
}

/**
 * Announces a console STATE change, once.
 *
 * The snapshot poll runs every 1.6 s and the render clock every second, so a
 * message that is not gated on a transition would turn the status region into a
 * metronome. Individual lines are never announced — not even errors: a burst of
 * them would be as hostile as announcing INFO, and the console is a
 * read-on-demand scrollback by design.
 */
export function consoleAnnouncement(
  console: ConsoleVm,
  path: string | null,
  lastKey: string | null,
): ConsoleAnnouncement {
  const key = console.state === "file-missing" ? `file-missing:${path ?? ""}` : console.state;
  if (key === lastKey) return { message: null, key: lastKey };

  const healthy = console.state === "streaming" || console.state === "cold";
  const message =
    console.state === "no-source"
      ? "No log source connected."
      : console.state === "file-missing"
        ? `The log file ${path ?? "Steward was watching"} is gone. Steward is still watching for it.`
        : console.state === "reconnecting"
          ? "Log stream lost. Reconnecting…"
          : console.state === "stopped"
            ? "Service stopped; log is idle."
            : console.state === "quiet"
              ? "Log quiet — no new lines for a minute."
              : // Pause, filters and folds are announced by the handlers that
                // caused them, so this channel stays silent for those.
                healthy && lastKey === "reconnecting"
                ? "Log stream connected."
                : null;
  return { message, key };
}

/** The honest count clause: what is shown, out of what, and what is held back. */
function lineCountLabel(ui: UiState, counts: LogCountsVm): string {
  // Inside a trace the count is about the trace, not the filter stack — the
  // filters are not applying, so reporting them would be a lie by omission.
  if (ui.trace !== null) {
    return `tracing task ${ui.trace.task} · ${formatLines(counts.traced)}`;
  }
  // Proxy suppression alone is not "filtering" — the operator did not ask for
  // it, so the count keeps its plain form and the suppression gets its own
  // clause rather than silently shrinking the numerator.
  const filtering =
    ui.filterModel !== null ||
    ui.filterLevel !== "all" ||
    ui.filterFamily !== "any" ||
    ui.query.trim() !== "";
  const head = counts.renderCapped
    ? `showing ${formatCount(counts.rendered)} of ${formatCount(counts.matched)}`
    : filtering
      ? `${formatCount(counts.matched)} of ${formatCount(counts.buffered)}`
      : formatLines(counts.matched);
  const tail = counts.hiddenProxy > 0 ? ` · ${formatCount(counts.hiddenProxy)} proxied hidden` : "";
  return `${head}${tail}`;
}

/**
 * The proxied-request toggle.
 *
 * The chip has room for the class, the count and the fact that it is
 * reversible; it does not have room for WHY they are hidden, so that goes in
 * the accessible name and the title — which is where an operator who wonders
 * will look. `aria-pressed` tracks SHOWN.
 */
function selectProxyToggle(ui: UiState, counts: LogCountsVm): ProxyToggleVm {
  if (ui.showProxy) {
    const name = `Hide proxied request lines. ${formatCount(counts.proxyShown)} of the ${formatCount(
      counts.matched,
    )} lines shown are proxied requests, most of them Steward's own status polling.`;
    return { label: "▾ proxied shown", pressed: true, ariaLabel: name, title: name };
  }
  const why =
    "Hidden by default: Steward's own status polling produces about 1.3 of these per second per loaded model.";
  const name =
    counts.hiddenProxy > 0
      ? `Show ${formatCount(counts.hiddenProxy)} proxied request lines. ${why}`
      : `Show proxied request lines. None are hidden by the current filters. ${why}`;
  return {
    label: counts.hiddenProxy > 0 ? `▸ ${formatCount(counts.hiddenProxy)} proxied` : "▸ proxied",
    pressed: false,
    ariaLabel: name,
    title: name,
  };
}

// Both reset chips read `any`, under a group label that names the axis. Two
// adjacent groups whose reset both read `all` and both show the same number at
// rest look like one duplicated control; `any kind` / `any level` does not.
const LEVEL_CHIP_NAMES: Record<LevelFilter, string> = {
  all: "Any level",
  DEBUG: "Debug",
  INFO: "Info",
  WARN: "Warnings",
  ERROR: "Errors",
};

/**
 * What each record-type chip is FOR, in the accessible name — including
 * `other`'s, which is the one that says out loud that it is the drift alarm.
 */
const FAMILY_CHIP_NAMES: Record<FamilyFilter, string> = {
  any: "Any kind",
  requests: "Requests",
  models: "Models",
  startup: "Startup",
  other:
    "Other — lines Steward could not classify. A new llama-server message shape lands here and stays visible",
};

const FAMILY_CHIP_LABELS: Record<FamilyFilter, string> = {
  any: "any",
  requests: "requests",
  models: "models",
  startup: "startup",
  other: "other",
};

function selectFamilyChips(ui: UiState, counts: LogCountsVm): FamilyChipVm[] {
  return FAMILY_FILTERS.map((family) => {
    const active = ui.filterFamily === family;
    const count = counts.families[family];
    return {
      family,
      label: FAMILY_CHIP_LABELS[family],
      count,
      countLabel: formatCount(count),
      ariaLabel: `${FAMILY_CHIP_NAMES[family]} — ${formatLines(count)}`,
      active,
      background: active ? tint("var(--accent)", 18) : "var(--surface-page)",
      // Same reasoning as the level chips: the hue stays in the tint and the
      // border, where it decorates, and never carries the meaning.
      color: active ? "var(--text-primary)" : "var(--text-secondary)",
      borderColor: active ? tint("var(--accent)", 45) : "var(--border)",
    };
  });
}

function selectToolbar(
  ui: UiState,
  counts: LogCountsVm,
  activeModel: ModelInfo | undefined,
): ToolbarVm {
  const activeColor =
    activeModel === undefined ? "var(--accent)" : modelColor(activeModel.id, activeModel.embedding);

  return {
    activeModelLabel: activeModel?.short ?? ui.filterModel ?? "all models",
    activeModelBackground: tint(activeColor, activeModel === undefined ? 16 : 18),
    activeModelColor: activeColor,
    familyChips: selectFamilyChips(ui, counts),
    levelChips: LEVEL_FILTERS.map((level) => {
      const color = level === "all" ? "var(--accent)" : LEVEL_COLORS[level];
      const active = ui.filterLevel === level;
      const count = counts.levels[level];
      return {
        level,
        label: level === "all" ? "any" : level,
        count,
        countLabel: formatCount(count),
        ariaLabel: `${LEVEL_CHIP_NAMES[level]} — ${formatLines(count)}`,
        active,
        background: active ? tint(color, 18) : "var(--surface-page)",
        // The hue stays in the tint and the border, where it decorates and
        // carries nothing. No level colour clears AA as an 11.5px label on the
        // chip's own tinted ground in the light theme.
        color: active ? "var(--text-primary)" : "var(--text-tertiary)",
        borderColor: active ? tint(color, 45) : "var(--border)",
      };
    }),
    proxyToggle: selectProxyToggle(ui, counts),
    query: ui.query,
    lineCountLabel: lineCountLabel(ui, counts),
    paused: ui.paused,
    pauseLabel: ui.paused ? "Resume" : "Pause",
    pauseBackground: ui.paused ? tint("var(--warning)", 18) : "var(--surface-page)",
    pauseColor: ui.paused ? "var(--warning)" : "var(--text-secondary)",
    pauseBorder: ui.paused ? tint("var(--warning)", 45) : "var(--border)",
    copyLabel: ui.copied ? "Copied" : "Copy",
  };
}

/** One slot's dot view-model, honouring the service being down. */
function selectSlotDot(slot: SlotInfo, running: boolean): SlotDotVm {
  // A slot cannot be working if the service is stopped, whatever the last event
  // said — a stopped server has nothing running in any lane, so a stopped
  // service reads idle across the board.
  const state: SlotState = running ? slot.state : "idle";
  const ctx =
    slot.ctxTotal === null ? `${NO_READING} ctx` : `${formatTokenCount(slot.ctxTotal)} ctx`;
  // The context fill needs both halves measured. Missing either one leaves no
  // percentage rather than a 0% bar, which would read as an empty lane.
  const headroomPct =
    slot.promptTokens === null || slot.ctxTotal === null || slot.ctxTotal <= 0
      ? null
      : barPercent(slot.promptTokens / slot.ctxTotal);
  const held = slot.promptTokens === null ? NO_READING : String(slot.promptTokens);
  const decoded = slot.decoded === null ? NO_READING : String(slot.decoded);
  return {
    id: slot.id,
    state,
    headroomPct,
    detail:
      state === "processing"
        ? `${held} / ${ctx} · ${decoded} decoded`
        : state === "idle"
          ? `${ctx} · idle`
          : `${ctx} · state unknown`,
  };
}

function selectSlots(snapshot: Snapshot): SlotsVm {
  const running = snapshot.service.running;
  // Slots arrive flat but belong to one model each; bucket them by model so a
  // group can be built per loaded model, in the order MODELS lists them.
  const byModel = new Map<string, SlotInfo[]>();
  for (const slot of snapshot.slots) {
    const bucket = byModel.get(slot.modelId);
    if (bucket === undefined) byModel.set(slot.modelId, [slot]);
    else bucket.push(slot);
  }

  const groups: SlotGroupVm[] = [];
  for (const model of snapshot.models) {
    if (model.status !== "active" && model.status !== "resident") continue;
    const modelSlots = byModel.get(model.id);
    // A loaded model whose /slots read was dropped contributes no slots and so
    // no group, rather than an empty one.
    if (modelSlots === undefined || modelSlots.length === 0) continue;

    const dots = modelSlots.map((slot) => selectSlotDot(slot, running));
    const busy = dots.filter((dot) => dot.state === "processing").length;
    // Lanes we cannot speak for are counted and said out loud. Folding them into
    // the idle remainder would make `1/4 busy` look like a measurement when
    // three of those four lanes were never established.
    const unknown = dots.filter((dot) => dot.state === "unknown").length;
    // The busiest lane is the overflow signal — one full lane matters even when
    // the others are empty — so the group reduces to its max fill, not a mean.
    // A group where no lane reported a fill has no peak, rather than a peak of 0.
    const peakPct = dots.reduce<number | null>(
      (hi, dot) => (dot.headroomPct === null ? hi : Math.max(hi ?? 0, dot.headroomPct)),
      null,
    );
    // The rate belongs to a model that is actually generating; an idle model, or
    // one whose child was launched without `--metrics`, has none to show.
    const rateLabel =
      model.status === "active" && model.tokensPerSecond !== null
        ? formatTps(model.tokensPerSecond)
        : "";
    groups.push({
      modelId: model.id,
      modelLabel: model.short,
      modelColor: modelColor(model.id, model.embedding),
      busy,
      unknown,
      total: dots.length,
      summary: `${busy}/${dots.length} busy${unknown > 0 ? ` · ${unknown} unknown` : ""}`,
      rateLabel,
      peakPct,
      peakLabel: peakPct === null ? "" : `${peakPct}%`,
      peakColor: contextHeadroomColor(peakPct ?? 0),
      slots: dots,
    });
  }

  const busyTotal = groups.reduce((sum, group) => sum + group.busy, 0);
  const slotTotal = groups.reduce((sum, group) => sum + group.total, 0);
  const unknownTotal = groups.reduce((sum, group) => sum + group.unknown, 0);
  // Worst-case fill across the lanes that are actually working; an idle group
  // holds no context, so it never sets the peak, and a working group that never
  // reported a fill contributes none rather than dragging the peak down to 0.
  const peak = groups.reduce<number | null>(
    (hi, group) =>
      group.busy > 0 && group.peakPct !== null ? Math.max(hi ?? 0, group.peakPct) : hi,
    null,
  );
  const peakClause = busyTotal > 0 && peak !== null ? ` · peak ${peak}% ctx` : "";
  const unknownClause = unknownTotal > 0 ? ` · ${unknownTotal} unknown` : "";
  return {
    groups,
    empty: groups.length === 0,
    emptyLabel: "no models loaded",
    totalSummary: `${busyTotal} of ${slotTotal} busy${peakClause}${unknownClause}`,
  };
}

/** Builds the whole dashboard view model for one repaint. */
export function selectDashboard(snapshot: Snapshot, ui: UiState, now: number): DashboardVm {
  const activeModel =
    ui.filterModel === null ? undefined : snapshot.models.find((m) => m.id === ui.filterModel);
  const selection = selectLog(snapshot, ui);
  const shorts = new Map(snapshot.models.map((m) => [m.id, m]));
  const allSelected = ui.filterModel === null;

  return {
    service: selectService(snapshot, ui),
    gauges: selectGauges(snapshot, ui),
    models: selectModels(snapshot, ui),
    allLogsPill: {
      label: "all logs",
      active: allSelected,
      background: allSelected ? tint("var(--accent)", 16) : "var(--surface-page)",
      color: allSelected ? "var(--accent)" : "var(--text-tertiary)",
      borderColor: allSelected ? tint("var(--accent)", 45) : "var(--border)",
    },
    kpis: selectKpis(snapshot, now),
    spark: selectSpark(snapshot),
    toolbar: selectToolbar(ui, selection.counts, activeModel),
    console: selectConsole(snapshot, ui, selection, now, shorts),
    logCounts: selection.counts,
    exportLines: selection.exportLines,
    slots: selectSlots(snapshot),
  };
}

/**
 * The copy/download payload: every MATCHING BUFFERED line with the folds
 * expanded, not the painted rows.
 *
 * The painted window stops at {@link LOG_RENDER_LIMIT} and shows the launch
 * arguments as a single fold row, so exporting what is on screen would hand an
 * operator diagnosing a bad launch a truncated dump with the launch command
 * itself replaced by the words "31 launch arguments".
 *
 * Each row writes `frameRaw + message`, so the message half is byte-identical
 * to the file's line — the frame the task column took out goes back in. That
 * guarantee is what makes relocating the frame a relocation.
 */
export function selectLogText(vm: DashboardVm): string {
  return formatLogText(vm.exportLines);
}

/**
 * What was actually written out, said out loud. The folded and suppressed
 * clauses are the point: an export that silently differs from the screen is
 * the kind of quiet inaccuracy this console exists to avoid.
 */
export function selectLogExportSummary(counts: LogCountsVm): string {
  const folded =
    counts.folded > 0
      ? `, including ${formatCount(counts.folded)} folded launch argument${
          counts.folded === 1 ? "" : "s"
        }`
      : "";
  const hidden =
    counts.hiddenProxy > 0
      ? ` ${formatCount(counts.hiddenProxy)} proxied line${
          counts.hiddenProxy === 1 ? " was" : "s were"
        } hidden.`
      : "";
  return `${formatLines(counts.matched)}${folded}.${hidden}`;
}

/**
 * Where focus should land after a console repaint destroyed the control that
 * had it.
 *
 * Three interactions remove their own control as a direct result of being
 * activated — toggling a fold rebuilds the row list, "Clear filters" empties
 * the notice, "show all" drops the scope banner — and a keyboard operator would
 * otherwise be dropped at the top of the document, thousands of log lines from
 * what they were doing. The DOM plumbing lives in `console.ts`; the DECISION
 * lives here so it can be reasoned about and tested without a browser.
 */
export type FocusRestore =
  | { target: "fold"; key: string }
  | { target: "task"; key: string }
  | { target: "back" }
  | { target: "region" | "none" };

export interface FocusRestoreInput {
  /** Focus was inside the console when the repaint began. */
  wasInside: boolean;
  /** Focus was inside AND the browser has since moved it. */
  moved: boolean;
  /** This repaint opened a trace. */
  enteringTrace: boolean;
  /** This repaint closed one. */
  leavingTrace: boolean;
  /** The key of the fold row that had focus, or `null` for anything else. */
  foldKey: string | null;
  /** The key of the task cell that had focus, or `null` for anything else. */
  taskKey: string | null;
  /** The `(port, task)` key of the trace being left, or `null`. */
  exitingTaskKey: string | null;
  /** The row keys present after the repaint. */
  keys: readonly string[];
  /** The task-cell keys present after the repaint. */
  taskKeys: readonly string[];
}

export function consoleFocusRestore(input: FocusRestoreInput): FocusRestore {
  // Entering a trace replaces the whole row set, so the cell that was pressed
  // is gone. Focus parks on `[ back ]` — the safe choice, and the same pattern
  // the service block's confirm strip uses.
  if (input.enteringTrace && input.wasInside) return { target: "back" };
  // Leaving one puts the operator back on the task cell they came from, so the
  // trace can be re-opened with one press. Only when focus was inside the
  // console: a chip that closed the trace as a side effect keeps its own focus,
  // which is why no control has to be disabled while tracing.
  if (input.leavingTrace && input.wasInside) {
    return input.exitingTaskKey !== null && input.taskKeys.includes(input.exitingTaskKey)
      ? { target: "task", key: input.exitingTaskKey }
      : { target: "region" };
  }
  if (!input.moved) return { target: "none" };
  // The equivalent control first: a fold that was toggled still exists under
  // the same key, and landing back on it is the only outcome that lets an
  // operator press it twice.
  if (input.foldKey !== null && input.keys.includes(input.foldKey)) {
    return { target: "fold", key: input.foldKey };
  }
  if (input.taskKey !== null && input.taskKeys.includes(input.taskKey)) {
    return { target: "task", key: input.taskKey };
  }
  return { target: "region" };
}

/**
 * How many genuinely new lines are sitting below a console the operator has
 * scrolled away from.
 *
 * Fold rows are excluded: a fold row shares its `seq` with the first line of
 * its run, so counting rows rather than lines over-reports by one for every
 * expanded fold on screen.
 */
export function countNewLines(rows: readonly LogRowVm[], sinceSeq: number): number {
  return rows.reduce(
    (total, row) => (row.fold === null && row.seq > sinceSeq ? total + 1 : total),
    0,
  );
}

/**
 * What toggling an args fold did, for the polite region.
 *
 * While a query is holding the fold open the press changes nothing visible —
 * only where the fold lands once the query clears — so the two directions must
 * not share a sentence.
 */
export function foldAnnouncement(count: number, forced: boolean, sticky: boolean): string {
  const noun = `launch argument${count === 1 ? "" : "s"}`;
  if (forced) {
    return `${formatCount(count)} ${noun} will stay ${
      sticky ? "open" : "collapsed"
    } when the search is cleared.`;
  }
  return `${formatCount(count)} ${noun} ${sticky ? "shown" : "hidden"}.`;
}

/**
 * The one-off announcement for the buffer having evicted lines. It carries the
 * same two forms the banner does, so it can never read "showing the latest 500
 * of 500" on a console the render cap never touched.
 */
export function truncationAnnouncement(counts: LogCountsVm): string {
  return counts.renderCapped
    ? `Older lines dropped from the buffer; showing the latest ${formatCount(
        counts.rendered,
      )} of ${formatCount(counts.matched)}.`
    : `Older lines dropped from the ${LOG_BUFFER_LIMIT}-line buffer.`;
}
