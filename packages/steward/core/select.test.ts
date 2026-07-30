import { describe, expect, it } from "vitest";
import type { ConsentDrift, LaunchDrift } from "./drift.js";
import { NO_CONSENT_DRIFT, unknownDrift } from "./drift.js";
import { classifyFamily } from "./log-parse.js";
import { modelColor } from "./model-color.js";
import type { LogRowVm } from "./select.js";
import {
  CONTEXT_LOST_QUERY,
  consoleAnnouncement,
  consoleFocusRestore,
  countNewLines,
  driftAnnouncement,
  foldAnnouncement,
  LOG_RENDER_LIMIT,
  SERVICE_STATE_PRESENTATION,
  selectDashboard,
  selectLogExportSummary,
  selectLogText,
  truncationAnnouncement,
} from "./select.js";
import type { UiState } from "./state.js";
import { initialUiState, reduce } from "./state.js";
import type { LogLine, ModelInfo, ServiceAction, ServiceInfo, Snapshot } from "./types.js";

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
    // The default machine is one Steward could not re-check (no recorded argv),
    // which must render exactly as silently as a compliant one.
    drift: unknownDrift("no launch command was recorded for this machine"),
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

/** The same service, not running — the console's `stopped` state. */
function stoppedService(): ServiceInfo {
  return {
    running: false,
    startedAt: null,
    pid: null,
    host: "127.0.0.1",
    port: 8080,
    build: "b6122",
    controls: ["start", "stop", "restart"],
  };
}

describe("service block", () => {
  it("reads as started and folds the router facts onto the VM", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light"), NOW);
    expect(vm.service.state).toBe("up");
    expect(vm.service.statusLabel).toBe("started");
    expect(vm.service.statusDotColor).toBe("var(--success)");
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
    expect(vm.service.state).toBe("down");
    expect(vm.service.statusLabel).toBe("stopped");
    expect(vm.service.statusDotColor).toBe("var(--error)");
  });

  it("gives all three states their own word, so the chip never rests on hue", () => {
    // The dot's SHAPE is the stylesheet's job (one rule per `data-state`); the
    // WORD is this module's, and it is the signal that survives a screen reader,
    // a monochrome display and a printout.
    const words = Object.values(SERVICE_STATE_PRESENTATION).map((state) => state.label);
    expect(words).toEqual(["started", "stopped", "not connected"]);
    expect(new Set(words).size).toBe(words.length);
    // A machine that was never set up is the expected first state, not a
    // failure, so it is neutral rather than red.
    expect(SERVICE_STATE_PRESENTATION.unknown.dotColor).toBe("var(--text-muted)");
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

  it("labels the temperature rows in the unit the state carries", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light", "fahrenheit"), NOW);
    expect(vm.gauges[2]?.value).toBe("147°F");
    expect(vm.gauges[5]?.value).toBe("117°F");
    // Only the temperature rows are in play; nothing else grew a unit.
    expect(vm.gauges[0]?.value).toBe("29.8 / 48 GB");
    expect(vm.gauges[1]?.value).toBe("78%");
  });

  /**
   * The constraint the whole feature turns on. Thresholds and the plotted band
   * are Celsius, so a unit change may move the label and NOTHING else — a
   * conversion that leaked into the comparison would read 79 °C as 174 against a
   * 75 threshold and report a healthy box as critical.
   */
  it("changes only the label between units — same color, same bar", () => {
    // 79 °C is a warning and 88 °C is an error: two readings whose verdicts
    // differ, so an invariance that held only for one color would show up here.
    const warm = snapshot({ metrics: { ...snapshot().metrics, gpuTempC: 88, cpuTempC: 79 } });
    const celsius = selectDashboard(warm, initialUiState("light", "celsius"), NOW).gauges;
    const fahrenheit = selectDashboard(warm, initialUiState("light", "fahrenheit"), NOW).gauges;

    expect(celsius.map((g) => g.key)).toEqual(fahrenheit.map((g) => g.key));
    for (const [index, c] of celsius.entries()) {
      const f = fahrenheit[index];
      expect(f?.percent).toBe(c.percent);
      expect(f?.color).toBe(c.color);
      expect(f?.track).toBe(c.track);
      expect(f?.label).toBe(c.label);
    }

    // …and the labels genuinely did change, so the loop above is not comparing
    // two identical view models.
    expect(celsius[2]?.value).toBe("88°C");
    expect(fahrenheit[2]?.value).toBe("190°F");
    expect(celsius[5]?.value).toBe("79°C");
    expect(fahrenheit[5]?.value).toBe("174°F");
    expect(fahrenheit[5]?.color).toBe("var(--warning)");
  });

  it("still drops an absent temperature in Fahrenheit — it never becomes 32°F", () => {
    const s = snapshot();
    const vm = selectDashboard(
      snapshot({ metrics: { ...s.metrics, gpuTempC: null, cpuTempC: Number.NaN } }),
      initialUiState("light", "fahrenheit"),
      NOW,
    );
    expect(vm.gauges.map((g) => g.key)).toEqual(["vram", "gpu", "ram", "cpu"]);
    expect(vm.gauges.some((g) => g.value.includes("°F"))).toBe(false);
  });

  it("marks exactly the temperature rows, and nothing else", () => {
    const vm = selectDashboard(snapshot(), initialUiState("light"), NOW);
    expect(vm.gauges.filter((g) => g.temperature).map((g) => g.key)).toEqual([
      "gpu-temp",
      "cpu-temp",
    ]);
  });
});

