import { describe, expect, it } from "vitest";
import { LOG_RENDER_LIMIT, selectDashboard, selectLogText } from "./select.js";
import type { UiState } from "./state.js";
import { initialUiState, reduce } from "./state.js";
import type { LogLine, ModelInfo, Snapshot } from "./types.js";

const NOW = new Date(2024, 0, 15, 9, 4, 7, 42).getTime();
const STARTED = NOW - (3 * 3_600_000 + 34 * 60_000);

const CHAT = "qwen3.6-moe-a3b-instruct-q4_k_m";
const REASON = "qwen3.6-moe-30b-thinking-q5_k_m";
const EMBED = "nomic-embed-text-v1.5-f16";

const MODELS: ModelInfo[] = [
  {
    id: CHAT,
    short: "qwen3.6-moe-a3b-instruct",
    role: "chat",
    quant: "Q4_K_M",
    sizeGB: 18.4,
    ctx: 65536,
    gpuLayers: 48,
    detail: null,
    parallel: 4,
    flashAttn: "on",
    kvCache: "q8_0/q8_0",
    status: "active",
    tokensPerSecond: 63.4,
  },
  {
    id: REASON,
    short: "qwen3.6-moe-30b-thinking",
    role: "reason",
    quant: "Q5_K_M",
    sizeGB: 22.1,
    ctx: 32768,
    gpuLayers: 48,
    detail: null,
    parallel: 2,
    flashAttn: "on",
    kvCache: "q8_0/q8_0",
    status: "resident",
    tokensPerSecond: null,
  },
  {
    id: EMBED,
    short: "nomic-embed-text-v1.5",
    role: "embed",
    quant: "F16",
    sizeGB: 0.5,
    ctx: 8192,
    gpuLayers: null,
    detail: "pooling mean",
    parallel: 1,
    flashAttn: "off",
    kvCache: "f16/f16",
    status: "unloaded",
    tokensPerSecond: null,
  },
];

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    now: NOW,
    service: {
      running: true,
      startedAt: STARTED,
      pid: 4821,
      host: "127.0.0.1",
      port: 8080,
      build: "b6122",
    },
    models: MODELS,
    slots: [
      {
        id: 0,
        modelId: CHAT,
        client: "pi · edit-session",
        ctxUsed: "12.4k",
        tokens: 268,
        state: "processing",
      },
      {
        id: 1,
        modelId: REASON,
        client: "pi · plan-agent",
        ctxUsed: "21.8k",
        tokens: 0,
        state: "idle",
      },
      { id: 2, modelId: null, client: "—", ctxUsed: "—", tokens: 0, state: "idle" },
    ],
    metrics: {
      vramUsedGB: 29.83,
      vramTotalGB: 48,
      ramUsedGB: 52.4,
      ramTotalGB: 128,
      gpuUtil: 0.78,
      cpuUtil: 0.17,
      gpuTempC: 64,
      cpuTempC: 47,
    },
    throughputTps: 72,
    requestsPerMinute: 14,
    throughputHistory: [40, 60, 80],
    sessions: 3,
    config: [{ key: "binary", value: "llama-server b6122" }],
    ...overrides,
  };
}

function logLine(seq: number, over: Partial<LogLine> = {}): LogLine {
  return {
    seq,
    ts: NOW,
    level: "INFO",
    modelId: CHAT,
    message: `slot launch_slot_: id 0 | task ${seq} | processing task`,
    ...over,
  };
}

function withLines(ui: UiState, lines: LogLine[]): UiState {
  return reduce(ui, { type: "logs/append", lines });
}

