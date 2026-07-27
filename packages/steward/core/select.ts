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

import {
  barPercent,
  formatClock,
  formatLogText,
  formatMemory,
  formatModelMeta,
  formatModelTuning,
  formatPercent,
  formatTemperature,
  formatTokenCount,
  formatTps,
  formatUptime,
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

/** Requests tile: the bar reads full at this many requests per minute. */
const REQUESTS_FULL_SCALE = 30;

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

export interface ServiceVm {
  running: boolean;
  dotColor: string;
  /** `llama.cpp b6122 · 127.0.0.1:8080` */
  engineLine: string;
  /** Which way the primary button will move the service. */
  controlAction: ServiceAction;
  controlLabel: string;
  controlBackground: string;
  controlColor: string;
  restartLabel: string;
  /** True while any service action is in flight; every control disables. */
  pending: boolean;
  stateLabel: string;
  uptimeLabel: string;
  themeGlyph: string;
  themeLabel: string;
}

export interface GaugeVm {
  key: string;
  label: string;
  value: string;
  percent: number;
  color: string;
}

export interface ModelCardVm {
  id: string;
  short: string;
  meta: string;
  /** Second meta line: the model's preset tuning, e.g. `4 slots · flash on · kv q8_0/q8_0`. */
  tuning: string;
  color: string;
  selected: boolean;
  cardBackground: string;
  cardBorder: string;
  /** `active · 63 t/s`, `resident · idle`, `unloaded · —` */
  footerLabel: string;
  footerColor: string;
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
  slots: SlotDotVm[];
}

export interface SlotsVm {
  /** One group per loaded model, in models order. */
  groups: SlotGroupVm[];
  /** True when no model is loaded (no groups). */
  empty: boolean;
  emptyLabel: string;
  /** `3 of 8 processing`, summed across every group. */
  totalSummary: string;
}

export interface DashboardVm {
  service: ServiceVm;
  gauges: GaugeVm[];
  models: ModelCardVm[];
  allLogsPill: PillVm;
  config: ConfigEntry[];
  kpis: KpiVm[];
  spark: SparkVm;
  toolbar: ToolbarVm;
  lines: LogRowVm[];
  slots: SlotsVm;
}

function selectService(snapshot: Snapshot, ui: UiState, now: number): ServiceVm {
  const { service } = snapshot;
  const running = service.running;
  const pending = ui.pendingService !== null;
  const uptime = service.startedAt === null ? "—" : formatUptime(now - service.startedAt);
  const controlAction: ServiceAction = running ? "stop" : "start";
  const pendingLabel =
    ui.pendingService === "start" ? "Starting…" : ui.pendingService === "stop" ? "Stopping…" : null;

  return {
    running,
    dotColor: running ? "var(--success)" : "var(--error)",
    engineLine: `llama.cpp ${service.build} · ${service.host}:${service.port}`,
    controlAction,
    controlLabel: pendingLabel ?? (running ? "Stop service" : "Start service"),
    controlBackground: running ? tint("var(--error)", 14) : "var(--accent)",
    controlColor: running ? "var(--error)" : "var(--accent-fg)",
    restartLabel: ui.pendingService === "restart" ? "Restarting…" : "Restart",
    pending,
    stateLabel: running ? "running" : "stopped",
    uptimeLabel: `uptime ${uptime}`,
    themeGlyph: ui.theme === "dark" ? "☀" : "☾",
    themeLabel: ui.theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
  };
}

function selectGauges(snapshot: Snapshot): GaugeVm[] {
  const m = snapshot.metrics;
  const gauges: GaugeVm[] = [
    {
      key: "vram",
      label: "VRAM",
      value: memoryLabel(m.vramUsedGB, m.vramTotalGB, 1),
      percent: barPercent(m.vramTotalGB === 0 ? 0 : m.vramUsedGB / m.vramTotalGB),
      color: "var(--latte-teal)",
    },
    {
      key: "gpu",
      label: "GPU",
      value: formatPercent(m.gpuUtil),
      percent: barPercent(m.gpuUtil),
      color: "var(--latte-mauve)",
    },
  ];
  // Temperatures come from host sensors, not llama.cpp. Where the platform
  // cannot supply them the design drops the row rather than plotting a zero,
  // and a reading that is not a number is no more of a reading than `null`.
  if (m.gpuTempC !== null && Number.isFinite(m.gpuTempC)) {
    gauges.push({
      key: "gpu-temp",
      label: "GPU temp",
      value: formatTemperature(m.gpuTempC),
      percent: temperatureBarPercent(m.gpuTempC),
      color: temperatureColor(m.gpuTempC),
    });
  }
  gauges.push(
    {
      key: "ram",
      label: "RAM",
      value: memoryLabel(m.ramUsedGB, m.ramTotalGB, 0),
      percent: barPercent(m.ramTotalGB === 0 ? 0 : m.ramUsedGB / m.ramTotalGB),
      color: "var(--accent)",
    },
    {
      key: "cpu",
      label: "CPU",
      value: formatPercent(m.cpuUtil),
      percent: barPercent(m.cpuUtil),
      color: "var(--latte-peach)",
    },
  );
  if (m.cpuTempC !== null && Number.isFinite(m.cpuTempC)) {
    gauges.push({
      key: "cpu-temp",
      label: "CPU temp",
      value: formatTemperature(m.cpuTempC),
      percent: temperatureBarPercent(m.cpuTempC),
      color: temperatureColor(m.cpuTempC),
    });
  }
  return gauges;
}

/** The card footer: status word plus, when active, the live generation rate. */
function modelFooter(model: ModelInfo): { label: string; color: string } {
  switch (model.status) {
    case "active":
      return { label: `active · ${formatTps(model.tokensPerSecond)}`, color: "var(--success)" };
    case "resident":
      return { label: "resident · idle", color: "var(--text-tertiary)" };
    case "loading":
      return { label: "loading…", color: "var(--text-secondary)" };
    case "downloading":
      return { label: "downloading…", color: "var(--text-secondary)" };
    default:
      return { label: "unloaded · —", color: "var(--text-subtle)" };
  }
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
    const footer = modelFooter(model);

    return {
      id: model.id,
      short: model.short,
      meta: formatModelMeta(model),
      // Tuning is a loaded-model fact; unloaded (and in-flight) cards hide it.
      tuning:
        model.status === "active" || model.status === "resident" ? formatModelTuning(model) : "",
      color,
      selected,
      cardBackground: selected ? tint(color, 10) : "var(--surface-page)",
      cardBorder: selected ? tint(color, 50) : "var(--border)",
      footerLabel: footer.label,
      footerColor: footer.color,
      buttonAction: loaded ? "unload" : "load",
      buttonLabel:
        pendingAction === "unload"
          ? "Unloading…"
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
  const pid = service.pid === null ? "no process" : `pid ${service.pid} · port ${service.port}`;

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
      value: running ? countLabel(snapshot.requestsPerMinute) : "0",
      unit: "req/min",
      sub: `pi agent · ${snapshot.sessions} sessions`,
      color: "var(--accent)",
      percent: barPercent((running ? snapshot.requestsPerMinute : 0) / REQUESTS_FULL_SCALE),
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
    groups.push({
      modelId: model.id,
      modelLabel: model.short,
      modelColor: modelColor(model.id, model.embedding),
      busy,
      total: dots.length,
      summary: `${busy}/${dots.length} busy`,
      slots: dots,
    });
  }

  const busyTotal = groups.reduce((sum, group) => sum + group.busy, 0);
  const slotTotal = groups.reduce((sum, group) => sum + group.total, 0);
  return {
    groups,
    empty: groups.length === 0,
    emptyLabel: "no models loaded",
    totalSummary: `${busyTotal} of ${slotTotal} busy`,
  };
}

/** Builds the whole dashboard view model for one repaint. */
export function selectDashboard(snapshot: Snapshot, ui: UiState, now: number): DashboardVm {
  const activeModel =
    ui.filterModel === null ? undefined : snapshot.models.find((m) => m.id === ui.filterModel);
  const lines = selectLines(snapshot, ui);
  const allSelected = ui.filterModel === null;

  return {
    service: selectService(snapshot, ui, now),
    gauges: selectGauges(snapshot),
    models: selectModels(snapshot, ui),
    allLogsPill: {
      label: "all logs",
      active: allSelected,
      background: allSelected ? tint("var(--accent)", 16) : "var(--surface-page)",
      color: allSelected ? "var(--accent)" : "var(--text-tertiary)",
      borderColor: allSelected ? tint("var(--accent)", 45) : "var(--border)",
    },
    config: snapshot.config,
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
