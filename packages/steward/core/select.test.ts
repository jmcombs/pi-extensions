import { describe, expect, it } from "vitest";
import { modelColor } from "./model-color.js";
import { LOG_RENDER_LIMIT, selectDashboard, selectLogText } from "./select.js";
import type { UiState } from "./state.js";
import { initialUiState, reduce } from "./state.js";
import type { LogLine, ModelInfo, ServiceAction, Snapshot } from "./types.js";

const NOW = new Date(2024, 0, 15, 9, 4, 7, 42).getTime();
const STARTED = NOW - (3 * 3_600_000 + 34 * 60_000);

const CHAT = "qwen3.6-moe-a3b-instruct-q4_k_m";
const REASON = "qwen3.6-moe-30b-thinking-q5_k_m";
const EMBED = "nomic-embed-text-v1.5-f16";

const MODELS: ModelInfo[] = [
  {
    id: CHAT,
    short: "qwen3.6-moe-a3b-instruct",
    embedding: false,
    quant: "Q4_K_M",
    sizeGB: 18.4,
    ctx: 65536,
    nativeCtx: 262144,
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
    embedding: false,
    quant: "Q5_K_M",
    sizeGB: 22.1,
    ctx: 32768,
    nativeCtx: 262144,
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
    embedding: true,
    quant: "F16",
    // Unloaded: llama.cpp ships no `meta`, so size, ctx and native window are all unknown.
    sizeGB: null,
    ctx: null,
    nativeCtx: null,
    gpuLayers: null,
    detail: "embedding",
    parallel: null,
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
      controls: ["start", "stop", "restart"],
    },
    models: MODELS,
    slots: [
      {
        id: 0,
        modelId: CHAT,
        promptTokens: 12408,
        ctxTotal: 65536,
        decoded: 268,
        state: "processing",
      },
      { id: 1, modelId: CHAT, promptTokens: 0, ctxTotal: 65536, decoded: 0, state: "idle" },
      { id: 0, modelId: REASON, promptTokens: 0, ctxTotal: 32768, decoded: 0, state: "idle" },
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
    memoryTopology: "discrete",
    throughputTps: 72,
    requestsInFlight: 2,
    throughputHistory: [40, 60, 80],
    requestsQueued: 1,
    config: [{ key: "engine", value: "llama-server b6122" }],
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
  it("reads as started and folds the router facts onto the VM", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light"), NOW);
    expect(vm.service.running).toBe(true);
    expect(vm.service.statusLabel).toBe("started");
    expect(vm.service.statusColor).toBe("var(--success)");
    // Uptime and pid are the metrics band's tile now, not the rail — the block
    // carries only state and the folded-in CONFIG rows.
    expect(vm.service).not.toHaveProperty("runtimeLine");
    expect(vm.service.config).toEqual([{ key: "engine", value: "llama-server b6122" }]);
  });

  it("reads as stopped when the service is down", () => {
    const down = snapshot({
      service: {
        running: false,
        startedAt: null,
        pid: null,
        host: "127.0.0.1",
        port: 8080,
        build: "b6122",
        controls: ["start", "stop", "restart"],
      },
    });
    const vm = selectDashboard(down, initialUiState("light"), NOW);
    expect(vm.service.statusLabel).toBe("stopped");
    expect(vm.service.statusColor).toBe("var(--error)");
  });

  it("reports the current theme mode in the toggle glyph and label", () => {
    const glyph = (theme: "system" | "light" | "dark") =>
      selectDashboard(snapshot(), initialUiState(theme), NOW).service.themeGlyph;
    expect(glyph("system")).toBe("◐");
    expect(glyph("light")).toBe("☀");
    expect(glyph("dark")).toBe("☾");

    const vm = selectDashboard(snapshot(), initialUiState("system"), NOW);
    expect(vm.service.themeLabel).toContain("System");
  });
});