describe("service block", () => {
  it("reads as running with a live uptime", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light"), NOW);
    expect(vm.service.stateLabel).toBe("running");
    expect(vm.service.uptimeLabel).toBe("uptime 3h 34m");
    expect(vm.service.engineLine).toBe("llama.cpp b6122 · 127.0.0.1:8080");
    expect(vm.service.controlAction).toBe("stop");
    expect(vm.service.controlLabel).toBe("Stop service");
    expect(vm.service.dotColor).toBe("var(--success)");
  });

  it("flips to start when the service is down", () => {
    const down = snapshot({
      service: {
        running: false,
        startedAt: null,
        pid: null,
        host: "127.0.0.1",
        port: 8080,
        build: "b6122",
      },
    });
    const vm = selectDashboard(down, initialUiState("light"), NOW);
    expect(vm.service.controlAction).toBe("start");
    expect(vm.service.controlLabel).toBe("Start service");
    expect(vm.service.controlBackground).toBe("var(--accent)");
    expect(vm.service.uptimeLabel).toBe("uptime —");
    expect(vm.service.dotColor).toBe("var(--error)");
  });

  it("announces the in-flight action instead of flipping early", () => {
    const ui = reduce(initialUiState("light"), { type: "service/pending", action: "stop" });
    const vm = selectDashboard(snapshot(), ui, NOW);
    expect(vm.service.controlLabel).toBe("Stopping…");
    expect(vm.service.pending).toBe(true);
    // The service is still up until the next snapshot says otherwise.
    expect(vm.service.stateLabel).toBe("running");
  });
});

describe("host gauges", () => {
  it("renders the six gauges the design specifies", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light"), NOW);
    expect(vm.gauges.map((g) => g.key)).toEqual([
      "vram",
      "gpu",
      "gpu-temp",
      "ram",
      "cpu",
      "cpu-temp",
    ]);
    expect(vm.gauges[0]?.value).toBe("29.8 / 48 GB");
    expect(vm.gauges[0]?.percent).toBe(62);
    expect(vm.gauges[3]?.value).toBe("52 / 128 GB");
    expect(vm.gauges[2]?.value).toBe("64°C");
    expect(vm.gauges[2]?.color).toBe("var(--success)");
    expect(vm.gauges[2]?.percent).toBe(52);
  });

  it("hides temperature rows the host cannot supply", () => {
    const s = snapshot();
    const vm = selectDashboard(
      snapshot({ metrics: { ...s.metrics, gpuTempC: null, cpuTempC: null } }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.gauges.map((g) => g.key)).toEqual(["vram", "gpu", "ram", "cpu"]);
  });

  it("dashes a memory gauge the host could not read, and empties its bar", () => {
    const s = snapshot();
    const vm = selectDashboard(
      snapshot({ metrics: { ...s.metrics, vramUsedGB: Number.NaN } }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.gauges[0]?.value).toBe("—");
    expect(vm.gauges[0]?.percent).toBe(0);
    // The readings either side of it are unaffected.
    expect(vm.gauges[3]?.value).toBe("52 / 128 GB");
  });

  it("drops a temperature row that is not a reading, the same as a missing one", () => {
    const s = snapshot();
    const vm = selectDashboard(
      snapshot({ metrics: { ...s.metrics, gpuTempC: Number.NaN } }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.gauges.map((g) => g.key)).toEqual(["vram", "gpu", "ram", "cpu", "cpu-temp"]);
  });

  it("escalates the gauge color past the thresholds", () => {
    const s = snapshot();
    const vm = selectDashboard(
      snapshot({ metrics: { ...s.metrics, gpuTempC: 88, cpuTempC: 79 } }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.gauges[2]?.color).toBe("var(--error)");
    expect(vm.gauges[5]?.color).toBe("var(--warning)");
  });
});

describe("model cards", () => {
  it("summarises status and rate the way the card footer reads", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light"), NOW);
    expect(vm.models.map((m) => m.footerLabel)).toEqual([
      "active · 63 t/s",
      "resident · idle",
      "unloaded · —",
    ]);
    expect(vm.models[0]?.meta).toBe("Q4_K_M · 18.4 GB · ctx 65536 · 48 gpu layers");
    expect(vm.models[2]?.meta).toBe("F16 · 0.5 GB · ctx 8192 · pooling mean");
  });

  it("carries each model's preset tuning as a second meta line", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light"), NOW);
    expect(vm.models[0]?.tuning).toBe("4 slots · flash on · kv q8_0/q8_0");
    expect(vm.models[2]?.tuning).toBe("1 slots · flash off · kv f16/f16");
  });

  it("offers Unload for resident models and Load for unloaded ones", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light"), NOW);
    expect(vm.models[0]?.buttonAction).toBe("unload");
    expect(vm.models[0]?.buttonColor).toBe("var(--error)");
    expect(vm.models[2]?.buttonAction).toBe("load");
    expect(vm.models[2]?.buttonBackground).toBe("var(--accent)");
  });

  it("shows a pending label on the model being acted on, and only that one", () => {
    const ui = reduce(initialUiState("light"), {
      type: "model/pending",
      modelId: EMBED,
      action: "load",
    });
    const vm = selectDashboard(snapshot(), ui, NOW);
    expect(vm.models[2]?.buttonLabel).toBe("Loading…");
    expect(vm.models[2]?.pending).toBe(true);
    expect(vm.models[0]?.buttonLabel).toBe("Unload");
    expect(vm.models[0]?.pending).toBe(false);
  });

  it("tints the selected card in the model's own color", () => {
    const ui = reduce(initialUiState("light"), { type: "filter/model-toggle", modelId: REASON });
    const vm = selectDashboard(snapshot(), ui, NOW);
    expect(vm.models[1]?.selected).toBe(true);
    expect(vm.models[1]?.cardBackground).toBe(
      "color-mix(in srgb, var(--latte-teal) 10%, transparent)",
    );
    expect(vm.models[1]?.cardBorder).toBe("color-mix(in srgb, var(--latte-teal) 50%, transparent)");
    expect(vm.models[0]?.cardBackground).toBe("var(--surface-page)");
    expect(vm.allLogsPill.active).toBe(false);
  });
});

