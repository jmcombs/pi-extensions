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
  formatPercent,
  formatTemperature,
  formatUptime,
  temperatureBarPercent,
  temperatureColor,
} from "./format.js";
import type { LevelFilter, UiState } from "./state.js";
import { visibleBuffer } from "./state.js";
import type {
  ConfigEntry,
  LogLevel,
  ModelAction,
  ModelInfo,
  ModelRole,
  ServiceAction,
  Snapshot,
} from "./types.js";

/**
 * How many filtered lines reach the DOM. The buffer holds more; painting all of
 * it buys nothing an operator can read and costs a layout on every append.
 */
export const LOG_RENDER_LIMIT = 200;

/** Requests tile: the bar reads full at this many requests per minute. */
const REQUESTS_FULL_SCALE = 30;

/** Throughput tile: the bar reads full at this many tokens per second. */
const THROUGHPUT_FULL_SCALE = 120;

/** A model's color follows its role, so the four roles are always tellable apart. */
const ROLE_COLORS: Record<ModelRole, string> = {
  chat: "var(--latte-mauve)",
  reason: "var(--latte-teal)",
  fim: "var(--latte-peach)",
  embed: "var(--latte-blue)",
};

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

export function modelColor(role: ModelRole): string {
  return ROLE_COLORS[role];
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

export interface SlotCardVm {
  id: number;
  label: string;
  state: string;
  stateBackground: string;
  stateColor: string;
  modelLabel: string;
  modelColor: string;
  /** `pi · edit-session · 12.4k · 268 tok` */
  detail: string;
}

export interface SlotsVm {
  /** `2 of 4 processing` */
  summary: string;
  cards: SlotCardVm[];
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

function selectModels(snapshot: Snapshot, ui: UiState): ModelCardVm[] {
  return snapshot.models.map((model) => {
    const color = modelColor(model.role);
    const selected = ui.filterModel === model.id;
    const loaded = model.status !== "unloaded";
    const pendingAction = ui.pendingModels[model.id];
    const rate =
      model.status === "unloaded"
        ? "—"
        : model.status === "active" && model.tokensPerSecond !== null
          ? `${Math.round(model.tokensPerSecond)} t/s`
          : "idle";

    return {
      id: model.id,
      short: model.short,
      meta: formatModelMeta(model),
      color,
      selected,
      cardBackground: selected ? tint(color, 10) : "var(--surface-page)",
      cardBorder: selected ? tint(color, 50) : "var(--border)",
      footerLabel: `${model.status} · ${rate}`,
      footerColor:
        model.status === "active"
          ? "var(--success)"
          : model.status === "resident"
            ? "var(--text-tertiary)"
            : "var(--text-subtle)",
      buttonAction: loaded ? "unload" : "load",
      buttonLabel:
        pendingAction === "unload"
          ? "Unloading…"
          : pendingAction === "load"
            ? "Loading…"
            : loaded
              ? "Unload"
              : "Load",
      buttonBackground: loaded ? "var(--surface-page)" : "var(--accent)",
      buttonColor: loaded ? "var(--error)" : "var(--accent-fg)",
      buttonBorder: loaded ? tint("var(--error)", 40) : "var(--accent)",
      pending: pendingAction !== undefined,
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
          : modelColor(model.role),
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
  const activeColor = activeModel === undefined ? "var(--accent)" : modelColor(activeModel.role);

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

function selectSlots(snapshot: Snapshot): SlotsVm {
  const models = new Map(snapshot.models.map((m) => [m.id, m]));
  const running = snapshot.service.running;

  const cards = snapshot.slots.map((slot) => {
    const model = slot.modelId === null ? undefined : models.get(slot.modelId);
    // A slot cannot be working if its model went away or the service stopped,
    // whatever the last poll said.
    const dormant = model === undefined || model.status === "unloaded" || !running;
    const state = dormant ? "idle" : slot.state;
    const processing = state === "processing";
    const tokens = processing ? `${slot.tokens} tok` : "—";

    return {
      id: slot.id,
      label: `slot ${slot.id}`,
      state,
      stateBackground: processing ? tint("var(--success)", 16) : "var(--surface-raised)",
      stateColor: processing ? "var(--success)" : "var(--text-tertiary)",
      modelLabel: model?.short ?? "free",
      modelColor: model !== undefined && !dormant ? modelColor(model.role) : "var(--text-subtle)",
      detail: `${slot.client} · ${slot.ctxUsed} · ${tokens}`,
    };
  });

  const busy = cards.filter((c) => c.state === "processing").length;
  return { summary: `${busy} of ${cards.length} processing`, cards };
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
