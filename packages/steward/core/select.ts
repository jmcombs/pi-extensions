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
  formatContextField,
  formatFlashField,
  formatGpuLayersField,
  formatKvCacheField,
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
import type { LevelFilter, UiState } from "./state.js";
import { visibleBuffer } from "./state.js";
import type {
  ConfigEntry,
  LogLevel,
  ModelAction,
  ModelInfo,
  ServiceAction,
  SlotInfo,
  Snapshot,
} from "./types.js";

// A model's color is a stable hash of its id (embedders get a reserved hue);
// re-exported here because it is part of this module's view-model surface.
export { modelColor } from "./model-color.js";

/**
 * How many filtered lines reach the DOM. The buffer holds more; painting all of
 * it buys nothing an operator can read and costs a layout on every append.
 */
export const LOG_RENDER_LIMIT = 200;

/** Throughput tile: the bar reads full at this many tokens per second. */
const THROUGHPUT_FULL_SCALE = 120;

const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: "var(--text-muted)",
  INFO: "var(--info)",
  WARN: "var(--warning)",
  ERROR: "var(--error)",
};

const LEVEL_FILTERS: LevelFilter[] = ["all", "INFO", "WARN", "ERROR"];

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
}

export interface LogRowVm {
  seq: number;
  time: string;
  level: LogLevel;
  levelColor: string;
  model: string;
  modelColor: string;
  message: string;
}

export interface ToolbarVm {
  activeModelLabel: string;
  activeModelBackground: string;
  activeModelColor: string;
  levelChips: LevelChipVm[];
  query: string;
  lineCountLabel: string;
  paused: boolean;
  pauseLabel: string;
  pauseBackground: string;
  pauseColor: string;
  pauseBorder: string;
  copyLabel: string;
}

export interface SlotDotVm {
  id: number;
  state: "processing" | "idle";
  /** Context fill, 0–100, for a mini bar: `promptTokens / ctxTotal`. */
  headroomPct: number;
  /** `27 / 40k ctx · 5 decoded`, or `40k ctx · idle`. */
  detail: string;
}

