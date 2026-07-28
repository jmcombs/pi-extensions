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
import type { ConfigEntry, LogLevel, ModelAction, ModelInfo, SlotInfo, Snapshot } from "./types.js";

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
    config: snapshot.config,
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
