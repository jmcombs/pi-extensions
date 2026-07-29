/**
 * A simulated {@link StewardDataSource}.
 *
 * It stands in for a real `llama-server` so the dashboard can be developed,
 * demoed, and tested without one: four models, a log stream shaped like
 * llama.cpp's own output, drifting host sensors, and slots that pick work up
 * and put it down. Nothing here talks to the network, and nothing appends to
 * the log while the service is stopped.
 *
 * `random` and `now` are injectable so tests get a fixed simulation, and each
 * ticker can be driven by hand (`tickLogs`, `tickMetrics`, `tickThroughput`)
 * instead of by timers. Keep this module free of Node and DOM APIs — see
 * `./types.ts`.
 */

import type { StewardDataSource, Unsubscribe } from "./source.js";
import type {
  ConfigEntry,
  HostMetrics,
  LogLevel,
  LogLine,
  ModelAction,
  ModelInfo,
  ServiceAction,
  SlotInfo,
  SlotState,
  Snapshot,
} from "./types.js";
import { THROUGHPUT_HISTORY_SIZE, THROUGHPUT_SAMPLE_SECONDS } from "./types.js";

export interface MockSourceOptions {
  /** Source of randomness. Inject a seeded generator to pin the simulation. */
  random?: () => number;
  /** Clock, in epoch ms. Inject a fake to pin timestamps and uptime. */
  now?: () => number;
  /** Milliseconds between log batches. `0` leaves the ticker unscheduled. */
  logIntervalMs?: number;
  /** Milliseconds between metric ticks. `0` leaves the ticker unscheduled. */
  metricsIntervalMs?: number;
  /**
   * Milliseconds between throughput samples. `0` leaves the ticker
   * unscheduled. Defaults to the cadence {@link THROUGHPUT_SAMPLE_SECONDS}
   * declares, which is what makes the chart's time axis true.
   */
  throughputIntervalMs?: number;
  /** Ring-buffer cap for the log. */
  maxLogLines?: number;
  /** Lines generated up front so a client that connects first sees scrollback. */
  seedLines?: number;
}

/**
 * The mock source, plus the two ticks the timers drive. Tests call those
 * directly and leave the intervals unscheduled.
 */
export interface MockStewardDataSource extends StewardDataSource {
  /** Emits one batch of log lines: usually one line, sometimes two. */
  tickLogs(): void;
  /** Advances sensors, the rate tiles, and slot churn by one step. */
  tickMetrics(): void;
  /** Pushes one sample onto the throughput history, retiring the oldest. */
  tickThroughput(): void;
}

const DEFAULT_LOG_INTERVAL_MS = 900;
const DEFAULT_METRICS_INTERVAL_MS = 1600;
/**
 * The chart plots {@link THROUGHPUT_HISTORY_SIZE} samples under a fixed
 * two-minute axis, so the samples have to arrive at the declared cadence or the
 * axis is a lie. It is deliberately not the metrics cadence.
 */
const DEFAULT_THROUGHPUT_INTERVAL_MS = THROUGHPUT_SAMPLE_SECONDS * 1000;
const DEFAULT_MAX_LOG_LINES = 500;
const DEFAULT_SEED_LINES = 60;

/** Where the sequence numbers pick up, as if the server had been up a while. */
const INITIAL_SEQ = 617;
/** 3h 34m — the uptime the design was drawn against. */
const INITIAL_UPTIME_MS = 214 * 60 * 1000;

const VRAM_TOTAL_GB = 48;
const RAM_TOTAL_GB = 128;
const PID = 4821;
const BUILD = "b6122";
const HOST = "127.0.0.1";
const PORT = 8080;

/** The static half of a model — everything not derived from live state. */
type ModelSpec = Omit<ModelInfo, "status" | "tokensPerSecond">;