describe("service controls", () => {
  /** The snapshot's service block with `controls` (and optionally state) replaced. */
  function withControls(controls: ServiceAction[], running = true): Snapshot {
    return snapshot({
      service: {
        running,
        startedAt: running ? STARTED : null,
        pid: running ? 4821 : null,
        host: "127.0.0.1",
        port: 8080,
        build: "b6122",
        controls,
      },
    });
  }

  it("offers exactly the consented actions, in start/stop/restart order", () => {
    const vm = selectDashboard(withControls(["restart", "start"]), initialUiState("light"), NOW);
    expect(vm.service.controls.buttons.map((b) => b.action)).toEqual(["start", "restart"]);
    expect(vm.service.controls.buttons.map((b) => b.label)).toEqual(["Start", "Restart"]);
    expect(vm.service.controls.setup).toBeNull();
  });

  it("shows one setup affordance — not dead buttons — when control is not configured", () => {
    const vm = selectDashboard(withControls([]), initialUiState("light"), NOW);
    expect(vm.service.controls.buttons).toEqual([]);
    expect(vm.service.controls.setup?.command).toBe("/initialize-steward");
    expect(vm.service.controls.setup?.label).toContain("not set up");
  });

  it("disables the action that cannot apply, and says why", () => {
    const up = selectDashboard(
      withControls(["start", "stop", "restart"]),
      initialUiState("light"),
      NOW,
    );
    const started = up.service.controls.buttons;
    expect(started[0]).toMatchObject({ action: "start", disabled: true });
    expect(started[0]?.disabledReason).toBe("The service is already started.");
    // The reason rides on the accessible name too: the grey fill is never the
    // only thing carrying it.
    expect(started[0]?.ariaLabel).toContain("already started");
    expect(started[1]).toMatchObject({ action: "stop", disabled: false });
    expect(started[2]).toMatchObject({ action: "restart", disabled: false });

    const down = selectDashboard(
      withControls(["start", "stop", "restart"], false),
      initialUiState("light"),
      NOW,
    );
    const stopped = down.service.controls.buttons;
    expect(stopped[0]).toMatchObject({ action: "start", disabled: false });
    expect(stopped[1]).toMatchObject({ action: "stop", disabled: true });
    expect(stopped[1]?.disabledReason).toBe("The service is already stopped.");
    // Restart stays live while stopped: it is the only command a machine that
    // consented to `restart` alone has, and it starts the service.
    expect(stopped[2]).toMatchObject({ action: "restart", disabled: false });
  });

  it("gates only the disruptive actions behind a confirm", () => {
    const vm = selectDashboard(
      withControls(["start", "stop", "restart"]),
      initialUiState("light"),
      NOW,
    );
    expect(vm.service.controls.buttons.map((b) => [b.action, b.confirms, b.danger])).toEqual([
      ["start", false, false],
      ["stop", true, true],
      ["restart", true, true],
    ]);
  });

  it("names every loaded model in the consequence, for one, several, or none", () => {
    const confirming = reduce(initialUiState("light"), {
      type: "service/confirm",
      action: "restart",
    });

    // Two loaded (the embedder is unloaded): both are named, and the comma
    // keeps the clauses apart.
    const both = selectDashboard(snapshot(), confirming, NOW).service.controls.confirm;
    expect(both?.consequence).toBe(
      "Restart unloads qwen3.6-moe-a3b-instruct and qwen3.6-moe-30b-thinking, and drops in-flight requests.",
    );

    const one = selectDashboard(
      snapshot({ models: MODELS.filter((m) => m.id === CHAT) }),
      confirming,
      NOW,
    ).service.controls.confirm;
    expect(one?.consequence).toBe(
      "Restart unloads qwen3.6-moe-a3b-instruct and drops in-flight requests.",
    );

    // Nothing loaded: no model is invented to raise the stakes.
    const none = selectDashboard(
      snapshot({ models: MODELS.map((m) => ({ ...m, status: "unloaded" as const })) }),
      confirming,
      NOW,
    ).service.controls.confirm;
    expect(none?.consequence).toBe(
      "Restart drops any in-flight requests. No model is loaded right now.",
    );
  });

  it("words the stop consequence with the stop verb, and offers cancel first", () => {
    const ui = reduce(initialUiState("light"), { type: "service/confirm", action: "stop" });
    const confirm = selectDashboard(snapshot(), ui, NOW).service.controls.confirm;
    expect(confirm?.action).toBe("stop");
    expect(confirm?.consequence.startsWith("Stop unloads ")).toBe(true);
    expect(confirm?.confirmLabel).toBe("Stop");
    expect(confirm?.cancelLabel).toBe("Cancel");
  });

  it("does not confirm an action the machine no longer offers", () => {
    const ui = reduce(initialUiState("light"), { type: "service/confirm", action: "stop" });
    const vm = selectDashboard(withControls(["start"]), ui, NOW);
    expect(vm.service.controls.confirm).toBeNull();
  });

  it("closes the strip when its own button goes inert", () => {
    const ui = reduce(initialUiState("light"), { type: "service/confirm", action: "stop" });
    const all: ServiceAction[] = ["start", "stop", "restart"];

    // Open while running: the strip stands and names what stopping costs.
    expect(selectDashboard(withControls(all), ui, NOW).service.controls.confirm?.action).toBe(
      "stop",
    );

    // The service then dies on its own and the next poll lands. Stop is now
    // disabled, so the strip must go with it — leaving it open would state a
    // consequence that has become false over an Accept that would still POST.
    const down = selectDashboard(withControls(all, false), ui, NOW).service.controls;
    expect(down.buttons.find((b) => b.action === "stop")?.disabled).toBe(true);
    expect(down.confirm).toBeNull();
  });

  it("marks the action in flight and disables the whole row", () => {
    let ui = reduce(initialUiState("light"), { type: "service/confirm", action: "restart" });
    ui = reduce(ui, { type: "service/pending", action: "restart" });
    const controls = selectDashboard(snapshot(), ui, NOW).service.controls;

    expect(controls.pending).toBe(true);
    expect(controls.buttons.map((b) => b.label)).toEqual(["Start", "Stop", "Restarting…"]);
    expect(controls.buttons.map((b) => b.busy)).toEqual([false, false, true]);
    expect(controls.buttons.every((b) => b.disabled)).toBe(true);
    // The strip closes while the command is out — there is nothing left to confirm.
    expect(controls.confirm).toBeNull();
  });

  it("reports a refused command in its own words, and never silently", () => {
    const ui = reduce(initialUiState("light"), {
      type: "service/failure",
      failure: { action: "restart", detail: "launchctl: permission denied" },
    });
    expect(selectDashboard(snapshot(), ui, NOW).service.controls.notice).toBe(
      "Restart failed — launchctl: permission denied",
    );

    const bare = reduce(initialUiState("light"), {
      type: "service/failure",
      failure: { action: "stop", detail: null },
    });
    expect(selectDashboard(snapshot(), bare, NOW).service.controls.notice).toBe("Stop failed.");

    expect(selectDashboard(snapshot(), initialUiState("light"), NOW).service.controls.notice).toBe(
      null,
    );
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
    // Every one is a real reading, so every track is solid — a 0% here would be
    // a genuine 0%, not an absent sample.
    expect(vm.gauges.every((g) => g.track === "solid")).toBe(true);
  });

  it("lays out a single Unified RAM gauge on a unified machine, with no VRAM", () => {
    // Apple-Silicon-style: one shared pool, no readable VRAM total. The single
    // gauge reads used/total off the RAM fields; a VRAM ceiling is never invented.
    const vm = selectDashboard(
      snapshot({ memoryTopology: "unified" }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.gauges.map((g) => g.key)).toEqual([
      "unified-memory",
      "gpu",
      "gpu-temp",
      "cpu",
      "cpu-temp",
    ]);
    // No VRAM gauge exists at all on a unified box.
    expect(vm.gauges.some((g) => g.key === "vram")).toBe(false);
    const unified = vm.gauges[0];
    expect(unified?.label).toBe("Unified RAM");
    expect(unified?.value).toBe("52.4 / 128 GB");
    expect(unified?.percent).toBe(41);
    expect(unified?.track).toBe("solid");
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

  it("dashes a memory gauge the host could not read, hatches its track, and empties its bar", () => {
    const s = snapshot();
    const vm = selectDashboard(
      snapshot({ metrics: { ...s.metrics, vramUsedGB: Number.NaN } }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.gauges[0]?.value).toBe("—");
    expect(vm.gauges[0]?.percent).toBe(0);
    // The empty bar is marked hatched so it cannot be read as a real 0%.
    expect(vm.gauges[0]?.track).toBe("hatched");
    // The readings either side of it are unaffected and stay solid.
    expect(vm.gauges[3]?.value).toBe("52 / 128 GB");
    expect(vm.gauges[3]?.track).toBe("solid");
  });

  it("hatches a memory gauge whose figure is null, the same as a NaN one", () => {
    const s = snapshot();
    const vm = selectDashboard(
      // A source that can't measure RAM sends null; the field is typed number,
      // so the cast mirrors what an at-runtime unmeasured reading looks like.
      snapshot({ metrics: { ...s.metrics, ramUsedGB: null as unknown as number } }),
      initialUiState("light"),
      NOW,
    );
    const ram = vm.gauges.find((g) => g.key === "ram");
    expect(ram?.value).toBe("—");
    expect(ram?.percent).toBe(0);
    expect(ram?.track).toBe("hatched");
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
  it("announces a transition only on the button — distinguishing download from load", () => {
    // The header carries no status word; the Load/Unload button is the single
    // place a transition shows. A download (minutes) and a load (seconds) read
    // differently there so the operator knows which wait they are in.
    const loading = selectDashboard(
      snapshot({ models: MODELS.map((m) => ({ ...m, status: "loading" as const })) }),
      initialUiState("light"),
      NOW,
    );
    expect(loading.models.every((m) => m.buttonLabel === "Loading…")).toBe(true);

    const downloading = selectDashboard(
      snapshot({ models: MODELS.map((m) => ({ ...m, status: "downloading" as const })) }),
      initialUiState("light"),
      NOW,
    );
    expect(downloading.models.every((m) => m.buttonLabel === "Downloading…")).toBe(true);
  });

  it("builds the labeled body grid — real values for a loaded model", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light"), NOW);
    // The seven labels are fixed and in this order on every card, Type last.
    expect(vm.models[0]?.fields.map((f) => f.label)).toEqual([
      "Quant",
      "Size",
      "Context",
      "GPU Layers",
      "Flash",
      "KV Cache",
      "Type",
    ]);
    // Loaded chat model: every field carries its confirmed value.
    expect(vm.models[0]?.fields.map((f) => f.value)).toEqual([
      "4-bit (Q4_K_M)",
      "18.4 GB",
      "64k / slot",
      "48",
      "On",
      "8-bit",
      "Generative",
    ]);
    // A confirmed field is never dimmed.
    expect(vm.models[0]?.fields.every((f) => f.na === false)).toBe(true);
  });

  it("reads every field but Type as n/a on an unloaded card, and marks them dimmed", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light"), NOW);
    // Unloaded embedder: nothing is confirmed until it loads, so every field is
    // n/a — except Type, which the router reports even while the model is down.
    // Every unloaded card reads the same this way.
    expect(vm.models[2]?.fields.map((f) => f.value)).toEqual([
      "n/a",
      "n/a",
      "n/a",
      "n/a",
      "n/a",
      "n/a",
      "Embedder",
    ]);
    expect(vm.models[2]?.fields.map((f) => f.na)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it("keeps a loaded-but-unpinned GPU-layer count honest as n/a", () => {
    // The chat model's slots are up (resident/active) but no `--n-gpu-layers`
    // was pinned, so the effective count is unreported: n/a, not a guessed 99.
    const models = MODELS.map((m) => (m.id === CHAT ? { ...m, gpuLayers: null } : m));
    const vm = selectDashboard(snapshot({ models }), initialUiState("light"), NOW);
    const gpu = vm.models[0]?.fields.find((f) => f.label === "GPU Layers");
    expect(gpu?.value).toBe("n/a");
    expect(gpu?.na).toBe(true);
    // The other loaded fields still read real values.
    expect(vm.models[0]?.fields.find((f) => f.label === "Quant")?.value).toBe("4-bit (Q4_K_M)");
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
    const reasonColor = modelColor(REASON, false);
    expect(vm.models[1]?.selected).toBe(true);
    expect(vm.models[1]?.color).toBe(reasonColor);
    expect(vm.models[1]?.cardBackground).toBe(
      `color-mix(in srgb, ${reasonColor} 10%, transparent)`,
    );
    expect(vm.models[1]?.cardBorder).toBe(`color-mix(in srgb, ${reasonColor} 50%, transparent)`);
    expect(vm.models[0]?.cardBackground).toBe("var(--surface-page)");
    expect(vm.allLogsPill.active).toBe(false);
  });

  it("gives an embedder the reserved hue and hashes everything else", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light"), NOW);
    expect(vm.models[2]?.color).toBe("var(--latte-blue)");
    expect(vm.models[0]?.color).toBe(modelColor(CHAT, false));
    expect(vm.models[0]?.color).not.toBe("var(--latte-blue)");
  });

  it("renders the loading and downloading states on the footer and button", () => {
    // A model still loading has no `meta` on the wire, so size/ctx are null.
    const inFlight = MODELS.map((m) => {
      if (m.id === CHAT) {
        return { ...m, status: "loading" as const, sizeGB: null, ctx: null, tokensPerSecond: null };
      }
      if (m.id === REASON) {
        return {
          ...m,
          status: "downloading" as const,
          sizeGB: null,
          ctx: null,
          tokensPerSecond: null,
        };
      }
      return m;
    });
    const vm = selectDashboard(snapshot({ models: inFlight }), initialUiState("light"), NOW);
    expect(vm.models[0]?.buttonLabel).toBe("Loading…");
    expect(vm.models[0]?.pending).toBe(true);
    expect(vm.models[1]?.buttonLabel).toBe("Downloading…");
    expect(vm.models[1]?.pending).toBe(true);
    // Mid-load nothing is confirmed yet, so every field but Type reads n/a — the
    // same minimal card an unloaded model shows, until the load reports facts.
    expect(vm.models[0]?.fields.map((f) => f.value)).toEqual([
      "n/a",
      "n/a",
      "n/a",
      "n/a",
      "n/a",
      "n/a",
      "Generative",
    ]);
  });
});

describe("KPI tiles", () => {
  it("scales each tile against its own ceiling", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light"), NOW);
    expect(vm.kpis[0]).toMatchObject({
      value: "3h 34m",
      unit: "uptime",
      // Port lives in the `address` fact now, so the tile shows pid alone.
      sub: "pid 4821",
      percent: 100,
    });
    // Requests tile: live in-flight/queued gauges; the bar fills 2 of 3 slots.
    expect(vm.kpis[1]).toMatchObject({
      value: "2",
      unit: "in flight",
      sub: "1 queued",
      percent: 67,
    });
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
        controls: ["start", "stop", "restart"],
      },
    });
    const vm = selectDashboard(down, initialUiState("light"), NOW);
    expect(vm.kpis[0]).toMatchObject({ value: "stopped", unit: "", sub: "no process", percent: 0 });
    // Requests reads 0 in flight, 0 queued while stopped.
    expect(vm.kpis[1]).toMatchObject({ value: "0", sub: "0 queued", percent: 0 });
    expect(vm.kpis[2]?.value).toBe("0");
  });

  it("rounds the throughput a live source reports to the whole number a tile shows", () => {
    const vm = selectDashboard(snapshot({ throughputTps: 61.837 }), initialUiState("light"), NOW);
    expect(vm.kpis[2]?.value).toBe("62");
    expect(vm.kpis[2]?.percent).toBe(52);
  });

  it("dashes throughput the source could not supply instead of printing NaN", () => {
    const vm = selectDashboard(
      snapshot({ throughputTps: Number.NaN }),
      initialUiState("light"),
      NOW,
    );
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
    expect(row?.modelColor).toBe(modelColor(CHAT, false));
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
    expect(scoped.toolbar.activeModelColor).toBe(modelColor(CHAT, false));
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

describe("grouped slots", () => {
  it("groups slots under each loaded model, numbered per model", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light"), NOW);
    expect(vm.slots.empty).toBe(false);
    // The one busy lane holds 12408 / 65536 ≈ 19% of its context, and that is
    // the worst-case fill the aggregate reports.
    expect(vm.slots.totalSummary).toBe("1 of 3 busy · peak 19% ctx");
    expect(vm.slots.groups.map((g) => g.modelId)).toEqual([CHAT, REASON]);

    const chat = vm.slots.groups[0];
    expect(chat).toMatchObject({
      modelLabel: "qwen3.6-moe-a3b-instruct",
      modelColor: modelColor(CHAT, false),
      busy: 1,
      total: 2,
      summary: "1/2 busy",
      // Actively generating → the chip carries its rate; an idle model would not.
      rateLabel: "63 t/s",
      peakPct: 19,
      peakLabel: "19%",
      peakColor: "var(--text-tertiary)",
    });
    expect(chat?.slots[0]).toMatchObject({
      id: 0,
      state: "processing",
      detail: "12408 / 64k ctx · 268 decoded",
    });
    expect(chat?.slots[1]?.detail).toBe("64k ctx · idle");

    const reason = vm.slots.groups[1];
    expect(reason).toMatchObject({ busy: 0, total: 1, summary: "0/1 busy", rateLabel: "" });
    expect(reason?.slots[0]?.detail).toBe("32k ctx · idle");
  });

  it("escalates the peak color and aggregate as a lane fills toward overflow", () => {
    const busy = snapshot({
      slots: [
        // 62259 / 65536 ≈ 95% — into the warning band.
        {
          id: 0,
          modelId: CHAT,
          promptTokens: 62259,
          ctxTotal: 65536,
          decoded: 40,
          state: "processing",
        },
        { id: 1, modelId: CHAT, promptTokens: 0, ctxTotal: 65536, decoded: 0, state: "idle" },
        { id: 0, modelId: REASON, promptTokens: 0, ctxTotal: 32768, decoded: 0, state: "idle" },
      ],
    });
    const vm = selectDashboard(busy, initialUiState("light"), NOW);
    expect(vm.slots.groups[0]?.peakPct).toBe(95);
    expect(vm.slots.groups[0]?.peakColor).toBe("var(--warning)");
    expect(vm.slots.totalSummary).toBe("1 of 3 busy · peak 95% ctx");
  });

  it("shows the empty state when no model is loaded", () => {
    const models = MODELS.map((m) => ({ ...m, status: "unloaded" as const }));
    const vm = selectDashboard(snapshot({ models, slots: [] }), initialUiState("light"), NOW);
    expect(vm.slots.empty).toBe(true);
    expect(vm.slots.emptyLabel).toBe("no models loaded");
    expect(vm.slots.groups).toEqual([]);
    expect(vm.slots.totalSummary).toBe("0 of 0 busy");
  });

  it("idles every slot while the service is down but keeps the groups", () => {
    const down = snapshot({
      service: {
        running: false,
        startedAt: null,
        pid: null,
        host: "127.0.0.1",
        port: 8080,
        build: "b6122",
        controls: ["start", "stop", "restart"],
      },
    });
    const vm = selectDashboard(down, initialUiState("light"), NOW);
    expect(vm.slots.totalSummary).toBe("0 of 3 busy");
    expect(vm.slots.groups).toHaveLength(2);
    expect(vm.slots.groups.every((g) => g.slots.every((s) => s.state === "idle"))).toBe(true);
  });

  it("drops the group of a model that was unloaded", () => {
    const models = MODELS.map((m) => (m.id === CHAT ? { ...m, status: "unloaded" as const } : m));
    const vm = selectDashboard(snapshot({ models }), initialUiState("light"), NOW);
    expect(vm.slots.groups.map((g) => g.modelId)).toEqual([REASON]);
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