export interface SlotGroupVm {
  modelId: string;
  /** The model's short name. */
  modelLabel: string;
  modelColor: string;
  /** Slots in this group that are processing. */
  busy: number;
  /** Slots in this group. */
  total: number;
  /** `2/4 busy` */
  summary: string;
  /** `63 t/s` while the model is generating; `""` when idle or the rate is unknown. */
  rateLabel: string;
  /** The busiest lane's context fill, 0–100 — the group's overflow signal. */
  peakPct: number;
  /** `61%`, the peak as a label. Shown only on a busy chip; the number is never color-only. */
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
  lines: LogRowVm[];
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
      ? `launch:-${launch.removed.join(" ")}:+${launch.added.join(" ")}:${
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

/** A temperature gauge. Only ever built from a finite reading, so always solid. */
function tempGauge(key: string, label: string, celsius: number): GaugeVm {
  return {
    key,
    label,
    value: formatTemperature(celsius),
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
 */
function selectGauges(snapshot: Snapshot): GaugeVm[] {
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
    gauges.push(tempGauge("gpu-temp", "GPU temp", m.gpuTempC));
  }

  // Discrete machines carry a separate RAM gauge after the temps; unified
  // machines already accounted for RAM in the single Unified RAM gauge.
  if (snapshot.memoryTopology === "discrete") {
    gauges.push(memoryGauge("ram", "RAM", m.ramUsedGB, m.ramTotalGB, 0, "var(--accent)"));
  }

  gauges.push(utilGauge("cpu", "CPU", m.cpuUtil, "var(--latte-peach)"));

  if (m.cpuTempC !== null && Number.isFinite(m.cpuTempC)) {
    gauges.push(tempGauge("cpu-temp", "CPU temp", m.cpuTempC));
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

  // The requests tile reports live gauges (in flight, queued) — llama.cpp has
  // no request-rate metric. The bar fills as the slots fill.
  const inFlight = running ? snapshot.requestsInFlight : 0;
  const queued = running ? snapshot.requestsQueued : 0;
  const slotTotal = snapshot.slots.length;
  const requestsFill = slotTotal > 0 ? inFlight / slotTotal : inFlight > 0 ? 1 : 0;

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
      value: String(inFlight),
      unit: "in flight",
      sub: `${queued} queued`,
      color: "var(--accent)",
      percent: barPercent(requestsFill),
    },
    {
      key: "throughput",
      label: "throughput",
      value: running ? countLabel(snapshot.throughputTps) : "0",
      unit: "tok/s",
      sub: "generation, all slots",
      color: "var(--latte-mauve)",
      percent: barPercent((running ? snapshot.throughputTps : 0) / THROUGHPUT_FULL_SCALE),
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

function selectLines(snapshot: Snapshot, ui: UiState): LogRowVm[] {
  const shorts = new Map(snapshot.models.map((m) => [m.id, m]));
  const query = ui.query.trim().toLowerCase();
  const rows: LogRowVm[] = [];

  for (const line of visibleBuffer(ui)) {
    if (ui.filterModel !== null && line.modelId !== ui.filterModel) continue;
    if (ui.filterLevel !== "all" && line.level !== ui.filterLevel) continue;
    if (query !== "" && !line.message.toLowerCase().includes(query)) continue;

    const model = line.modelId === null ? undefined : shorts.get(line.modelId);
    rows.push({
      seq: line.seq,
      time: formatClock(line.ts),
      level: line.level,
      levelColor: LEVEL_COLORS[line.level],
      model: model?.short ?? line.modelId ?? "—",
      // Once the console is scoped to one model the color carries no
      // information, so the column recedes to plain muted text.
      modelColor:
        ui.filterModel !== null || model === undefined
          ? "var(--text-muted)"
          : modelColor(model.id, model.embedding),
      message: line.message,
    });
  }

  return rows.length > LOG_RENDER_LIMIT ? rows.slice(rows.length - LOG_RENDER_LIMIT) : rows;
}

function selectToolbar(
  ui: UiState,
  lineCount: number,
  activeModel: ModelInfo | undefined,
): ToolbarVm {
  const activeColor =
    activeModel === undefined ? "var(--accent)" : modelColor(activeModel.id, activeModel.embedding);

  return {
    activeModelLabel: activeModel?.short ?? ui.filterModel ?? "all models",
    activeModelBackground: tint(activeColor, activeModel === undefined ? 16 : 18),
    activeModelColor: activeColor,
    levelChips: LEVEL_FILTERS.map((level) => {
      const color = level === "all" ? "var(--accent)" : LEVEL_COLORS[level];
      const active = ui.filterLevel === level;
      return {
        level,
        label: level === "all" ? "all levels" : level,
        active,
        background: active ? tint(color, 18) : "var(--surface-page)",
        color: active ? color : "var(--text-tertiary)",
        borderColor: active ? tint(color, 45) : "var(--border)",
      };
    }),
    query: ui.query,
    lineCountLabel: `${lineCount} lines`,
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
  // A slot cannot be working if the service is stopped, whatever the poll said.
  const processing = running && slot.state === "processing";
  const ctx = formatTokenCount(slot.ctxTotal);
  return {
    id: slot.id,
    state: processing ? "processing" : "idle",
    headroomPct: barPercent(slot.ctxTotal === 0 ? 0 : slot.promptTokens / slot.ctxTotal),
    detail: processing
      ? `${slot.promptTokens} / ${ctx} ctx · ${slot.decoded} decoded`
      : `${ctx} ctx · idle`,
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
    // The busiest lane is the overflow signal — one full lane matters even when
    // the others are empty — so the group reduces to its max fill, not a mean.
    const peakPct = dots.reduce((hi, dot) => Math.max(hi, dot.headroomPct), 0);
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
      total: dots.length,
      summary: `${busy}/${dots.length} busy`,
      rateLabel,
      peakPct,
      peakLabel: `${peakPct}%`,
      peakColor: contextHeadroomColor(peakPct),
      slots: dots,
    });
  }

  const busyTotal = groups.reduce((sum, group) => sum + group.busy, 0);
  const slotTotal = groups.reduce((sum, group) => sum + group.total, 0);
  // Worst-case fill across the lanes that are actually working; an idle group
  // holds no context, so it never sets the peak.
  const peak = groups.reduce((hi, group) => (group.busy > 0 ? Math.max(hi, group.peakPct) : hi), 0);
  const peakClause = busyTotal > 0 ? ` · peak ${peak}% ctx` : "";
  return {
    groups,
    empty: groups.length === 0,
    emptyLabel: "no models loaded",
    totalSummary: `${busyTotal} of ${slotTotal} busy${peakClause}`,
  };
}

/** Builds the whole dashboard view model for one repaint. */
export function selectDashboard(snapshot: Snapshot, ui: UiState, now: number): DashboardVm {
  const activeModel =
    ui.filterModel === null ? undefined : snapshot.models.find((m) => m.id === ui.filterModel);
  const lines = selectLines(snapshot, ui);
  const allSelected = ui.filterModel === null;

  return {
    service: selectService(snapshot, ui),
    gauges: selectGauges(snapshot),
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
    toolbar: selectToolbar(ui, lines.length, activeModel),
    lines,
    slots: selectSlots(snapshot),
  };
}

/** The copy/download payload for what the console is currently showing. */
export function selectLogText(vm: DashboardVm): string {
  return formatLogText(vm.lines);
}