describe("the temperature-unit control", () => {
  it("is absent when this machine reports no temperature at all", () => {
    // Absent, never disabled: with no temperature row on screen the control
    // would provably change nothing, and a label that promises an effect it
    // cannot have is the same offence as a wrong count.
    const s = snapshot();
    const vm = selectDashboard(
      snapshot({ metrics: { ...s.metrics, gpuTempC: null, cpuTempC: null } }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.gauges.some((g) => g.temperature)).toBe(false);
    expect(vm.temperature).toBeNull();
  });

  it("renders as soon as ONE temperature row survives", () => {
    const s = snapshot();
    const vm = selectDashboard(
      snapshot({ metrics: { ...s.metrics, gpuTempC: Number.NaN } }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.gauges.map((g) => g.key)).toContain("cpu-temp");
    expect(vm.temperature).not.toBeNull();
  });

  it("labels the mode, not the resolved unit, and cycles auto → °C → °F → auto", () => {
    const control = (
      preference: "auto" | "celsius" | "fahrenheit",
      unit: "celsius" | "fahrenheit",
    ) => selectDashboard(snapshot(), initialUiState("light", unit, preference), NOW).temperature;

    const auto = control("auto", "celsius");
    expect(auto?.label).toBe("auto");
    expect(auto?.next).toBe("celsius");

    const celsius = control("celsius", "celsius");
    expect(celsius?.label).toBe("°C");
    expect(celsius?.next).toBe("fahrenheit");

    const fahrenheit = control("fahrenheit", "fahrenheit");
    expect(fahrenheit?.label).toBe("°F");
    expect(fahrenheit?.next).toBe("auto");
  });

  it("names the unit `auto` actually resolved to, since the label cannot", () => {
    // `auto` spends its four characters on the mode; the accessible name is
    // where the operator finds out which unit that mode picked for them.
    const metric = selectDashboard(snapshot(), initialUiState("light", "celsius"), NOW).temperature;
    expect(metric?.ariaLabel).toBe(
      "Temperature unit: automatic — °C from your browser region. Switch to always °C.",
    );
    const imperial = selectDashboard(
      snapshot(),
      initialUiState("light", "fahrenheit"),
      NOW,
    ).temperature;
    expect(imperial?.ariaLabel).toContain("°F from your browser region");
    // The hover text says the same thing the accessible name does.
    expect(imperial?.title).toBe(imperial?.ariaLabel);
  });

  it("relabels the gauges when a press is reduced, and moves nothing else", () => {
    let ui = initialUiState("light");
    const before = selectDashboard(snapshot(), ui, NOW);
    expect(before.temperature?.label).toBe("auto");
    expect(before.gauges[2]?.value).toBe("64°C");

    // Two presses: auto → °C → °F, exactly what the button dispatches.
    ui = reduce(ui, { type: "temperature/unit", preference: "celsius", unit: "celsius" });
    ui = reduce(ui, { type: "temperature/unit", preference: "fahrenheit", unit: "fahrenheit" });

    const after = selectDashboard(snapshot(), ui, NOW);
    expect(after.temperature?.label).toBe("°F");
    expect(after.temperature?.next).toBe("auto");
    expect(after.gauges[2]?.value).toBe("147°F");
    // The bar and its verdict are computed from Celsius and must not have moved.
    expect(after.gauges[2]?.percent).toBe(before.gauges[2]?.percent);
    expect(after.gauges[2]?.color).toBe(before.gauges[2]?.color);
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

  it("dashes the tiles a log-derived source cannot measure, and never prints 0 for them", () => {
    // Three different unknowns, three dashes. `requests_deferred` has no log
    // line at all; in flight cannot be counted while a lane is unknown; and a
    // rate is unmeasured until llama.cpp reports one. Printing `0` for any of
    // them would claim a quiet server that is in fact working.
    const unmeasured = snapshot({
      requestsInFlight: null,
      requestsQueued: null,
      throughputTps: null,
    });
    const vm = selectDashboard(unmeasured, initialUiState("light"), NOW);
    expect(vm.kpis[1]).toMatchObject({ value: "—", sub: "queued n/a", percent: 0 });
    expect(vm.kpis[2]).toMatchObject({ value: "—", percent: 0 });
  });

  it("still reads 0 throughput when every lane is measured and idle", () => {
    // The other half of the same rule: idle IS a measurement, and it is 0.
    const vm = selectDashboard(
      snapshot({ throughputTps: 0, requestsInFlight: 0, requestsQueued: null }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.kpis[1]?.value).toBe("0");
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
    return selectDashboard(snapshot(), ui, NOW).console.lines.map((row) => row.seq);
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
    expect(selectDashboard(snapshot(), ui, NOW).toolbar.lineCountLabel).toBe("1 of 4");
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
    const row = selectDashboard(snapshot(), ui, NOW).console.lines[0];
    expect(row?.time).toBe("09:04:07.042");
    expect(row?.model).toBe("qwen3.6-moe-a3b-instruct");
    expect(row?.modelColor).toBe(modelColor(CHAT, false));
    // Severity is `data-level` in CSS now — a filled badge against a plain
    // token — so the row model carries no colour for it at all.
    expect(row).not.toHaveProperty("levelColor");
  });

  it("mutes the model column once the console is scoped to one model", () => {
    let ui = withLines(initialUiState("light"), [logLine(1)]);
    ui = reduce(ui, { type: "filter/model-toggle", modelId: CHAT });
    expect(selectDashboard(snapshot(), ui, NOW).console.lines[0]?.modelColor).toBe(
      "var(--text-muted)",
    );
  });

  it("names the router on a line that belongs to no model", () => {
    const ui = withLines(initialUiState("light"), [logLine(1, { modelId: null })]);
    const row = selectDashboard(snapshot(), ui, NOW).console.lines[0];
    expect(row?.model).toBe("router");
    expect(row?.scope).toBe("router");
    expect(row?.modelColor).toBe("var(--text-muted)");
  });

  it("keeps the dash for a child line whose port is unmapped", () => {
    const ui = withLines(initialUiState("light"), [logLine(1, { modelId: null, origin: "child" })]);
    const row = selectDashboard(snapshot(), ui, NOW).console.lines[0];
    expect(row?.model).toBe("—");
    expect(row?.scope).toBe("unknown");
    expect(row?.modelTitle).toContain("has not mapped yet");
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
    // `any`, not `all`: two adjacent groups whose reset both read `all` and
    // both show the same number at rest look like one duplicated control.
    expect(chips.map((c) => c.label)).toEqual(["any", "INFO", "WARN", "ERROR"]);
    expect(chips[0]?.ariaLabel.startsWith("Any level")).toBe(true);
    expect(chips.filter((c) => c.active).map((c) => c.level)).toEqual(["WARN"]);
    // The hue lives in the tint and the border; the label itself stays legible,
    // because no level colour clears AA as chip text on the light theme.
    expect(chips[2]?.color).toBe("var(--text-primary)");
    expect(chips[2]?.background).toContain("var(--warning)");
    expect(chips[1]?.color).toBe("var(--text-tertiary)");
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

  it("says a lane is unknown rather than folding it into the idle remainder", () => {
    // A lane whose occupancy was never established — a child that just spawned,
    // or a stream we lost track of. Counting it as idle would turn `1/3 busy`
    // into a measurement of three lanes when only two were ever measured.
    const partial = snapshot({
      slots: [
        {
          id: 0,
          modelId: CHAT,
          promptTokens: 12408,
          ctxTotal: 65536,
          decoded: 268,
          state: "processing",
        },
        {
          id: 1,
          modelId: CHAT,
          promptTokens: null,
          ctxTotal: 65536,
          decoded: null,
          state: "unknown",
        },
        {
          id: 0,
          modelId: REASON,
          promptTokens: null,
          ctxTotal: 32768,
          decoded: null,
          state: "idle",
        },
      ],
    });
    const vm = selectDashboard(partial, initialUiState("light"), NOW);
    expect(vm.slots.groups[0]).toMatchObject({
      busy: 1,
      unknown: 1,
      summary: "1/2 busy · 1 unknown",
    });
    expect(vm.slots.groups[0]?.slots[1]?.detail).toBe("64k ctx · state unknown");
    expect(vm.slots.totalSummary).toBe("1 of 3 busy · peak 19% ctx · 1 unknown");
  });

  it("leaves out the context peak when no lane reported a fill", () => {
    // A busy lane whose held-context figure nobody has stated yet. A 0% peak
    // would read as an empty context, so the segment is simply absent.
    const unmeasured = snapshot({
      slots: [
        {
          id: 0,
          modelId: CHAT,
          promptTokens: null,
          ctxTotal: 65536,
          decoded: null,
          state: "processing",
        },
      ],
      models: MODELS,
    });
    const vm = selectDashboard(unmeasured, initialUiState("light"), NOW);
    expect(vm.slots.groups[0]).toMatchObject({ busy: 1, peakPct: null, peakLabel: "" });
    expect(vm.slots.groups[0]?.slots[0]?.detail).toBe("— / 64k ctx · — decoded");
    expect(vm.slots.totalSummary).toBe("1 of 1 busy");
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

/** A `drifted` launch verdict with the given added/removed flag groups. */
function launchDrift(over: Partial<LaunchDrift> = {}): LaunchDrift {
  return { status: "drifted", added: [], removed: [], program: null, reason: null, ...over };
}

/** A snapshot whose drift state is exactly what the test is about. */
function drifted(launch: LaunchDrift, consent: ConsentDrift = NO_CONSENT_DRIFT): Snapshot {
  return snapshot({ drift: { launch, consent } });
}

describe("drift notice", () => {
  it("says nothing at all about a machine that matches its config", () => {
    // The load-bearing silence: a compliant machine gets no badge, no "all
    // good", nothing. That is what makes the notice mean something when it does
    // appear.
    const clean = drifted({ status: "clean", added: [], removed: [], program: null, reason: null });
    expect(selectDashboard(clean, initialUiState("light"), NOW).service.drift).toBeNull();
  });

  it("says nothing about a machine it could not check", () => {
    // `unknown` renders exactly like `clean` — but it is never a claim that the
    // machine is fine, and a later phase can tell the two apart on the snapshot.
    const vm = selectDashboard(
      snapshot({ drift: unknownDrift("the service is not running") }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.service.drift).toBeNull();
  });

  it("names the flag that was removed and what to run about it", () => {
    const vm = selectDashboard(
      drifted(launchDrift({ removed: ["--metrics"] })),
      initialUiState("light"),
      NOW,
    );
    expect(vm.service.drift?.messages).toEqual([
      "Launch flags changed since setup: --metrics removed.",
    ]);
    expect(vm.service.drift?.fix).toBe("Re-run /initialize-steward to re-detect this machine.");
    expect(vm.service.drift?.title).toBe("Configuration drift");
  });

  it("reports removals and additions in one sentence", () => {
    const vm = selectDashboard(
      drifted(launchDrift({ removed: ["--metrics", "--slots"], added: ["--port 8081"] })),
      initialUiState("light"),
      NOW,
    );
    expect(vm.service.drift?.messages[0]).toBe(
      "Launch flags changed since setup: --metrics and --slots removed, --port 8081 added.",
    );
  });

  it("summarises a long list rather than printing the whole command line", () => {
    const vm = selectDashboard(
      drifted(launchDrift({ removed: ["--a", "--b", "--c", "--d", "--e"] })),
      initialUiState("light"),
      NOW,
    );
    expect(vm.service.drift?.messages[0]).toBe(
      "Launch flags changed since setup: --a, --b, --c and 2 more removed.",
    );
  });

  it("spells out a changed binary instead of drawing an arrow", () => {
    // An arrow glyph is silence to a screen reader, and this text is the whole
    // content of the announcement.
    const vm = selectDashboard(
      drifted(
        launchDrift({
          program: {
            recorded: "/opt/homebrew/bin/llama-server",
            observed: "/usr/local/bin/llama-server",
          },
        }),
      ),
      initialUiState("light"),
      NOW,
    );
    expect(vm.service.drift?.messages).toEqual([
      "The server binary changed since setup: it was /opt/homebrew/bin/llama-server, and is now /usr/local/bin/llama-server.",
    ]);
  });

  it("explains a collector that is declared but not approved", () => {
    const vm = selectDashboard(
      drifted(unknownDrift("not checked").launch, { hostCollector: true, controls: [] }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.service.drift?.messages).toEqual([
      "The host-metrics collector is declared but not approved, so no host readings are being collected.",
    ]);
  });

  it("explains unapproved control commands, singular and plural", () => {
    const one = selectDashboard(
      drifted(unknownDrift("not checked").launch, { hostCollector: false, controls: ["restart"] }),
      initialUiState("light"),
      NOW,
    );
    expect(one.service.drift?.messages).toEqual([
      "The restart command is declared but not approved, so it is not offered.",
    ]);

    const two = selectDashboard(
      drifted(unknownDrift("not checked").launch, {
        hostCollector: false,
        controls: ["stop", "restart"],
      }),
      initialUiState("light"),
      NOW,
    );
    expect(two.service.drift?.messages).toEqual([
      "The stop and restart commands are declared but not approved, so they are not offered.",
    ]);
  });

  it("gathers both producers into one notice", () => {
    const vm = selectDashboard(
      drifted(launchDrift({ removed: ["--metrics"] }), { hostCollector: true, controls: [] }),
      initialUiState("light"),
      NOW,
    );
    expect(vm.service.drift?.messages).toHaveLength(2);
    expect(vm.service.drift?.announcement).toBe(
      "Configuration drift. Launch flags changed since setup: --metrics removed. The host-metrics collector is declared but not approved, so no host readings are being collected. Re-run /initialize-steward to re-detect this machine.",
    );
  });

  it("hides a notice the operator dismissed", () => {
    const drift = drifted(launchDrift({ removed: ["--metrics"] }));
    const shown = selectDashboard(drift, initialUiState("light"), NOW).service.drift;
    expect(shown).not.toBeNull();
    const ui = reduce(initialUiState("light"), { type: "drift/dismiss", key: shown?.key ?? "" });
    expect(selectDashboard(drift, ui, NOW).service.drift).toBeNull();
  });

  it("brings the notice back when what drifted changes", () => {
    // A dismissal may buy quiet about ONE mismatch; it may never hide a new one.
    const first = drifted(launchDrift({ removed: ["--metrics"] }));
    const key = selectDashboard(first, initialUiState("light"), NOW).service.drift?.key ?? "";
    const ui = reduce(initialUiState("light"), { type: "drift/dismiss", key });

    const worse = drifted(launchDrift({ removed: ["--metrics", "--slots"] }));
    const vm = selectDashboard(worse, ui, NOW);
    expect(vm.service.drift).not.toBeNull();
    expect(vm.service.drift?.key).not.toBe(key);
  });

  it("keys the notice by what drifted, not by when it was seen", () => {
    const one = selectDashboard(
      drifted(launchDrift({ removed: ["--metrics"] })),
      initialUiState("light"),
      NOW,
    ).service.drift;
    const again = selectDashboard(
      drifted(launchDrift({ removed: ["--metrics"] })),
      initialUiState("light"),
      NOW + 60_000,
    ).service.drift;
    expect(one?.key).toBe(again?.key);
  });
});

describe("driftAnnouncement", () => {
  const notice = (key: string) => ({
    key,
    title: "Configuration drift",
    messages: ["something changed"],
    fix: "Re-run /initialize-steward to re-detect this machine.",
    dismissLabel: "Dismiss",
    dismissAriaLabel: "Dismiss",
    ariaLabel: "Configuration drift",
    announcement: `announcement for ${key}`,
  });

  it("announces a notice the operator has not heard yet", () => {
    expect(driftAnnouncement(notice("a"), null)).toEqual({
      message: "announcement for a",
      key: "a",
    });
  });

  it("stays silent while the same mismatch persists", () => {
    // The poll runs every 1.6s; repeating this would make the status region
    // useless for everything else on the page.
    expect(driftAnnouncement(notice("a"), "a")).toEqual({ message: null, key: "a" });
  });

  it("announces again when the mismatch changes", () => {
    expect(driftAnnouncement(notice("b"), "a")).toEqual({
      message: "announcement for b",
      key: "b",
    });
  });

  it("forgets the watermark when there is no notice, so a return is announced", () => {
    expect(driftAnnouncement(null, "a")).toEqual({ message: null, key: null });
    expect(driftAnnouncement(notice("a"), null).message).toBe("announcement for a");
  });
});

// ---------------------------------------------------------------------------
// The log console
// ---------------------------------------------------------------------------

function ui(over: Partial<UiState> = {}): UiState {
  return { ...initialUiState("light"), ...over };
}

/** A UI holding `lines`, plus any state the reducer has no action for. */
function consoleUi(lines: LogLine[], over: Partial<UiState> = {}): UiState {
  return { ...withLines(initialUiState("light"), lines), ...over };
}

/** Signal lines the buffer holds whole, then proxy lines that push past the cap. */
const OVER_CAP_SIGNAL = 400;
const OVER_CAP_PROXY = 180;
const OVER_CAP_TOTAL = OVER_CAP_SIGNAL + OVER_CAP_PROXY;

function overCap(): LogLine[] {
  return [
    ...Array.from({ length: OVER_CAP_SIGNAL }, (_, i) => logLine(i + 1)),
    ...Array.from({ length: OVER_CAP_PROXY }, (_, i) =>
      logLine(OVER_CAP_SIGNAL + i + 1, { kind: "proxy", message: "proxying" }),
    ),
  ];
}

describe("the proxied-request toggle", () => {
  const lines = [
    logLine(1, { message: "srv  llama_server: model loaded" }),
    logLine(2, { kind: "proxy", message: "srv  proxy_reques: proxying request to model gemma" }),
    logLine(3, { kind: "proxy", message: "srv  proxy_reques: proxying request to model gemma" }),
    logLine(4, { kind: "proxy", message: "srv  proxy_reques: proxying request to model qwen" }),
    logLine(5, { message: "srv  llama_server: listening" }),
  ];

  it("hides proxied lines by default and counts what pressing it would reveal", () => {
    const vm = selectDashboard(snapshot(), consoleUi(lines), NOW);
    expect(vm.console.lines.map((row) => row.seq)).toEqual([1, 5]);
    expect(vm.logCounts.hiddenProxy).toBe(3);
    expect(vm.toolbar.proxyToggle.label).toBe("▸ 3 proxied");
    expect(vm.toolbar.proxyToggle.pressed).toBe(false);
  });

  it("counts only lines dropped SOLELY by the toggle", () => {
    // With `gemma` typed, pressing the toggle would reveal two lines, not
    // three. A chip that still read 3 would be promising a line the query
    // already excluded.
    const scoped = consoleUi(lines, { query: "gemma" });
    const vm = selectDashboard(snapshot(), scoped, NOW);
    expect(vm.logCounts.hiddenProxy).toBe(2);
    expect(vm.toolbar.proxyToggle.label).toBe("▸ 2 proxied");
  });

  it("keeps the chip operable with nothing to reveal", () => {
    const vm = selectDashboard(snapshot(), consoleUi([logLine(1)]), NOW);
    expect(vm.toolbar.proxyToggle.label).toBe("▸ proxied");
    expect(vm.toolbar.proxyToggle.ariaLabel).toContain("None are hidden");
  });

  it("shows them all and says what the console is now mostly made of", () => {
    const vm = selectDashboard(snapshot(), consoleUi(lines, { showProxy: true }), NOW);
    expect(vm.console.lines.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(vm.logCounts.hiddenProxy).toBe(0);
    expect(vm.toolbar.proxyToggle.label).toBe("▾ proxied shown");
    expect(vm.toolbar.proxyToggle.pressed).toBe(true);
    expect(vm.toolbar.proxyToggle.ariaLabel).toContain("3 of the 5 lines shown");
  });

  it("is orthogonal to the level chip", () => {
    const warned = [...lines, logLine(6, { level: "WARN", message: "context shift" })];
    const vm = selectDashboard(
      snapshot(),
      consoleUi(warned, { filterLevel: "WARN", showProxy: true }),
      NOW,
    );
    expect(vm.console.lines.map((row) => row.seq)).toEqual([6]);
  });
});

describe("the toolbar count", () => {
  const lines = [logLine(1), logLine(2), logLine(3, { kind: "proxy", message: "proxying" })];

  function label(state: UiState): string {
    return selectDashboard(snapshot(), state, NOW).toolbar.lineCountLabel;
  }

  it("reads plainly when nothing the operator set is filtering", () => {
    expect(label(consoleUi([logLine(1), logLine(2)]))).toBe("2 lines");
  });

  it("keeps the plain form and names the suppression separately", () => {
    // Proxy suppression is not something the operator asked for, so it does not
    // turn the count into `2 of 3` — it gets its own clause instead.
    expect(label(consoleUi(lines))).toBe("2 lines · 1 proxied hidden");
  });

  it("switches to `n of m` once a filter is set", () => {
    expect(label(consoleUi(lines, { filterLevel: "INFO", showProxy: true }))).toBe("3 of 3");
  });

  it("says it is showing a window when the render cap bites", () => {
    // It takes proxy lines to get there: with them hidden the matched set can
    // never exceed the signal buffer, which is why the cap is that size.
    expect(label(consoleUi(overCap(), { showProxy: true }))).toBe(
      `showing ${LOG_RENDER_LIMIT} of ${OVER_CAP_TOTAL}`,
    );
  });
});

describe("level chips", () => {
  const lines = [
    logLine(1, { level: "INFO" }),
    logLine(2, { level: "INFO" }),
    logLine(3, { level: "WARN", message: "context shift" }),
    logLine(4, { level: "INFO", kind: "proxy", message: "proxying" }),
  ];

  function counts(state: UiState): Record<string, number> {
    const chips = selectDashboard(snapshot(), state, NOW).toolbar.levelChips;
    return Object.fromEntries(chips.map((chip) => [chip.level, chip.count]));
  }

  it("counts with the OTHER filters applied, so each number is a promise", () => {
    expect(counts(consoleUi(lines))).toEqual({ all: 3, INFO: 2, WARN: 1, ERROR: 0 });
  });

  it("keeps counting past its own level, so switching chips is predictable", () => {
    // Standing on WARN, the INFO chip still reports what INFO would show.
    expect(counts(consoleUi(lines, { filterLevel: "WARN" }))).toEqual({
      all: 3,
      INFO: 2,
      WARN: 1,
      ERROR: 0,
    });
  });

  it("follows the proxy toggle and the query", () => {
    expect(counts(consoleUi(lines, { showProxy: true }))).toEqual({
      all: 4,
      INFO: 3,
      WARN: 1,
      ERROR: 0,
    });
    expect(counts(consoleUi(lines, { query: "context" }))).toEqual({
      all: 1,
      INFO: 0,
      WARN: 1,
      ERROR: 0,
    });
  });

  it("leaves an empty chip operable and unstyled as reassurance", () => {
    const error = selectDashboard(snapshot(), consoleUi(lines), NOW).toolbar.levelChips.find(
      (chip) => chip.level === "ERROR",
    );
    expect(error?.count).toBe(0);
    expect(error?.countLabel).toBe("0");
    // Disabling it would teach the operator the control is broken, and an inert
    // ERROR chip reads as "no errors possible" — which is false.
    expect(error).not.toHaveProperty("disabled");
    expect(error?.color).toBe("var(--text-tertiary)");
  });
});

describe("the launch-argument fold", () => {
  const args = ["/opt/homebrew/bin/llama-server", "--ctx-size", "131072", "--parallel", "4"];
  const lines = [
    logLine(1, { modelId: null, message: "srv  load: spawning server instance with args:" }),
    ...args.map((arg, i) =>
      logLine(2 + i, { modelId: null, kind: "args", message: `srv  load:   ${arg}` }),
    ),
    logLine(2 + args.length, { message: "srv  llama_server: model loaded" }),
  ];

  it("collapses a contiguous run into one row and keeps the header visible", () => {
    const vm = selectDashboard(snapshot(), consoleUi(lines), NOW);
    expect(vm.console.lines).toHaveLength(3);
    expect(vm.console.lines[0]?.message).toContain("spawning server instance with args");
    const fold = vm.console.lines[1]?.fold;
    expect(fold?.count).toBe(5);
    expect(fold?.expanded).toBe(false);
    expect(fold?.label).toBe("▸ 5 launch arguments");
    expect(fold?.ariaLabel).toBe("Show the 5 launch arguments");
    expect(vm.console.lines[1]?.key).toBe("fold:2");
  });

  it("expands under the run's first seq and marks the members", () => {
    const vm = selectDashboard(snapshot(), consoleUi(lines, { expandedArgs: { 2: true } }), NOW);
    expect(vm.console.lines).toHaveLength(8);
    expect(vm.console.lines[1]?.fold?.label).toBe("▾ 5 launch arguments");
    expect(vm.console.lines[1]?.fold?.expanded).toBe(true);
    expect(vm.console.lines.filter((row) => row.folded)).toHaveLength(5);
    expect(vm.console.lines[2]?.message).toContain("llama-server");
  });

  it("gives a fold row a key of its own, so a toggle cannot patch it in place", () => {
    // The fold row and the first line of its run share a `seq`; only the key
    // tells them apart, and the patcher rebuilds rather than reshape a button.
    const collapsed = selectDashboard(snapshot(), consoleUi(lines), NOW).console.lines;
    const expanded = selectDashboard(
      snapshot(),
      consoleUi(lines, { expandedArgs: { 2: true } }),
      NOW,
    ).console.lines;
    expect(collapsed[1]?.seq).toBe(2);
    expect(expanded[2]?.seq).toBe(2);
    expect(collapsed[1]?.key).not.toBe(expanded[2]?.key);
  });

  it("opens itself for a query that hits inside, and labels the hits", () => {
    const vm = selectDashboard(snapshot(), consoleUi(lines, { query: "ctx-size" }), NOW);
    const fold = vm.console.lines[0]?.fold;
    expect(fold?.expanded).toBe(true);
    expect(fold?.forced).toBe(true);
    expect(fold?.matches).toBe(1);
    expect(fold?.label).toBe('▾ 5 launch arguments · 1 match "ctx-size"');
    // The whole block stays: 31 arguments are one artifact, and handing back 2
    // of them would answer a question nobody asked.
    expect(vm.console.lines.filter((row) => row.folded)).toHaveLength(5);
  });

  it("does not mutate the collapsed state it overrode", () => {
    const state = consoleUi(lines, { query: "ctx-size" });
    expect(selectDashboard(snapshot(), state, NOW).console.lines[0]?.fold?.expanded).toBe(true);
    const cleared = reduce(state, { type: "filter/query", query: "" });
    expect(selectDashboard(snapshot(), cleared, NOW).console.lines[1]?.fold?.expanded).toBe(false);
  });

  it("drops a run the query misses entirely", () => {
    const vm = selectDashboard(snapshot(), consoleUi(lines, { query: "spawning" }), NOW);
    expect(vm.console.lines.map((row) => row.seq)).toEqual([1]);
  });

  it("splits two runs that are not adjacent", () => {
    const split = [
      logLine(1, { modelId: null, kind: "args", message: "--a" }),
      logLine(2, { message: "srv  load: model loaded" }),
      logLine(3, { modelId: null, kind: "args", message: "--b" }),
    ];
    const vm = selectDashboard(snapshot(), consoleUi(split), NOW);
    expect(vm.console.lines.map((row) => row.fold?.seq ?? null)).toEqual([1, null, 3]);
  });

  it("says so when the run reaches the front of a window that lost lines", () => {
    const cut = lines.slice(1);
    const vm = selectDashboard(snapshot(), consoleUi(cut, { bufferDropped: true }), NOW);
    expect(vm.console.lines[0]?.fold?.truncated).toBe(true);
    expect(vm.console.lines[0]?.fold?.label).toBe("▸ 5 launch arguments (older lines dropped)");
  });

  it("claims no truncation when nothing was actually dropped", () => {
    const vm = selectDashboard(snapshot(), consoleUi(lines.slice(1)), NOW);
    expect(vm.console.lines[0]?.fold?.truncated).toBe(false);
  });
});

describe("console state precedence", () => {
  const lines = [logLine(1), logLine(2)];

  function state(over: Partial<UiState>, snap = snapshot(), now = NOW): string {
    return selectDashboard(snap, consoleUi(lines, over), now).console.state;
  }

  it("reports no source above everything else", () => {
    expect(state({ logSource: "unavailable", paused: true })).toBe("no-source");
  });

  it("reports a missing file above a reconnecting stream", () => {
    expect(state({ logSource: "missing", logStream: "reconnecting" })).toBe("file-missing");
  });

  it("reports reconnecting above a stopped service", () => {
    expect(state({ logStream: "reconnecting" }, snapshot({ service: stoppedService() }))).toBe(
      "reconnecting",
    );
  });

  it("reports stopped above paused", () => {
    expect(state({ paused: true }, snapshot({ service: stoppedService() }))).toBe("stopped");
  });

  it("reports paused above quiet, because a frozen buffer always goes stale", () => {
    const frozen = { ...consoleUi(lines), paused: true, frozen: lines };
    expect(selectDashboard(snapshot(), frozen, NOW + 10 * 60_000).console.state).toBe("paused");
  });

  it("reports an empty filter result before a cold start", () => {
    // A filter that excludes everything must never masquerade as "waiting for
    // the first line", which would send the operator looking for a dead stream.
    expect(state({ filterLevel: "ERROR" })).toBe("empty-filtered");
  });

  it("reports cold only with a genuinely empty buffer", () => {
    expect(selectDashboard(snapshot(), ui(), NOW).console.state).toBe("cold");
  });

  it("reports quiet from the newest matching line's arrival stamp", () => {
    expect(state({}, snapshot(), NOW + 61_000)).toBe("quiet");
    expect(state({}, snapshot(), NOW + 59_000)).toBe("streaming");
  });
});

describe("console notices and banners", () => {
  const lines = [logLine(1), logLine(2)];

  function vmFor(over: Partial<UiState>, snap = snapshot(), now = NOW) {
    return selectDashboard(snap, consoleUi(lines, over), now).console;
  }

  it("keeps the simulated lines but refuses to call them the server's", () => {
    const console = vmFor({ logSource: "unavailable" });
    expect(console.lines).toHaveLength(2);
    expect(console.notice?.title).toBe("No log source connected");
    expect(console.notice?.tone).toBe("warn");
    expect(console.notice?.detail).toContain("built-in simulation, not this machine's log");
  });

  it("drops the simulation clause when there is nothing on screen to explain", () => {
    const console = selectDashboard(snapshot(), ui({ logSource: "unavailable" }), NOW).console;
    expect(console.notice?.detail).not.toContain("simulation");
  });

  it("names the missing file and never calls it a rotation", () => {
    const console = vmFor({ logSource: "missing", logSourcePath: "/tmp/llama-router.log" });
    const banner = console.banners.find((entry) => entry.key === "file-missing");
    expect(banner?.placement).toBe("bottom");
    expect(banner?.tone).toBe("warn");
    expect(banner?.detail).toContain("/tmp/llama-router.log no longer exists.");
    expect(banner?.detail).toContain("three days");
    expect(banner?.detail).toContain("outside /tmp");
    expect(banner?.detail).not.toContain("rotat");
    // Nothing failed, so nothing here is an error.
    expect(banner?.detail).not.toContain("error");
  });

  it("drops the /tmp explanation for a path /tmp cleaning cannot touch", () => {
    const console = vmFor({
      logSource: "missing",
      logSourcePath: "/Users/me/.local/state/llama/router.log",
    });
    const banner = console.banners.find((entry) => entry.key === "file-missing");
    expect(banner?.detail).toContain("/Users/me/.local/state/llama/router.log no longer exists.");
    expect(banner?.detail).not.toContain("/tmp");
    expect(banner?.detail).toContain("picks the log back up");
  });

  it("takes the whole panel when the buffer is empty too", () => {
    const console = selectDashboard(
      snapshot(),
      ui({ logSource: "missing", logSourcePath: "/tmp/llama-router.log" }),
      NOW,
    ).console;
    expect(console.notice?.state).toBe("file-missing");
    expect(console.banners.some((entry) => entry.key === "file-missing")).toBe(false);
  });

  it("renders quiet as a footer under the lines, not a takeover", () => {
    const console = vmFor({}, snapshot(), NOW + 61_000);
    expect(console.notice).toBeNull();
    expect(console.lines).toHaveLength(2);
    const quiet = console.banners.find((entry) => entry.key === "quiet");
    expect(quiet?.placement).toBe("bottom");
    expect(quiet?.text).toBe("▪ quiet · 2 lines · nothing new since 09:04:07");
  });

  it("says out loud what a quiet console is still not showing", () => {
    const withProxy = [...lines, logLine(3, { kind: "proxy", message: "proxying" })];
    const console = selectDashboard(snapshot(), consoleUi(withProxy), NOW + 61_000).console;
    const quiet = console.banners.find((entry) => entry.key === "quiet");
    expect(quiet?.text).toContain("1 proxied lines hidden");
  });

  it("keeps the lines and adds a footer when the service stops", () => {
    const console = vmFor({}, snapshot({ service: stoppedService() }));
    expect(console.lines).toHaveLength(2);
    const stopped = console.banners.find((entry) => entry.key === "stopped");
    expect(stopped?.text).toBe("⏹ Service stopped · log is idle · last line 09:04:07");
  });

  it("refuses to call an empty ERROR console a health check", () => {
    const console = vmFor({ filterLevel: "ERROR" });
    expect(console.notice?.title).toBe("No ERROR lines among the 2 buffered.");
    expect(console.notice?.detail).toContain("This is not a health check");
    expect(console.notice?.detail).toContain("reports a failed model load at INFO");
    expect(console.notice?.action?.kind).toBe("clear-filters");
  });

  it("names the filters that excluded everything", () => {
    const console = vmFor({ filterLevel: "WARN", query: "context" });
    expect(console.notice?.title).toBe('No lines match WARN + "context".');
    expect(console.notice?.detail).toBe("2 lines are buffered.");
  });

  it("tells the operator what a model scope is hiding", () => {
    const mixed = [
      logLine(1, { modelId: CHAT }),
      logLine(2, { modelId: null, message: "srv  llama_server: listening" }),
      logLine(3, { modelId: null, message: "srv  llama_server: router mode" }),
    ];
    const console = selectDashboard(
      snapshot(),
      consoleUi(mixed, { filterModel: CHAT }),
      NOW,
    ).console;
    const scope = console.banners.find((entry) => entry.key === "scope");
    expect(scope?.text).toBe("scoped to qwen3.6-moe-a3b-instruct · 2 router-wide lines hidden");
    expect(scope?.action?.kind).toBe("show-all-models");
  });

  it("says which limit bit, in words that never claim a rotation", () => {
    const capped = selectDashboard(
      snapshot(),
      consoleUi(overCap(), { showProxy: true }),
      NOW,
    ).console;
    expect(capped.banners.find((entry) => entry.key === "truncation")?.text).toBe(
      `showing the latest ${LOG_RENDER_LIMIT} of ${OVER_CAP_TOTAL} matching lines`,
    );

    const dropped = selectDashboard(
      snapshot(),
      consoleUi(lines, { bufferDropped: true }),
      NOW,
    ).console;
    expect(dropped.banners.find((entry) => entry.key === "truncation")?.text).toBe(
      "500-line buffer · older lines dropped",
    );

    const both = selectDashboard(
      snapshot(),
      consoleUi(overCap(), { showProxy: true, bufferDropped: true }),
      NOW,
    ).console;
    expect(both.banners.find((entry) => entry.key === "truncation")?.text).toBe(
      `showing the latest ${LOG_RENDER_LIMIT} of ${OVER_CAP_TOTAL} matching · older lines dropped from the 500-line buffer`,
    );
    // Never "rotated" and never "reset": launchd appends across restarts, so a
    // restart is simply more lines.
    for (const banner of both.banners) expect(banner.text).not.toContain("rotat");
  });

  it("counts what is arriving behind a frozen buffer", () => {
    let state = withLines(initialUiState("light"), lines);
    state = reduce(state, { type: "logs/pause-toggle" });
    state = withLines(state, [logLine(3), logLine(4), logLine(5)]);
    const console = selectDashboard(snapshot(), state, NOW).console;
    expect(console.frozenBehind).toBe(3);
    expect(console.banners.find((entry) => entry.key === "paused")?.text).toBe(
      "⏸ Paused · buffer frozen · 3 lines arrived behind it",
    );
  });

  it("names the timestamp for a screen reader", () => {
    expect(vmFor({}).heading).toBe("Server log — times are local arrival time");
  });
});

describe("consoleAnnouncement", () => {
  function consoleFor(over: Partial<UiState>, snap = snapshot(), now = NOW) {
    return selectDashboard(snap, consoleUi([logLine(1)], over), now).console;
  }

  it("says the state once and then stays silent", () => {
    const console = consoleFor({ logSource: "unavailable" });
    const first = consoleAnnouncement(console, null, null);
    expect(first).toEqual({ message: "No log source connected.", key: "no-source" });
    expect(consoleAnnouncement(console, null, first.key).message).toBeNull();
  });

  it("re-announces a missing file only when the path changes", () => {
    const console = consoleFor({ logSource: "missing", logSourcePath: "/tmp/a.log" });
    const said = consoleAnnouncement(console, "/tmp/a.log", null);
    expect(said.message).toBe("The log file /tmp/a.log is gone. Steward is still watching for it.");
    expect(consoleAnnouncement(console, "/tmp/a.log", said.key).message).toBeNull();
    expect(consoleAnnouncement(console, "/tmp/b.log", said.key).message).toContain("/tmp/b.log");
  });

  it("announces the reconnection, but only after a loss", () => {
    const healthy = consoleFor({});
    expect(consoleAnnouncement(healthy, null, "reconnecting").message).toBe(
      "Log stream connected.",
    );
    expect(consoleAnnouncement(healthy, null, null).message).toBeNull();
  });

  it("leaves pause and filters to the handlers that caused them", () => {
    expect(consoleAnnouncement(consoleFor({ paused: true }), null, null).message).toBeNull();
    expect(
      consoleAnnouncement(consoleFor({ filterLevel: "ERROR" }), null, null).message,
    ).toBeNull();
  });
});

describe("the export payload", () => {
  it("exports every matching buffered line, past the render cap", () => {
    const vm = selectDashboard(snapshot(), consoleUi(overCap(), { showProxy: true }), NOW);
    expect(vm.console.lines).toHaveLength(LOG_RENDER_LIMIT);
    expect(vm.exportLines).toHaveLength(OVER_CAP_TOTAL);
    expect(selectLogText(vm).split("\n")).toHaveLength(OVER_CAP_TOTAL);
  });

  it("expands the folds, so the launch command is in what was copied", () => {
    const lines = [
      logLine(1, { modelId: null, message: "srv  load: spawning server instance with args:" }),
      logLine(2, { modelId: null, kind: "args", message: "--ctx-size" }),
      logLine(3, { modelId: null, kind: "args", message: "131072" }),
    ];
    const vm = selectDashboard(snapshot(), consoleUi(lines), NOW);
    expect(vm.console.lines).toHaveLength(2);
    expect(selectLogText(vm)).toContain("--ctx-size");
    expect(selectLogText(vm)).toContain("131072");
    expect(selectLogText(vm)).not.toContain("launch arguments");
    expect(vm.logCounts.folded).toBe(2);
  });

  it("honours the filters, because the operator is quoting the console", () => {
    const lines = [logLine(1, { level: "INFO" }), logLine(2, { level: "WARN", message: "shift" })];
    const vm = selectDashboard(snapshot(), consoleUi(lines, { filterLevel: "WARN" }), NOW);
    expect(vm.exportLines.map((row) => row.seq)).toEqual([2]);
  });

  it("says what it wrote out, including what it left behind", () => {
    const lines = [
      logLine(1, { modelId: null, message: "spawning server instance with args:" }),
      logLine(2, { modelId: null, kind: "args", message: "--ctx-size" }),
      logLine(3, { kind: "proxy", message: "proxying" }),
    ];
    const vm = selectDashboard(snapshot(), consoleUi(lines), NOW);
    expect(selectLogExportSummary(vm.logCounts)).toBe(
      "2 lines, including 1 folded launch argument. 1 proxied line was hidden.",
    );
  });
});

describe("a fold a search is holding open", () => {
  const lines = [
    logLine(1, { modelId: null, kind: "args", message: "--ctx-size" }),
    logLine(2, { modelId: null, kind: "args", message: "131072" }),
  ];

  it("names what the press actually does, rather than promising to hide it", () => {
    const fold = selectDashboard(snapshot(), consoleUi(lines, { query: "ctx" }), NOW).console
      .lines[0]?.fold;
    expect(fold?.expanded).toBe(true);
    expect(fold?.sticky).toBe(false);
    expect(fold?.ariaLabel).toBe(
      "2 launch arguments, open because the search matches inside them. Keep them open once the search is cleared.",
    );
  });

  it("offers to collapse it once the search clears, when it was already open", () => {
    const fold = selectDashboard(
      snapshot(),
      consoleUi(lines, { query: "ctx", expandedArgs: { 1: true } }),
      NOW,
    ).console.lines[0]?.fold;
    expect(fold?.sticky).toBe(true);
    expect(fold?.ariaLabel).toContain("Collapse them once the search is cleared.");
  });
});

// ---------------------------------------------------------------------------
// Regressions — each of these was a proven defect, reproduced before it was fixed
// ---------------------------------------------------------------------------

describe("chip counts against a fold the query opened", () => {
  // The fold adopts its whole run when the query hits inside it, so counting
  // per line before the runs are grouped made the chips promise fewer rows than
  // the console was already showing.
  const lines = [
    logLine(1, { modelId: null, message: "load: spawning server instance with args:" }),
    logLine(2, { modelId: null, kind: "args", message: "--ctx-size" }),
    logLine(3, { modelId: null, kind: "args", message: "131072" }),
    logLine(4, { modelId: null, kind: "args", message: "--parallel" }),
    logLine(5, { modelId: null, kind: "args", message: "4" }),
    logLine(6, { modelId: null, kind: "args", message: "--flash-attn" }),
  ];

  it("keeps the `all` chip equal to the matched total", () => {
    const vm = selectDashboard(snapshot(), consoleUi(lines, { query: "ctx-size" }), NOW);
    const all = vm.toolbar.levelChips.find((chip) => chip.level === "all");
    expect(vm.logCounts.matched).toBe(5);
    expect(all?.count).toBe(vm.logCounts.matched);
  });

  it("keeps every other chip a promise of what pressing it yields", () => {
    const state = consoleUi(lines, { query: "ctx-size" });
    for (const chip of selectDashboard(snapshot(), state, NOW).toolbar.levelChips) {
      const pressed = selectDashboard(snapshot(), { ...state, filterLevel: chip.level }, NOW);
      expect(chip.count).toBe(pressed.logCounts.matched);
    }
  });

  it("counts a chip through the run-adoption rule, not per line", () => {
    // One WARN argument line among four INFO ones: pressing WARN adopts the run.
    const mixed = [
      logLine(1, { modelId: null, kind: "args", message: "--ctx-size" }),
      logLine(2, { modelId: null, kind: "args", level: "WARN", message: "131072" }),
    ];
    const state = consoleUi(mixed, { query: "ctx-size" });
    const warn = selectDashboard(snapshot(), state, NOW).toolbar.levelChips.find(
      (chip) => chip.level === "WARN",
    );
    const pressed = selectDashboard(snapshot(), { ...state, filterLevel: "WARN" }, NOW);
    expect(warn?.count).toBe(pressed.logCounts.matched);
  });
});

describe("a fold's truncation claim", () => {
  const run = [
    logLine(700, { modelId: null, kind: "args", message: "--ctx-size" }),
    logLine(701, { modelId: null, kind: "args", message: "131072" }),
    logLine(702, { modelId: null, kind: "args", message: "--parallel" }),
    logLine(703, { modelId: null, kind: "args", message: "4" }),
    logLine(704, { modelId: null, kind: "args", message: "--flash-attn" }),
  ];

  it("stays silent for a complete run in a buffer that dropped OTHER lines", () => {
    // The buffer losing lines is a fact about the buffer. This run is whole,
    // and "(older lines dropped)" on a complete launch command would send the
    // operator looking for arguments that were never missing.
    const older = Array.from({ length: 3 }, (_, i) => logLine(i + 1, { message: `older ${i}` }));
    const vm = selectDashboard(
      snapshot(),
      consoleUi([...older, ...run], { bufferDropped: true }),
      NOW,
    );
    const fold = vm.console.lines.find((row) => row.fold !== null)?.fold;
    expect(fold?.count).toBe(5);
    expect(fold?.truncated).toBe(false);
    expect(fold?.label).toBe("▸ 5 launch arguments");
  });

  it("speaks when the run itself starts at the oldest line the buffer holds", () => {
    const vm = selectDashboard(snapshot(), consoleUi(run, { bufferDropped: true }), NOW);
    expect(vm.console.lines[0]?.fold?.truncated).toBe(true);
  });

  it("speaks when the render slice cut into the middle of the run", () => {
    // The run sits at the very front, and the matched set overshoots the render
    // cap by two — so the painted window opens on the run's THIRD argument and
    // the fold is genuinely holding 3 of 5.
    const head = Array.from({ length: 5 }, (_, i) =>
      logLine(i + 1, { modelId: null, kind: "args", message: `--arg-${i}` }),
    );
    const signal = Array.from({ length: 297 }, (_, i) => logLine(6 + i, { message: `event ${i}` }));
    const proxied = Array.from({ length: 200 }, (_, i) =>
      logLine(303 + i, { kind: "proxy", message: "proxying" }),
    );
    const vm = selectDashboard(
      snapshot(),
      consoleUi([...head, ...signal, ...proxied], { showProxy: true }),
      NOW,
    );
    expect(vm.logCounts.matched).toBe(LOG_RENDER_LIMIT + 2);
    expect(vm.logCounts.renderCapped).toBe(true);
    const fold = vm.console.lines[0]?.fold;
    expect(fold?.count).toBe(3);
    expect(fold?.truncated).toBe(true);
    expect(fold?.label).toBe("▸ 3 launch arguments (older lines dropped)");
  });
});

describe("a suppressed proxy line inside a spawn", () => {
  it("does not split one launch command into two folds", () => {
    const lines = [
      logLine(1, { modelId: null, message: "load: spawning server instance with args:" }),
      logLine(2, { modelId: null, kind: "args", message: "--ctx-size" }),
      logLine(3, { modelId: null, kind: "args", message: "131072" }),
      logLine(4, { kind: "proxy", message: "proxy_reques: proxying request" }),
      logLine(5, { modelId: null, kind: "args", message: "--parallel" }),
      logLine(6, { modelId: null, kind: "args", message: "4" }),
    ];
    const vm = selectDashboard(snapshot(), consoleUi(lines), NOW);
    const folds = vm.console.lines.filter((row) => row.fold !== null);
    expect(folds).toHaveLength(1);
    expect(folds[0]?.fold?.count).toBe(4);
  });
});

describe("an unavailable source that DOES have a path", () => {
  const lines = [logLine(1, { message: "srv  llama_server: model loaded" })];

  it("never calls real lines a simulation, and quotes the server's reason", () => {
    // `unavailable` covers both "never wired up" and "found it, cannot read
    // it". In the second case the buffered lines are the server's own, and
    // claiming otherwise is the inverse of the failure this console prevents.
    const console = selectDashboard(
      snapshot(),
      consoleUi(lines, {
        logSource: "unavailable",
        logSourcePath: "/var/log/llama-router.log",
        logSourceDetail: "/var/log/llama-router.log could not be read (EACCES)",
      }),
      NOW,
    ).console;
    expect(console.notice?.title).toBe("The log file cannot be read");
    expect(console.notice?.detail).toContain("(EACCES)");
    expect(console.notice?.detail).not.toContain("simulation");
    expect(console.notice?.detail).not.toContain("has not been pointed at");
    expect(console.notice?.tone).toBe("warn");
  });

  it("still says the lines are simulated when no path was ever found", () => {
    const console = selectDashboard(
      snapshot(),
      consoleUi(lines, { logSource: "unavailable" }),
      NOW,
    ).console;
    expect(console.notice?.title).toBe("No log source connected");
    expect(console.notice?.detail).toContain("built-in simulation, not this machine's log");
  });
});

describe("quiet while the filter is hiding live traffic", () => {
  it("refuses to claim silence when lines are arriving that the filter hides", () => {
    const lines = [
      logLine(1, { level: "WARN", ts: NOW - 300_000, message: "router mode banner" }),
      logLine(2, { level: "INFO", ts: NOW, message: "fresh info line" }),
    ];
    const console = selectDashboard(
      snapshot(),
      consoleUi(lines, { filterLevel: "WARN" }),
      NOW,
    ).console;
    expect(console.state).toBe("quiet");
    const quiet = console.banners.find((entry) => entry.key === "quiet");
    expect(quiet?.text).toContain("lines are still arriving that the filter hides");
  });

  it("still reports a genuinely silent router plainly", () => {
    const lines = [logLine(1, { level: "WARN", ts: NOW - 300_000, message: "banner" })];
    const console = selectDashboard(
      snapshot(),
      consoleUi(lines, { filterLevel: "WARN" }),
      NOW,
    ).console;
    const quiet = console.banners.find((entry) => entry.key === "quiet");
    expect(quiet?.text).not.toContain("still arriving");
  });
});

describe("consoleFocusRestore", () => {
  function input(over: Partial<Parameters<typeof consoleFocusRestore>[0]> = {}) {
    return {
      wasInside: true,
      moved: true,
      enteringTrace: false,
      leavingTrace: false,
      foldKey: null,
      taskKey: null,
      exitingTaskKey: null,
      keys: [] as string[],
      taskKeys: [] as string[],
      ...over,
    };
  }

  it("does nothing while focus was never disturbed", () => {
    expect(
      consoleFocusRestore(input({ moved: false, foldKey: "fold:2", keys: ["fold:2"] })),
    ).toEqual({ target: "none" });
  });

  it("lands back on the fold that was toggled, so it can be pressed twice", () => {
    expect(consoleFocusRestore(input({ foldKey: "fold:2", keys: ["1", "fold:2", "3"] }))).toEqual({
      target: "fold",
      key: "fold:2",
    });
  });

  it("falls back to the console region when the control is gone for good", () => {
    // "Clear filters" and "show all" both remove themselves; the scrollback the
    // operator was reading is the right place to land, not the top of the page.
    expect(consoleFocusRestore(input({ keys: ["1", "2"] }))).toEqual({ target: "region" });
    expect(consoleFocusRestore(input({ foldKey: "fold:9", keys: ["1", "2"] }))).toEqual({
      target: "region",
    });
  });

  it("parks on the trace banner's back button when a trace opens", () => {
    // Opening a trace replaces the whole row set, so the cell that was pressed
    // is gone. `[ back ]` is the safe landing — the same pattern the service
    // block's confirm strip uses.
    expect(consoleFocusRestore(input({ enteringTrace: true, taskKey: "53691:81259" }))).toEqual({
      target: "back",
    });
  });

  it("returns to the task cell the trace came from when it closes", () => {
    expect(
      consoleFocusRestore(
        input({
          leavingTrace: true,
          exitingTaskKey: "53691:81259",
          taskKeys: ["53691:81259", "53691:81260"],
        }),
      ),
    ).toEqual({ target: "task", key: "53691:81259" });
  });

  it("keeps focus where it is when a control outside the console closed the trace", () => {
    // Pressing a chip during a trace exits the trace and applies the filter.
    // Focus belongs to the chip that was pressed — which is exactly why no
    // control ever has to be disabled while tracing.
    expect(
      consoleFocusRestore(
        input({
          wasInside: false,
          moved: false,
          leavingTrace: true,
          exitingTaskKey: "53691:81259",
          taskKeys: ["53691:81259"],
        }),
      ),
    ).toEqual({ target: "none" });
  });

  it("falls back to the region when the traced row has scrolled out of the buffer", () => {
    expect(
      consoleFocusRestore(
        input({ leavingTrace: true, exitingTaskKey: "53691:81259", taskKeys: [] }),
      ),
    ).toEqual({ target: "region" });
  });
});

describe("countNewLines", () => {
  function row(seq: number, fold: boolean): LogRowVm {
    const rows = selectDashboard(
      snapshot(),
      consoleUi([logLine(seq, { modelId: null, kind: fold ? "args" : "event" })]),
      NOW,
    ).console.lines;
    return rows[0] as LogRowVm;
  }

  it("counts lines, not rows, so an expanded fold cannot inflate the tally", () => {
    // A fold row shares its `seq` with the first line of its run.
    const fold = row(5, true);
    const plain = row(6, false);
    expect(fold.fold).not.toBeNull();
    expect(countNewLines([fold, plain], 4)).toBe(1);
    expect(countNewLines([fold, plain], 6)).toBe(0);
  });
});

describe("the announcements that must differ per direction", () => {
  it("says opening and closing differently", () => {
    expect(foldAnnouncement(31, false, true)).toBe("31 launch arguments shown.");
    expect(foldAnnouncement(31, false, false)).toBe("31 launch arguments hidden.");
  });

  it("says what the press changed while a search is holding the fold open", () => {
    // Both presses leave the fold visible, so "shown" twice would be one
    // sentence for two opposite actions.
    const opened = foldAnnouncement(31, true, true);
    const closed = foldAnnouncement(31, true, false);
    expect(opened).not.toBe(closed);
    expect(opened).toBe("31 launch arguments will stay open when the search is cleared.");
    expect(closed).toBe("31 launch arguments will stay collapsed when the search is cleared.");
  });

  it("never announces a window it is not showing", () => {
    const counts = selectDashboard(snapshot(), consoleUi([logLine(1)]), NOW).logCounts;
    // `rendered === matched` — the render cap never bit, so the sentence must
    // not read "showing the latest 1 of 1".
    expect(truncationAnnouncement({ ...counts, bufferDropped: true })).toBe(
      "Older lines dropped from the 500-line buffer.",
    );
    expect(
      truncationAnnouncement({
        ...counts,
        bufferDropped: true,
        renderCapped: true,
        rendered: 500,
        matched: 1412,
      }),
    ).toBe("Older lines dropped from the buffer; showing the latest 500 of 1,412.");
  });
});

// ---------------------------------------------------------------------------
// Columns, chips, badges and the trace
// ---------------------------------------------------------------------------

/** The `SLT_*` frame exactly as llama.cpp's shared macro writes it. */
function frame(fn: string, slot: number, task: number) {
  return {
    slot,
    task,
    raw: `slot ${fn.slice(0, 12).padStart(12)}: id ${String(slot).padStart(2)} | task ${task} | `,
  };
}

/** One pipe-framed slot line, classified through the parser's own rules. */
function slotLine(
  seq: number,
  port: number,
  modelId: string,
  fn: string,
  slot: number,
  task: number,
  message: string,
  over: Partial<LogLine> = {},
): LogLine {
  const f = frame(fn, slot, task);
  return {
    seq,
    ts: NOW,
    level: "INFO",
    modelId,
    port,
    frame: f,
    message,
    family: classifyFamily({ frame: f, kind: "event", origin: "child", message }),
    origin: "child",
    ...over,
  };
}

/** An unframed line, classified the same way. */
function plainLine(
  seq: number,
  message: string,
  over: Partial<LogLine> & { origin?: "router" | "child" } = {},
): LogLine {
  const origin = over.origin ?? "router";
  const kind = over.kind ?? "event";
  return {
    seq,
    ts: NOW,
    level: "INFO",
    modelId: null,
    message,
    kind,
    origin,
    family: classifyFamily({ frame: null, kind, origin, message }),
    ...over,
  };
}

const PORT_A = 62354;
const PORT_B = 53691;

/**
 * A realistic mixed buffer: a boot banner, a spawn with its args run, a child's
 * own boot line, Steward's own polling, two requests whose task ids COLLIDE
 * across two ports, and one shape no rule matches.
 */
function mixedBuffer(): LogLine[] {
  return [
    plainLine(1, "srv  llama_server: starting server in router mode"),
    plainLine(2, "srv   load_models: Loaded 4 cached model presets"),
    plainLine(
      3,
      `srv          load: spawning server instance with name=${CHAT} on port ${PORT_A}`,
      {
        modelId: CHAT,
      },
    ),
    plainLine(4, "srv          load: spawning server instance with args:"),
    plainLine(5, "srv          load:   --ctx-size", { kind: "args" }),
    plainLine(6, "srv          load:   131072", { kind: "args" }),
    plainLine(7, "srv          load:   --parallel", { kind: "args" }),
    plainLine(8, "load: setting token '<|message|>' (200008) attribute to USER_DEFINED (16)", {
      origin: "child",
      modelId: CHAT,
      port: PORT_A,
      level: "WARN",
    }),
    plainLine(9, `srv  proxy_reques: proxying request to model ${CHAT} on port ${PORT_A}`, {
      kind: "proxy",
      modelId: CHAT,
    }),
    plainLine(10, `srv  proxy_reques: proxying request to model ${CHAT} on port ${PORT_A}`, {
      kind: "proxy",
      modelId: CHAT,
    }),
    // Request A: the full lifecycle on port A, task 81259.
    slotLine(
      11,
      PORT_A,
      CHAT,
      "get_available_slot",
      0,
      -1,
      "selected slot by LCP similarity, sim_best = 0.473 (> 0.100 thold), f_keep = 0.024",
      { cacheHit: 0.473 },
    ),
    slotLine(12, PORT_A, CHAT, "launch_slot_with_task", 0, 81259, "processing task, is_child = 0"),
    slotLine(13, PORT_A, CHAT, "print_timings", 0, 81259, "       eval time =   873.11 ms"),
    slotLine(
      14,
      PORT_A,
      CHAT,
      "release",
      0,
      81259,
      "stop processing: n_tokens = 193, truncated = 0",
    ),
    // Request B: the SAME task id on a different port and a different model.
    slotLine(
      15,
      PORT_B,
      REASON,
      "launch_slot_with_task",
      0,
      81259,
      "processing task, is_child = 0",
    ),
    slotLine(
      16,
      PORT_B,
      REASON,
      "release",
      0,
      81259,
      "stop processing: n_tokens = 4096, truncated = 1",
      { contextLost: true },
    ),
    plainLine(17, "srv   frobnicate: widget 3 | zone 7 | reticulating splines"),
  ];
}

describe("the task column", () => {
  function rows(over: Partial<UiState> = {}) {
    return selectDashboard(snapshot(), consoleUi(mixedBuffer(), over), NOW).console;
  }

  it("puts a trace button on every framed line that has a task and a port", () => {
    const cell = rows().lines.find((row) => row.seq === 12)?.task;
    expect(cell).toEqual({
      port: PORT_A,
      task: 81259,
      key: `${PORT_A}:81259`,
      label: "▸81259",
      ariaLabel:
        "Trace task 81259 on port 62354. This is llama-server's own handle for the request, not a request number.",
      active: false,
    });
  });

  it("leaves the cell empty on `get_availabl`, which has no task yet", () => {
    // `task -1` in 217/217 measured cases: no task is attached when the slot is
    // chosen. Inventing one would be the first mis-attribution in a console
    // built to avoid exactly that — it joins the trace by adjacency instead.
    expect(rows().lines.find((row) => row.seq === 11)?.task).toBeNull();
  });

  it("leaves the cell empty on every unframed line", () => {
    const shown = rows({ showProxy: true });
    for (const seq of [1, 3, 9, 17]) {
      expect(shown.lines.find((row) => row.seq === seq)?.task, String(seq)).toBeNull();
    }
  });

  it("leaves the cell empty when the port — half the trace key — is unknown", () => {
    const line = slotLine(20, PORT_A, CHAT, "release", 0, 5, "stop processing");
    const orphan: LogLine = { ...line };
    delete orphan.port;
    const vm = selectDashboard(snapshot(), consoleUi([orphan]), NOW).console;
    expect(vm.lines[0]?.task).toBeNull();
  });

  it("collapses the whole column when nothing in the matched set is framed", () => {
    // An idle router showing eleven banner lines gets the four-column grid
    // back, not 64px of dead space.
    expect(rows().showTaskColumn).toBe(true);
    expect(rows({ filterFamily: "startup" }).showTaskColumn).toBe(false);
    const counts = selectDashboard(
      snapshot(),
      consoleUi(mixedBuffer(), { filterFamily: "startup" }),
      NOW,
    ).logCounts;
    expect(counts.framed).toBe(0);
  });
});

describe("row badges", () => {
  function badges(seq: number, over: Partial<UiState> = {}) {
    const vm = selectDashboard(snapshot(), consoleUi(mixedBuffer(), over), NOW).console;
    return vm.lines.find((row) => row.seq === seq)?.badges ?? [];
  }

  it("flags a reply written from a mutilated context, and only when it says so", () => {
    expect(badges(16).map((b) => b.key)).toContain("context-lost");
    const lost = badges(16).find((b) => b.key === "context-lost");
    expect(lost?.label).toBe("▲ context lost");
    // Severity in FORM: the glyph and a tinted ground carry it, never a hue as
    // text — the amber token is ~2.2:1 on the light theme's console ground.
    expect(lost?.tone).toBe("warn");

    // `truncated = 0` gets NOTHING. A badge on 217 of 217 rows trains the eye
    // to skip the pixel where the real thing will appear.
    expect(badges(14).map((b) => b.key)).not.toContain("context-lost");
  });

  it("translates `sim_best` into a number an operator can read", () => {
    expect(badges(11).find((b) => b.key === "cache")?.label).toBe("cache 47%");
  });

  it("shows the slot id only where a model actually has more than one slot", () => {
    // `parallel` comes off the snapshot, so the reveal rule is authoritative
    // rather than inferred from the ids seen so far. A permanently-zero column
    // teaches an operator that the column is meaningless.
    expect(badges(12).map((b) => b.key)).toContain("slot");
    const single = selectDashboard(
      snapshot({
        models: MODELS.map((model) => (model.id === CHAT ? { ...model, parallel: 1 } : model)),
      }),
      consoleUi(mixedBuffer()),
      NOW,
    ).console;
    expect(single.lines.find((row) => row.seq === 12)?.badges.map((b) => b.key)).not.toContain(
      "slot",
    );
  });

  it("renders nothing at all when an enrichment is absent", () => {
    // Not an empty box, not a dash. A future llama.cpp that renames a payload
    // costs one missing badge and never a row.
    expect(badges(1)).toEqual([]);
    expect(badges(17)).toEqual([]);
  });
});

describe("record-type chips", () => {
  const FAMILIES = ["any", "requests", "models", "startup", "other"] as const;

  it("counts what pressing each chip actually yields", () => {
    // Asserted by RE-RUNNING the selector, not by arithmetic: the promise is
    // "this number is what you get if you press it", and only running the whole
    // pipeline with the chip pressed can check that.
    const lines = mixedBuffer();
    for (const showProxy of [false, true]) {
      for (const level of ["all", "INFO", "WARN"] as const) {
        for (const query of ["", "processing"]) {
          const base = consoleUi(lines, { showProxy, filterLevel: level, query });
          const counts = selectDashboard(snapshot(), base, NOW).logCounts;
          for (const family of FAMILIES) {
            const pressed = selectDashboard(
              snapshot(),
              { ...base, filterFamily: family },
              NOW,
            ).logCounts;
            expect(
              counts.families[family],
              `${family} · proxy=${showProxy} · ${level} · "${query}"`,
            ).toBe(pressed.matched);
          }
        }
      }
    }
  });

  it("counts what pressing each LEVEL chip yields, with a record-type chip applied", () => {
    const lines = mixedBuffer();
    for (const family of FAMILIES) {
      const base = consoleUi(lines, { filterFamily: family });
      const counts = selectDashboard(snapshot(), base, NOW).logCounts;
      for (const level of ["all", "INFO", "WARN", "ERROR"] as const) {
        const pressed = selectDashboard(snapshot(), { ...base, filterLevel: level }, NOW).logCounts;
        expect(counts.levels[level], `${family} · ${level}`).toBe(pressed.matched);
      }
    }
  });

  it("drives the proxy toggle's count to zero under `models`", () => {
    // Proxy lines ARE requests, so pressing `models` means the toggle would
    // reveal none — and the count clause drops out of the label rather than
    // promising rows that are not there. That falls out of the structure.
    const counts = selectDashboard(
      snapshot(),
      consoleUi(mixedBuffer(), { filterFamily: "models" }),
      NOW,
    ).logCounts;
    expect(counts.hiddenProxy).toBe(0);

    const requests = selectDashboard(
      snapshot(),
      consoleUi(mixedBuffer(), { filterFamily: "requests" }),
      NOW,
    ).logCounts;
    expect(requests.hiddenProxy).toBe(2);
  });

  it("offers four families and a reset that reads `any`", () => {
    const chips = selectDashboard(snapshot(), consoleUi(mixedBuffer()), NOW).toolbar.familyChips;
    expect(chips.map((c) => c.family)).toEqual([...FAMILIES]);
    expect(chips.map((c) => c.label)).toEqual(["any", "requests", "models", "startup", "other"]);
  });

  it("says out loud that `other` is the drift alarm", () => {
    const chips = selectDashboard(snapshot(), consoleUi(mixedBuffer()), NOW).toolbar.familyChips;
    const other = chips.find((c) => c.family === "other");
    expect(other?.count).toBe(1);
    expect(other?.ariaLabel).toContain("could not classify");
    expect(other?.ariaLabel).toContain("stays visible");
  });
});

describe("byte-exact export", () => {
  it("writes the frame back in front of the message on every framed row", () => {
    const vm = selectDashboard(snapshot(), consoleUi(mixedBuffer(), { showProxy: true }), NOW);
    const text = selectLogText(vm);
    // The file's own line, reconstructed: this is what makes relocating the
    // frame a relocation rather than a rewrite.
    expect(text).toContain(
      "slot      release: id  0 | task 81259 | stop processing: n_tokens = 193",
    );
    expect(text).toContain(
      "slot print_timing: id  0 | task 81259 |        eval time =   873.11 ms",
    );

    for (const line of mixedBuffer()) {
      const row = vm.exportLines.find((entry) => entry.seq === line.seq);
      if (row === undefined) continue;
      expect(`${row.frameRaw}${row.message}`, String(line.seq)).toBe(
        `${line.frame?.raw ?? ""}${line.message}`,
      );
    }
  });
});

describe("the `truncated = 1` banner", () => {
  it("appears only when something actually lost context, and searches for it", () => {
    const vm = selectDashboard(snapshot(), consoleUi(mixedBuffer()), NOW);
    expect(vm.logCounts.contextLost).toBe(1);
    const strip = vm.console.banners.find((banner) => banner.key === "context-lost");
    // "of the N BUFFERED" — never "N requests today". The buffer is a window and
    // the copy says so rather than implying a total.
    //
    // Regression on the noun: it counts LINES, because lines are what is
    // counted. `buffered` is a line count and a 500-line window is roughly 20
    // requests, so "500 buffered requests" was false by a factor of 25 — and at
    // N=1 the singular agreed with the numerator while sitting against the
    // denominator ("1 of the 500 buffered request").
    expect(strip?.text).toBe("▲ 1 of the 17 buffered lines said the reply lost context");
    expect(strip?.action?.kind).toBe("query-truncated");
    expect(strip?.tone).toBe("warn");
  });

  it("agrees with its own denominator at every count", () => {
    const one = mixedBuffer().slice(15, 16);
    expect(
      selectDashboard(snapshot(), consoleUi(one), NOW).console.banners.find(
        (banner) => banner.key === "context-lost",
      )?.text,
    ).toBe("▲ 1 of the 1 buffered line said the reply lost context");
  });

  it("says nothing at all when nothing has", () => {
    // There is no "0 requests lost context" state: that would be a health
    // affirmation about a signal the console can see only a window of.
    const clean = mixedBuffer().filter((line) => line.contextLost !== true);
    const vm = selectDashboard(snapshot(), consoleUi(clean), NOW);
    expect(vm.logCounts.contextLost).toBe(0);
    expect(vm.console.banners.find((banner) => banner.key === "context-lost")).toBeUndefined();
  });

  it("finds the rows when its action's literal is used as the query", () => {
    const vm = selectDashboard(
      snapshot(),
      consoleUi(mixedBuffer(), { query: CONTEXT_LOST_QUERY }),
      NOW,
    );
    expect(vm.logCounts.matched).toBe(1);
    expect(vm.console.lines[0]?.seq).toBe(16);
  });
});

describe("request tracing", () => {
  function traced(over: Partial<UiState> = {}) {
    return selectDashboard(
      snapshot(),
      consoleUi(mixedBuffer(), {
        trace: { port: PORT_A, task: 81259, anchorSeq: 12 },
        ...over,
      }),
      NOW,
    );
  }

  it("is keyed on (port, task), never on the id alone", () => {
    // Task ids are a per-process counter from 0, so the same id genuinely
    // appears under two ports here. Keyed on the id alone this trace would mix
    // two models' lines together and call it one request.
    const vm = traced();
    expect(vm.console.lines.map((row) => row.seq)).toEqual([11, 12, 13, 14]);
    expect(vm.console.trace?.modelLabel).toBe("qwen3.6-moe-a3b-instruct");

    const other = selectDashboard(
      snapshot(),
      consoleUi(mixedBuffer(), { trace: { port: PORT_B, task: 81259, anchorSeq: 15 } }),
      NOW,
    );
    expect(other.console.lines.map((row) => row.seq)).toEqual([15, 16]);
    expect(other.console.trace?.modelLabel).toBe("qwen3.6-moe-30b-thinking");
  });

  it("picks up the slot-selection line by adjacency and says so", () => {
    const vm = traced();
    // Line 11 is `task -1` and joins by position, not by id.
    expect(vm.console.lines[0]?.seq).toBe(11);
    expect(vm.console.trace?.detail).toContain("attached by position");
    expect(vm.console.trace?.detail).toContain("in file order");
    expect(vm.console.trace?.detail).toContain("Filters do not apply inside a trace");
  });

  it("omits the adjacent line rather than mis-attaching one", () => {
    // The rule degrades by dropping a line, which is the safe direction.
    const withoutSelection = mixedBuffer().filter((line) => line.seq !== 11);
    const vm = selectDashboard(
      snapshot(),
      consoleUi(withoutSelection, { trace: { port: PORT_A, task: 81259, anchorSeq: 12 } }),
      NOW,
    );
    expect(vm.console.lines.map((row) => row.seq)).toEqual([12, 13, 14]);
    expect(vm.console.trace?.detail).not.toContain("attached by position");
  });

  it("ignores every filter, and says so in its banner", () => {
    // A trace can span lines the filter stack hides; the answer is that the
    // filters do not apply, not that the trace is cut short.
    for (const over of [
      { filterLevel: "ERROR" as const },
      { filterFamily: "startup" as const },
      { filterModel: REASON },
      { query: "nothing matches this" },
      { showProxy: true },
    ]) {
      const vm = traced(over);
      expect(
        vm.console.lines.map((row) => row.seq),
        JSON.stringify(over),
      ).toEqual([11, 12, 13, 14]);
      expect(vm.console.state).toBe("tracing");
    }
  });

  it("keeps the chips live and honest while it is open", () => {
    // Nothing is disabled during a trace, so every count still has to be true:
    // pressing a chip exits the trace and applies the filter, and the number it
    // promised is the number that arrives.
    const vm = traced();
    const chips = vm.toolbar.familyChips;
    const plain = selectDashboard(snapshot(), consoleUi(mixedBuffer()), NOW);
    expect(chips.map((c) => c.count)).toEqual(plain.toolbar.familyChips.map((c) => c.count));
    expect(vm.toolbar.lineCountLabel).toBe("tracing task 81259 · 4 lines");
  });

  it("marks the traced rows and flips the task cell's glyph", () => {
    const vm = traced();
    expect(vm.console.lines.every((row) => row.traced)).toBe(true);
    const cell = vm.console.lines.find((row) => row.seq === 12)?.task;
    expect(cell?.active).toBe(true);
    expect(cell?.label).toBe("▾81259");
  });

  it("names the port and no model when the port was never mapped", () => {
    // The model comes from the port map, never from the neighbouring proxy
    // line — the only line that names a model carries no task id.
    const anonymous = mixedBuffer().map((line) =>
      line.port === PORT_A ? { ...line, modelId: null } : line,
    );
    const vm = selectDashboard(
      snapshot(),
      consoleUi(anonymous, { trace: { port: PORT_A, task: 81259, anchorSeq: 12 } }),
      NOW,
    );
    expect(vm.console.trace?.modelLabel).toBe("");
    expect(vm.console.trace?.title).toContain("port 62354");
    expect(vm.console.trace?.title).not.toContain(" · qwen");
  });

  it("surfaces a partial trace rather than showing half a request quietly", () => {
    const tail = mixedBuffer().slice(11);
    let ui = consoleUi(tail);
    ui = { ...ui, bufferDropped: true, trace: { port: PORT_A, task: 81259, anchorSeq: 12 } };
    const vm = selectDashboard(snapshot(), ui, NOW);
    expect(vm.console.trace?.partial).toBe(true);
    expect(vm.console.trace?.title).toContain("earliest lines dropped from the buffer");
  });

  it("claims nothing was dropped unless something was", () => {
    // Regression: `partial` was `earliest === 0` alone, so a trace that simply
    // began at the front of a buffer nothing had ever fallen out of announced
    // "earliest lines dropped from the buffer" — a warning about a loss that
    // never happened, on the surface whose whole job is to be trusted.
    const tail = mixedBuffer().slice(11);
    const vm = selectDashboard(
      snapshot(),
      consoleUi(tail, { trace: { port: PORT_A, task: 81259, anchorSeq: 12 } }),
      NOW,
    );
    expect(vm.logCounts.bufferDropped).toBe(false);
    expect(vm.console.trace?.partial).toBe(false);
    expect(vm.console.trace?.title).not.toContain("dropped from the buffer");
  });

  /**
   * Two requests that share `(port, task)` because a child died and respawned
   * on the same ephemeral port, its task counter starting over. They sit close
   * together — a restart takes seconds, not hundreds of lines.
   */
  function reusedPort(): LogLine[] {
    return [
      ...mixedBuffer(),
      ...Array.from({ length: 18 }, (_unused, i) =>
        plainLine(100 + i, `srv  proxy_reques: proxying request to model ${CHAT}`, {
          kind: "proxy",
          modelId: CHAT,
        }),
      ),
      // The SAME port, now serving a different model: the child was replaced.
      slotLine(200, PORT_A, REASON, "launch_slot_with_task", 0, 81259, "processing task"),
      slotLine(201, PORT_A, REASON, "release", 0, 81259, "stop processing: n_tokens = 12"),
    ];
  }

  it("never merges two requests that share an id, however close they sit", () => {
    // Regression: with a 200-line split threshold these two requests were 20
    // lines apart, so they came back as ONE six-member trace with
    // `splitRuns: false` — one operator's request silently presented as
    // another's, with no warning anywhere. The measured maximum gap inside a
    // real request is 7 lines.
    const vm = selectDashboard(
      snapshot(),
      consoleUi(reusedPort(), { trace: { port: PORT_A, task: 81259, anchorSeq: 12 } }),
      NOW,
    );
    expect(vm.console.lines.map((row) => row.seq)).toEqual([11, 12, 13, 14]);
    expect(vm.console.trace?.splitRuns).toBe(true);
    expect(vm.console.trace?.title).toContain("showing only the one you opened");
  });

  it("shows the run the operator actually opened, not the first one", () => {
    // `anchorSeq` is what disambiguates, and it has to work in both directions.
    const vm = selectDashboard(
      snapshot(),
      consoleUi(reusedPort(), { trace: { port: PORT_A, task: 81259, anchorSeq: 200 } }),
      NOW,
    );
    expect(vm.console.lines.map((row) => row.seq)).toEqual([200, 201]);
    expect(vm.console.trace?.splitRuns).toBe(true);
  });

  it("names the model from the traced lines, not from whatever used the port", () => {
    // Regression: the label was the first `modelId` seen on that port ANYWHERE
    // in the buffer, so a trace of the new child's request was captioned with
    // the model that used to hold the port before it.
    const vm = selectDashboard(
      snapshot(),
      consoleUi(reusedPort(), { trace: { port: PORT_A, task: 81259, anchorSeq: 200 } }),
      NOW,
    );
    expect(vm.console.lines.every((row) => row.model === "qwen3.6-moe-30b-thinking")).toBe(true);
    expect(vm.console.trace?.modelLabel).toBe("qwen3.6-moe-30b-thinking");
  });

  it("outranks an empty filter but never a sick source", () => {
    // A filter that matches nothing says nothing about what a trace is showing;
    // a log file that is gone says everything about it.
    expect(traced({ filterQueryUnused: undefined } as Partial<UiState>).console.state).toBe(
      "tracing",
    );
    expect(traced({ logSource: "missing" }).console.state).toBe("file-missing");
    expect(traced({ paused: true }).console.state).toBe("paused");
  });

  it("drops the filter-view strips, which do not apply inside it", () => {
    const vm = traced({ filterModel: CHAT, bufferDropped: true });
    expect(vm.console.banners.map((banner) => banner.key)).toEqual(["trace"]);
    expect(vm.console.banners[0]?.action?.kind).toBe("exit-trace");
    expect(vm.console.banners[0]?.tone).toBe("trace");
  });
});
