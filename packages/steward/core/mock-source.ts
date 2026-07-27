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
const SESSIONS = 3;
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
    role: "chat",
    quant: "Q4_K_M",
    sizeGB: 18.4,
    ctx: 65536,
    gpuLayers: 48,
    detail: null,
    parallel: 4,
    flashAttn: "on",
    kvCache: "q8_0/q8_0",
  },
  {
    id: "qwen3.6-moe-30b-thinking-q5_k_m",
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
  },
  {
    id: "qwen3.6-moe-coder-fim-q4_k_m",
    short: "qwen3.6-moe-coder-fim",
    role: "fim",
    quant: "Q4_K_M",
    sizeGB: 9.8,
    ctx: 16384,
    gpuLayers: 32,
    detail: null,
    parallel: 4,
    flashAttn: "on",
    kvCache: "f16/f16",
  },
  {
    id: "nomic-embed-text-v1.5-f16",
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
  },
] as const satisfies readonly ModelSpec[];

// Per-model tuning (parallel, flash-attention, KV-cache) lives on each model
// card, not here: in routed mode the router runs one `llama-server` per model,
// so those values differ between models and there is no single global figure.
// What remains is genuinely router-wide.
const CONFIG: readonly ConfigEntry[] = [
  { key: "binary", value: "llama-server b6122" },
  { key: "listen", value: "127.0.0.1:8080" },
  { key: "router", value: "--model-alias per pi profile" },
  { key: "supervisor", value: "launchd · app.netservant.llamacpp" },
];

/** A slot as the simulation keeps it; {@link SlotInfo} is the projection. */
interface SlotSim {
  id: number;
  modelId: string | null;
  client: string;
  ctxUsed: string;
  tokens: number;
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
  let requestsPerMinute = 0;
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

  const slots: SlotSim[] = [
    {
      id: 0,
      modelId: MODELS[0].id,
      client: "pi · edit-session",
      ctxUsed: "12.4k",
      tokens: 268,
      state: "processing",
    },
    {
      id: 1,
      modelId: MODELS[2].id,
      client: "pi · inline-fim",
      ctxUsed: "3.1k",
      tokens: 41,
      state: "processing",
    },
    {
      id: 2,
      modelId: MODELS[1].id,
      client: "pi · plan-agent",
      ctxUsed: "21.8k",
      tokens: 0,
      state: "idle",
    },
    { id: 3, modelId: null, client: "—", ctxUsed: "—", tokens: 0, state: "idle" },
  ];

  /** Per-model generation rate, refreshed on each metrics tick. */
  const modelRates = new Map<string, number>();

  const log: LogLine[] = [];
  const listeners = new Set<(line: LogLine) => void>();

  let logTimer: ReturnType<typeof setInterval> | null = null;
  let metricsTimer: ReturnType<typeof setInterval> | null = null;
  let throughputTimer: ReturnType<typeof setInterval> | null = null;

  function isBusy(modelId: string): boolean {
    return slots.some((slot) => slot.modelId === modelId && slot.state === "processing");
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
    const slot = Math.floor(random() * slots.length);
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
    requestsPerMinute = Math.round(9 + random() * 14);
    vramFraction = Math.min(0.97, 0.55 + random() * 0.2);
    ramFraction = 0.36 + random() * 0.12;
    cpuUtil = 0.12 + random() * 0.3;
    gpuUtil = 0.6 + random() * 0.35;

    for (const slot of slots) {
      if (slot.modelId === null) continue;
      slot.state = random() < 0.68 ? "processing" : "idle";
      slot.tokens = Math.floor(random() * 520);
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
        status: loaded ? (active ? "active" : "resident") : "unloaded",
        tokensPerSecond: active ? (modelRates.get(model.id) ?? 0) : null,
      };
    });
  }

  function buildSlots(): SlotInfo[] {
    return slots.map((slot) => {
      // A slot cannot be working if the service is down or its model left.
      const off = slot.modelId === null || unloaded.has(slot.modelId) || !running;
      return {
        id: slot.id,
        modelId: slot.modelId,
        client: slot.client,
        ctxUsed: slot.ctxUsed,
        tokens: slot.tokens,
        state: off ? "idle" : slot.state,
      };
    });
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
    return {
      now: now(),
      service: {
        running,
        startedAt: running ? startedAt : null,
        pid: running ? PID : null,
        host: HOST,
        port: PORT,
        build: BUILD,
      },
      models: buildModels(),
      slots: buildSlots(),
      metrics: buildMetrics(),
      throughputTps: running ? throughputTps : 0,
      requestsPerMinute: running ? requestsPerMinute : 0,
      throughputHistory: [...throughputHistory],
      sessions: SESSIONS,
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
      if (!MODELS.some((model) => model.id === modelId)) {
        return Promise.reject(new Error(`Unknown model: ${modelId}`));
      }
      if (action === "unload") {
        unloaded.add(modelId);
        modelRates.delete(modelId);
      } else {
        unloaded.delete(modelId);
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