const MODELS = [
  {
    id: "qwen3.6-moe-a3b-instruct-q4_k_m",
    short: "qwen3.6-moe-a3b-instruct",
    embedding: false,
    quant: "Q4_K_M",
    sizeGB: 18.4,
    ctx: 65536,
    nativeCtx: 262144,
    gpuLayers: 48,
    detail: null,
    parallel: 2,
    flashAttn: "on",
    kvCache: "q8_0/q8_0",
  },
  {
    id: "qwen3.6-moe-30b-thinking-q5_k_m",
    short: "qwen3.6-moe-30b-thinking",
    embedding: false,
    quant: "Q5_K_M",
    sizeGB: 22.1,
    ctx: 32768,
    nativeCtx: 262144,
    gpuLayers: 48,
    detail: null,
    parallel: 1,
    flashAttn: "on",
    kvCache: "q8_0/q8_0",
  },
  {
    id: "qwen3.6-moe-coder-fim-q4_k_m",
    short: "qwen3.6-moe-coder-fim",
    embedding: false,
    quant: "Q4_K_M",
    sizeGB: 9.8,
    ctx: 16384,
    nativeCtx: 32768,
    gpuLayers: 32,
    detail: null,
    parallel: 1,
    flashAttn: "on",
    kvCache: "f16/f16",
  },
  {
    // Seeded unloaded, and tuned like a real preset — quant, per-slot ctx and
    // parallel come off the launch args even with no `meta`, so its card
    // exercises the enriched unloaded layout (facts without a size).
    id: "nomic-embed-text-v1.5-f16",
    short: "nomic-embed-text-v1.5",
    embedding: true,
    quant: "F16",
    sizeGB: 0.5,
    ctx: 2048,
    nativeCtx: 2048,
    gpuLayers: null,
    detail: "embedding",
    parallel: 1,
    flashAttn: "off",
    kvCache: "f16/f16",
  },
] as const satisfies readonly ModelSpec[];

// Per-model tuning (parallel, flash-attention, KV-cache) lives on each model
// card, not here: in routed mode the router runs one `llama-server` per model,
// so those values differ between models and there is no single global figure.
// What remains is genuinely router-wide, and it mirrors the shape the live
// `/props` parser emits (see core/llama-config.ts) so the mock reads like the
// real thing.
const CONFIG: readonly ConfigEntry[] = [
  { key: "mode", value: "routed" },
  { key: "engine", value: "llama-server b6122" },
  { key: "address", value: "127.0.0.1:8080" },
  { key: "max models", value: "4" },
  { key: "autoload", value: "off" },
];

/** A slot as the simulation keeps it; {@link SlotInfo} is the projection. */
interface SlotSim {
  id: number;
  promptTokens: number;
  ctxTotal: number;
  decoded: number;
  state: SlotState;
}