describe("KPI tiles", () => {
  it("scales each tile against its own ceiling", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light"), NOW);
    expect(vm.kpis[0]).toMatchObject({
      value: "3h 34m",
      unit: "uptime",
      sub: "pid 4821 · port 8080",
      percent: 100,
    });
    expect(vm.kpis[1]).toMatchObject({ value: "14", sub: "pi agent · 3 sessions", percent: 47 });
    expect(vm.kpis[2]).toMatchObject({ value: "72", unit: "tok/s", percent: 60 });
  });

  it("zeroes the tiles while the service is stopped", () => {
    const down = snapshot({
      service: {
        running: false,
        startedAt: null,
        pid: null,
        host: "127.0.0.1",
        port: 8080,
        build: "b6122",
      },
    });
    const vm = selectDashboard(down, initialUiState("light"), NOW);
    expect(vm.kpis[0]).toMatchObject({ value: "stopped", unit: "", sub: "no process", percent: 0 });
    expect(vm.kpis[1]?.value).toBe("0");
    expect(vm.kpis[2]?.value).toBe("0");
  });

  it("rounds the counters a live source reports to the whole numbers a tile shows", () => {
    const vm = selectDashboard(
      snapshot({ throughputTps: 61.837, requestsPerMinute: 13.5 }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.kpis[1]?.value).toBe("14");
    expect(vm.kpis[2]?.value).toBe("62");
    expect(vm.kpis[2]?.percent).toBe(52);
  });

  it("dashes a counter the source could not supply instead of printing NaN", () => {
    const vm = selectDashboard(
      snapshot({ throughputTps: Number.NaN, requestsPerMinute: Number.NaN }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.kpis[1]?.value).toBe("—");
    expect(vm.kpis[1]?.percent).toBe(0);
    expect(vm.kpis[2]?.value).toBe("—");
    expect(vm.kpis[2]?.percent).toBe(0);
  });
});

describe("throughput history", () => {
  it("plots each sample against the window's peak and marks the newest bar", () => {
    const vm = selectDashboard(
      snapshot({ throughputHistory: [40, 60, 80] }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.spark.bars.map((b) => b.height)).toEqual([50, 75, 100]);
    expect(vm.spark.bars.at(-1)?.color).toBe("var(--accent)");
    expect(vm.spark.bars[0]?.color).toBe("color-mix(in srgb, var(--accent) 38%, transparent)");
  });

  it("puts the dashed rule at the average's height", () => {
    const vm = selectDashboard(
      snapshot({ throughputHistory: [40, 60, 80] }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.spark.summary).toBe("avg 60 · peak 80 tok/s");
    expect(vm.spark.averageLine).toBe(75);
  });

  it("survives an all-zero window without dividing by zero", () => {
    const vm = selectDashboard(
      snapshot({ throughputHistory: [0, 0, 0] }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.spark.bars.map((b) => b.height)).toEqual([0, 0, 0]);
    expect(vm.spark.summary).toBe("avg 0 · peak 1 tok/s");
  });
});

describe("the filter stack", () => {
  const lines = [
    logLine(1, { modelId: CHAT, level: "INFO", message: "slot launch_slot_: processing task" }),
    logLine(2, { modelId: REASON, level: "WARN", message: "slot update_slots: context shift" }),
    logLine(3, { modelId: REASON, level: "INFO", message: "eval time = 1500.00 ms / 60 runs" }),
    logLine(4, {
      modelId: CHAT,
      level: "ERROR",
      message: "srv send_error: prompt exceeds Context",
    }),
  ];

  function seqs(ui: UiState): number[] {
    return selectDashboard(snapshot(), ui, NOW).lines.map((l) => l.seq);
  }

  it("scopes to one model", () => {
    const ui = reduce(withLines(initialUiState("light"), lines), {
      type: "filter/model-toggle",
      modelId: REASON,
    });
    expect(seqs(ui)).toEqual([2, 3]);
  });

  it("scopes to one level", () => {
    const ui = reduce(withLines(initialUiState("light"), lines), {
      type: "filter/level",
      level: "ERROR",
    });
    expect(seqs(ui)).toEqual([4]);
  });

  it("matches the message case-insensitively and ignores surrounding space", () => {
    const ui = reduce(withLines(initialUiState("light"), lines), {
      type: "filter/query",
      query: "  CONTEXT  ",
    });
    expect(seqs(ui)).toEqual([2, 4]);
  });

  it("never matches the query against the model name or level", () => {
    const ui = reduce(withLines(initialUiState("light"), lines), {
      type: "filter/query",
      query: "thinking",
    });
    expect(seqs(ui)).toEqual([]);
  });

  it("stacks model, level and search together", () => {
    let ui = withLines(initialUiState("light"), lines);
    ui = reduce(ui, { type: "filter/model-toggle", modelId: REASON });
    ui = reduce(ui, { type: "filter/level", level: "INFO" });
    ui = reduce(ui, { type: "filter/query", query: "eval" });
    expect(seqs(ui)).toEqual([3]);
    expect(selectDashboard(snapshot(), ui, NOW).toolbar.lineCountLabel).toBe("1 lines");
  });

  it("keeps showing the frozen buffer while paused", () => {
    let ui = withLines(initialUiState("light"), lines);
    ui = reduce(ui, { type: "logs/pause-toggle" });
    ui = withLines(ui, [logLine(5, { message: "arrived after the pause" })]);
    expect(seqs(ui)).toEqual([1, 2, 3, 4]);
    expect(seqs(reduce(ui, { type: "logs/pause-toggle" }))).toEqual([1, 2, 3, 4, 5]);
  });

  it("renders at most the newest LOG_RENDER_LIMIT matches", () => {
    const many = Array.from({ length: LOG_RENDER_LIMIT + 25 }, (_, i) => logLine(i + 1));
    const ui = withLines(initialUiState("light"), many);
    const rendered = seqs(ui);
    expect(rendered).toHaveLength(LOG_RENDER_LIMIT);
    expect(rendered.at(-1)).toBe(LOG_RENDER_LIMIT + 25);
  });
});

describe("log rows", () => {
  it("colors the model column while all models are shown", () => {
    const ui = withLines(initialUiState("light"), [logLine(1)]);
    const row = selectDashboard(snapshot(), ui, NOW).lines[0];
    expect(row?.time).toBe("09:04:07.042");
    expect(row?.model).toBe("qwen3.6-moe-a3b-instruct");
    expect(row?.modelColor).toBe("var(--latte-mauve)");
    expect(row?.levelColor).toBe("var(--info)");
  });

  it("mutes the model column once the console is scoped to one model", () => {
    let ui = withLines(initialUiState("light"), [logLine(1)]);
    ui = reduce(ui, { type: "filter/model-toggle", modelId: CHAT });
    expect(selectDashboard(snapshot(), ui, NOW).lines[0]?.modelColor).toBe("var(--text-muted)");
  });

  it("marks lines that belong to no model", () => {
    const ui = withLines(initialUiState("light"), [logLine(1, { modelId: null })]);
    const row = selectDashboard(snapshot(), ui, NOW).lines[0];
    expect(row?.model).toBe("—");
    expect(row?.modelColor).toBe("var(--text-muted)");
  });
});

describe("toolbar", () => {
  it("mirrors the model selection in the active pill", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light"), NOW);
    expect(vm.toolbar.activeModelLabel).toBe("all models");
    expect(vm.toolbar.activeModelColor).toBe("var(--accent)");

    const ui = reduce(initialUiState("light"), { type: "filter/model-toggle", modelId: CHAT });
    const scoped = selectDashboard(snapshot(), ui, NOW);
    expect(scoped.toolbar.activeModelLabel).toBe("qwen3.6-moe-a3b-instruct");
    expect(scoped.toolbar.activeModelColor).toBe("var(--latte-mauve)");
  });

  it("marks exactly one level chip active", () => {
    const ui = reduce(initialUiState("light"), { type: "filter/level", level: "WARN" });
    const chips = selectDashboard(snapshot(), ui, NOW).toolbar.levelChips;
    expect(chips.map((c) => c.label)).toEqual(["all levels", "INFO", "WARN", "ERROR"]);
    expect(chips.filter((c) => c.active).map((c) => c.level)).toEqual(["WARN"]);
    expect(chips[2]?.color).toBe("var(--warning)");
  });

  it("labels pause and copy from state", () => {
    let ui = reduce(initialUiState("light"), { type: "logs/pause-toggle" });
    ui = reduce(ui, { type: "copy/flag", copied: true });
    const vm = selectDashboard(snapshot(), ui, NOW);
    expect(vm.toolbar.pauseLabel).toBe("Resume");
    expect(vm.toolbar.pauseColor).toBe("var(--warning)");
    expect(vm.toolbar.copyLabel).toBe("Copied");
  });
});

describe("slots strip", () => {
  it("counts the working slots and names the free ones", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light"), NOW);
    expect(vm.slots.summary).toBe("1 of 3 processing");
    expect(vm.slots.cards[0]).toMatchObject({
      label: "slot 0",
      state: "processing",
      modelLabel: "qwen3.6-moe-a3b-instruct",
      modelColor: "var(--latte-mauve)",
      detail: "pi · edit-session · 12.4k · 268 tok",
    });
    expect(vm.slots.cards[1]?.detail).toBe("pi · plan-agent · 21.8k · —");
    expect(vm.slots.cards[2]).toMatchObject({
      modelLabel: "free",
      modelColor: "var(--text-subtle)",
    });
  });

  it("idles every slot while the service is down", () => {
    const down = snapshot({
      service: {
        running: false,
        startedAt: null,
        pid: null,
        host: "127.0.0.1",
        port: 8080,
        build: "b6122",
      },
    });
    const vm = selectDashboard(down, initialUiState("light"), NOW);
    expect(vm.slots.summary).toBe("0 of 3 processing");
    expect(vm.slots.cards.every((c) => c.state === "idle")).toBe(true);
  });

  it("idles slots whose model was unloaded", () => {
    const models = MODELS.map((m) => (m.id === CHAT ? { ...m, status: "unloaded" as const } : m));
    const vm = selectDashboard(snapshot({ models }), initialUiState("light"), NOW);
    expect(vm.slots.cards[0]?.state).toBe("idle");
    expect(vm.slots.cards[0]?.modelColor).toBe("var(--text-subtle)");
  });
});

describe("selectLogText", () => {
  it("exports the filtered console as `HH:MM:SS.mmm LEVEL model message`", () => {
    let ui = withLines(initialUiState("light"), [
      logLine(1, { message: "processing task" }),
      logLine(2, { modelId: REASON, level: "WARN", message: "context shift" }),
    ]);
    ui = reduce(ui, { type: "filter/level", level: "WARN" });
    expect(selectLogText(selectDashboard(snapshot(), ui, NOW))).toBe(
      "09:04:07.042 WARN qwen3.6-moe-30b-thinking context shift",
    );
  });
});