export function createMockSource(options: MockSourceOptions = {}): MockStewardDataSource {
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const maxLogLines = options.maxLogLines ?? DEFAULT_MAX_LOG_LINES;
  const logIntervalMs = options.logIntervalMs ?? DEFAULT_LOG_INTERVAL_MS;
  const metricsIntervalMs = options.metricsIntervalMs ?? DEFAULT_METRICS_INTERVAL_MS;
  const throughputIntervalMs = options.throughputIntervalMs ?? DEFAULT_THROUGHPUT_INTERVAL_MS;
  const seedLines = options.seedLines ?? DEFAULT_SEED_LINES;

  let running = true;
  let startedAt = now() - INITIAL_UPTIME_MS;
  let seq = INITIAL_SEQ;

  const unloaded = new Set<string>(["nomic-embed-text-v1.5-f16"]);

  let throughputTps = 0;
  let requestsQueued = 0;
  // Sensors are held as fractions of their totals, the way the simulation
  // drifts them; the snapshot converts to the absolute figures the UI shows.
  let vramFraction = 0.62;
  let ramFraction = 0.41;
  let cpuUtil = 0.17;
  let gpuUtil = 0.78;
  let gpuTempC = 64;
  let cpuTempC = 47;

  const throughputHistory = Array.from(
    { length: THROUGHPUT_HISTORY_SIZE },
    () => 40 + random() * 45,
  );

  // Slots are grouped under their model — in routed mode each model runs its own
  // `llama-server` with its own slot pool, so there is no flat, server-wide
  // strip. Each loaded model gets `parallel` slots, created on demand.
  const slotGroups = new Map<string, SlotSim[]>();

  function ensureGroup(model: ModelSpec): SlotSim[] {
    let group = slotGroups.get(model.id);
    if (group === undefined) {
      const count = model.parallel ?? 1;
      group = Array.from({ length: count }, (_index, id) => ({
        id,
        promptTokens: 0,
        ctxTotal: model.ctx ?? 0,
        decoded: 0,
        state: "idle" as SlotState,
      }));
      slotGroups.set(model.id, group);
    }
    return group;
  }

  /** Puts a specific slot into a working state, for the opening paint. */
  function seedSlot(model: ModelSpec, slotId: number, promptTokens: number, decoded: number): void {
    const slot = ensureGroup(model).find((candidate) => candidate.id === slotId);
    if (slot === undefined) return;
    slot.state = "processing";
    slot.promptTokens = promptTokens;
    slot.decoded = decoded;
  }

  for (const model of MODELS) {
    if (!unloaded.has(model.id)) ensureGroup(model);
  }
  seedSlot(MODELS[0], 0, 12408, 268);
  seedSlot(MODELS[2], 0, 3120, 41);

  /** Per-model generation rate, refreshed on each metrics tick. */
  const modelRates = new Map<string, number>();

  const log: LogLine[] = [];
  const listeners = new Set<(line: LogLine) => void>();

  let logTimer: ReturnType<typeof setInterval> | null = null;
  let metricsTimer: ReturnType<typeof setInterval> | null = null;
  let throughputTimer: ReturnType<typeof setInterval> | null = null;

  function isBusy(modelId: string): boolean {
    return slotGroups.get(modelId)?.some((slot) => slot.state === "processing") ?? false;
  }

  /**
   * One log line, or `null` when there is nothing to write about. Every line
   * the simulation produces is slot traffic attributed to the model that
   * produced it, so with nothing resident the log simply goes quiet.
   */
  function makeLine(): LogLine | null {
    const loaded = MODELS.filter((model) => !unloaded.has(model.id));
    const model = loaded[Math.floor(random() * loaded.length)];
    if (model === undefined) return null;
    // A plausible slot number to name in the line — the model's own slot count.
    const slot = Math.floor(random() * (model.parallel ?? 1));
    const task = seq + Math.floor(random() * 3);
    const roll = random();

    let level: LogLevel = "INFO";
    let message: string;
    if (roll < 0.1) {
      level = "WARN";
      message = `slot update_slots: id ${slot} | task ${task} | context shift, n_keep = 1024, n_discard = 2048`;
    } else if (roll < 0.14) {
      level = "ERROR";
      const requested = (random() * 20000 + 66000).toFixed(0);
      message = `srv send_error: task ${task} | prompt exceeds context window (${requested} > 65536)`;
    } else if (roll < 0.3) {
      message = "srv log_server_r: request: POST /v1/chat/completions 127.0.0.1 200 (pi/0.9.4)";
    } else if (roll < 0.5) {
      const ms = (200 + random() * 900).toFixed(2);
      const tokens = Math.floor(300 + random() * 2200);
      const perToken = (0.3 + random()).toFixed(2);
      const rate = (900 + random() * 1400).toFixed(1);
      message = `prompt eval time = ${ms} ms / ${tokens} tokens (${perToken} ms per token, ${rate} tokens per second)`;
    } else if (roll < 0.68) {
      const ms = (1500 + random() * 5000).toFixed(2);
      const runs = Math.floor(60 + random() * 400);
      const perToken = (9 + random() * 12).toFixed(2);
      const rate = (45 + random() * 60).toFixed(1);
      message = `eval time = ${ms} ms / ${runs} runs (${perToken} ms per token, ${rate} tokens per second)`;
    } else if (roll < 0.82) {
      message = `slot launch_slot_: id ${slot} | task ${task} | processing task`;
    } else if (roll < 0.92) {
      const nPast = Math.floor(1000 + random() * 30000);
      const cacheTokens = Math.floor(1000 + random() * 30000);
      message = `slot update_slots: id ${slot} | task ${task} | n_past = ${nPast}, cache_tokens = ${cacheTokens}`;
    } else {
      const nTokens = Math.floor(200 + random() * 900);
      message = `slot release: id ${slot} | task ${task} | stop processing: n_tokens = ${nTokens}, truncated = 0`;
    }

    seq += 1;
    return { seq, ts: now(), level, modelId: model.id, message };
  }

  function append(line: LogLine): void {
    log.push(line);
    if (log.length > maxLogLines) log.splice(0, log.length - maxLogLines);
    for (const listener of listeners) listener(line);
  }

  /** Seeded lines ignore the running check — they are pre-existing scrollback. */
  function emit(seeded: boolean): void {
    if (!running && !seeded) return;
    const count = seeded ? 1 : 1 + (random() < 0.4 ? 1 : 0);
    for (let i = 0; i < count; i += 1) {
      const line = makeLine();
      if (line !== null) append(line);
    }
  }

  function tickThroughput(): void {
    throughputHistory.shift();
    // A stopped service generates nothing, so the history decays to zero
    // rather than contradicting the throughput tile.
    throughputHistory.push(running ? 46 + random() * 52 : 0);
  }

  function tickMetrics(): void {
    // Temperatures chase a target derived from the *previous* utilisation, so
    // they lag load the way real sensors do.
    const drift = (current: number, target: number) =>
      Math.max(35, Math.min(92, current + (target - current) * 0.25 + (random() - 0.5) * 1.6));
    gpuTempC = drift(gpuTempC, 48 + gpuUtil * 38);
    cpuTempC = drift(cpuTempC, 38 + cpuUtil * 46);

    throughputTps = Math.round(38 + random() * 62);
    // Mostly nothing queued; occasionally one or two wait for a free slot.
    requestsQueued = Math.max(0, Math.round(random() * 3) - 1);
    vramFraction = Math.min(0.97, 0.55 + random() * 0.2);
    ramFraction = 0.36 + random() * 0.12;
    cpuUtil = 0.12 + random() * 0.3;
    gpuUtil = 0.6 + random() * 0.35;

    for (const model of MODELS) {
      if (unloaded.has(model.id)) continue;
      for (const slot of ensureGroup(model)) {
        const processing = random() < 0.68;
        slot.state = processing ? "processing" : "idle";
        // An idle slot holds nothing; a working one holds a prompt and has
        // decoded part of its reply. Both stay inside the slot's own context.
        slot.promptTokens = processing ? Math.floor(random() * slot.ctxTotal * 0.5) : 0;
        slot.decoded = processing ? Math.floor(random() * 520) : 0;
      }
    }

    modelRates.clear();
    for (const model of MODELS) {
      if (unloaded.has(model.id) || !isBusy(model.id)) continue;
      modelRates.set(model.id, Math.round(throughputTps * (0.5 + random() * 0.6)));
    }
  }

  function buildModels(): ModelInfo[] {
    return MODELS.map((model) => {
      const loaded = !unloaded.has(model.id);
      const active = loaded && running && isBusy(model.id);
      return {
        ...model,
        // llama.cpp ships no `meta` until a model is resident, so an unloaded
        // card has no byte size and no native window — only the args-derived
        // facts survive. Mirroring that here keeps the mock honest.
        sizeGB: loaded ? model.sizeGB : null,
        nativeCtx: loaded ? model.nativeCtx : null,
        status: loaded ? (active ? "active" : "resident") : "unloaded",
        tokensPerSecond: active ? (modelRates.get(model.id) ?? 0) : null,
      };
    });
  }

  function buildSlots(): SlotInfo[] {
    const out: SlotInfo[] = [];
    // In models order, so the grouped strip lines up with the model cards.
    for (const model of MODELS) {
      if (unloaded.has(model.id)) continue;
      const group = slotGroups.get(model.id);
      if (group === undefined) continue;
      for (const slot of group) {
        // A slot cannot be working while the service is down.
        const off = !running;
        out.push({
          id: slot.id,
          modelId: model.id,
          promptTokens: off ? 0 : slot.promptTokens,
          ctxTotal: slot.ctxTotal,
          decoded: off ? 0 : slot.decoded,
          state: off ? "idle" : slot.state,
        });
      }
    }
    return out;
  }

  function buildMetrics(): HostMetrics {
    return {
      vramUsedGB: vramFraction * VRAM_TOTAL_GB,
      vramTotalGB: VRAM_TOTAL_GB,
      ramUsedGB: ramFraction * RAM_TOTAL_GB,
      ramTotalGB: RAM_TOTAL_GB,
      gpuUtil,
      cpuUtil,
      gpuTempC,
      cpuTempC,
    };
  }

  function buildSnapshot(): Snapshot {
    const slots = buildSlots();
    // In-flight requests are exactly the busy slots, so the requests tile and
    // the slots panel always agree.
    const requestsInFlight = running
      ? slots.filter((slot) => slot.state === "processing").length
      : 0;
    return {
      now: now(),
      service: {
        running,
        startedAt: running ? startedAt : null,
        pid: running ? PID : null,
        host: HOST,
        port: PORT,
        build: BUILD,
        // The simulated machine has all three commands declared and consented,
        // so the dev-only dashboard exercises the control row it stands in for;
        // {@link setService} performs them against the simulation.
        controls: ["start", "stop", "restart"],
      },
      models: buildModels(),
      slots,
      metrics: buildMetrics(),
      // The mock preserves today's discrete VRAM+RAM layout exactly. In a later
      // phase Steward reads this from the `steward.json` config artifact; here it
      // is a fixed property of the simulated machine, never a per-tick reading.
      memoryTopology: "discrete",
      throughputTps: running ? throughputTps : 0,
      requestsInFlight,
      throughputHistory: [...throughputHistory],
      requestsQueued: running ? requestsQueued : 0,
      config: [...CONFIG],
    };
  }

  for (let i = 0; i < seedLines; i += 1) emit(true);

  if (logIntervalMs > 0) logTimer = setInterval(() => emit(false), logIntervalMs);
  if (metricsIntervalMs > 0) metricsTimer = setInterval(tickMetrics, metricsIntervalMs);
  if (throughputIntervalMs > 0) {
    throughputTimer = setInterval(tickThroughput, throughputIntervalMs);
  }

  return {
    name: "mock",

    snapshot(): Promise<Snapshot> {
      return Promise.resolve(buildSnapshot());
    },

    recentLogs(limit: number): LogLine[] {
      if (limit <= 0) return [];
      return log.slice(-limit);
    },

    subscribeLogs(listener: (line: LogLine) => void): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setService(action: ServiceAction): Promise<void> {
      if (action === "stop") {
        running = false;
      } else {
        // Both `start` and `restart` begin a fresh run, so uptime resets.
        running = true;
        startedAt = now();
      }
      return Promise.resolve();
    },

    setModel(modelId: string, action: ModelAction): Promise<void> {
      const model = MODELS.find((candidate) => candidate.id === modelId);
      if (model === undefined) {
        return Promise.reject(new Error(`Unknown model: ${modelId}`));
      }
      if (action === "unload") {
        unloaded.add(modelId);
        modelRates.delete(modelId);
        // Its slots go with it; a later load starts from a fresh, idle pool.
        slotGroups.delete(modelId);
      } else {
        unloaded.delete(modelId);
        ensureGroup(model);
      }
      return Promise.resolve();
    },

    tickLogs(): void {
      emit(false);
    },

    tickMetrics,

    tickThroughput,

    close(): void {
      if (logTimer !== null) clearInterval(logTimer);
      if (metricsTimer !== null) clearInterval(metricsTimer);
      if (throughputTimer !== null) clearInterval(throughputTimer);
      logTimer = null;
      metricsTimer = null;
      throughputTimer = null;
      listeners.clear();
    },
  };
}
