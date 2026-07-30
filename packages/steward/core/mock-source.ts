/**
 * A simulated {@link StewardDataSource}.
 *
 * It stands in for a real `llama-server` so the dashboard can be developed,
 * demoed, and tested without one: four models, a log stream shaped like
 * llama.cpp's own output, drifting host sensors, and slots that pick work up
 * and put it down. Nothing here talks to the network, and nothing appends to
 * the log while the service is stopped.
 *
 * **The log is written against a measured corpus, not from memory.** Everything
 * it emits was counted in 15,842 real lines over 16 router boots, and the shapes
 * that a previous version of this file invented — `log_server_r`, `send_error`,
 * `update_slots` context shifts, bare `prompt eval time` — occur exactly zero
 * times in reality and are gone. What that buys is a dev dashboard that teaches
 * the truth about its own console:
 *
 *   - **It is bursty, not a metronome.** A real router with a model resident and
 *     nothing to do writes 0 lines in 44 s. Silence, then 8 lines for a request,
 *     then silence. The one thing that never stops is Steward's own polling.
 *   - **`proxy_reques` dominates** — 86.9% of the corpus, because `/slots` and
 *     `/metrics` each cost one line per poll per loaded model. The console hides
 *     these by default and has to be able to prove why.
 *   - **A quarter of it is about no model at all.** The boot banner, the preset
 *     catalogue and the 31-line launch-args block are router-wide, so they carry
 *     `modelId: null` and exercise the console's `router` column.
 *   - **The level mix is INFO with rounding errors** — 98.95% INFO, 0.63% WARN,
 *     no ERROR at all in four days. ERROR here is a rare simulated client
 *     disconnect, which is one of only two ways a real router emits one.
 *   - **Loading and unloading are loud.** A load is 46 lines (31 of them args),
 *     an unload is 5. Changing state silently, as this mock used to, hid the
 *     most visible thing an operator ever does.
 *
 * `random` and `now` are injectable so tests get a fixed simulation, and each
 * ticker can be driven by hand (`tickLogs`, `tickMetrics`, `tickThroughput`)
 * instead of by timers. Keep this module free of Node and DOM APIs — see
 * `./types.ts`.
 */

import { unknownDrift } from "./drift.js";
import { classifyFamily } from "./log-parse.js";
import type { LogAttachment, StewardDataSource, Unsubscribe } from "./source.js";
import type {
  ConfigEntry,
  HostMetrics,
  LogFamily,
  LogFrame,
  LogKind,
  LogLevel,
  LogLine,
  LogOrigin,
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
  /**
   * The simulation always opens a console atomically, so callers holding a mock
   * need no fallback for it (on the seam it is optional, for sources that
   * predate it).
   */
  attachLogs(listener: (line: LogLine) => void, limit: number): LogAttachment;
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
/**
 * Enough scrollback for the seeded story to be complete: a router boot, one load
 * per resident model (46 lines each), the four requests that put the task
 * column, the badges and the trace on screen, a disconnect, and some traffic on
 * top. A client replays 200 lines on connect, so this is exactly what the
 * console opens on — and the story has to keep fitting inside it, or the boot
 * banner falls off the first paint.
 */
const DEFAULT_SEED_LINES = 200;

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

/**
 * One line the simulation is about to write, before it is given a sequence
 * number and an arrival stamp. `kind` and `origin` are set here rather than
 * inferred later for the same reason the real tailer sets them at parse time:
 * the producer is the only layer that knows.
 */
interface LogDraft {
  level: LogLevel;
  message: string;
  modelId: string | null;
  kind: LogKind;
  origin: LogOrigin;
  /** The child's port for a `[port]`-prefixed line: half the trace key. */
  port?: number;
  /** The `SLT_*` pipe frame, on the lines that really carry one. */
  frame?: LogFrame;
  contextLost?: boolean;
  cacheHit?: number;
}

/**
 * `slot print_timing: id  0 | task 81259 | ` exactly as llama.cpp's shared
 * `SLT_*` macro writes it: `slot %12.*s: id %2d | task %d | `, function name
 * right-aligned and truncated in a 12-character field.
 */
function frameFor(fn: string, slot: number, task: number): LogFrame {
  return {
    slot,
    task,
    raw: `slot ${fn.slice(0, 12).padStart(12)}: id ${String(slot).padStart(2)} | task ${task} | `,
  };
}

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

  /** The ephemeral port each resident model's child server listens on. */
  const modelPorts = new Map<string, number>();
  /**
   * Task ids, as llama.cpp really allocates them: **one counter per child
   * process, starting at 0**. So two children genuinely collide — both their
   * first requests are `task 0` — which is exactly why a trace is keyed on
   * `(port, task)` and never on the id alone.
   */
  const taskCounters = new Map<number, number>();
  /** Lines an episode has queued but not yet written — the simulation's burst. */
  const pending: LogDraft[] = [];

  /**
   * The next task id on one child, with the measured shape: **sparse**, with
   * deltas of up to a few hundred, because every internal task (metrics, slot
   * save, cancel) bumps the same counter. A task id is an opaque handle, not a
   * request number, and the console's copy says so — this is what makes that
   * claim testable.
   */
  function nextTaskFor(port: number): number {
    const current = taskCounters.get(port) ?? 0;
    taskCounters.set(port, current + 1 + Math.floor(random() * 400));
    return current;
  }

  /** A fresh ephemeral port for a spawning child; real ports are never reused. */
  function portFor(modelId: string): number {
    const existing = modelPorts.get(modelId);
    if (existing !== undefined) return existing;
    const port = 49_152 + Math.floor(random() * 16_000);
    modelPorts.set(modelId, port);
    return port;
  }

  /** A line the router wrote itself: no `[port]` prefix, usually no model. */
  function router(
    message: string,
    modelId: string | null = null,
    level: LogLevel = "INFO",
    kind: LogKind = "event",
  ): LogDraft {
    return { level, message, modelId, kind, origin: "router" };
  }

  /** A line a child model server wrote, which the router echoed `[port]`-prefixed. */
  function child(
    message: string,
    modelId: string,
    level: LogLevel = "INFO",
    kind: LogKind = "event",
  ): LogDraft {
    return { level, message, modelId, kind, origin: "child", port: portFor(modelId) };
  }

  /** A pipe-framed `slot` line — the only class of line that carries a task. */
  function slotLine(
    fn: string,
    slot: number,
    task: number,
    body: string,
    modelId: string,
    kind: LogKind = "event",
    extra: { level?: LogLevel; contextLost?: boolean; cacheHit?: number } = {},
  ): LogDraft {
    return {
      ...child(body, modelId, extra.level ?? "INFO", kind),
      frame: frameFor(fn, slot, task),
      ...(extra.contextLost === true ? { contextLost: true } : {}),
      ...(extra.cacheHit === undefined ? {} : { cacheHit: extra.cacheHit }),
    };
  }

  /**
   * The 11 lines a router writes within 81 ms of starting, every time. They are
   * router-wide to a line — this is the block that makes `modelId: null` the
   * common case it really is, and the two `W`s are the only warnings a healthy
   * router ever produces.
   */
  function bootEpisode(): LogDraft[] {
    return [
      router(
        "cmn  common_param: common_params_print_info: verbosity = 3 (adjust with the `-lv N` CLI arg)",
      ),
      router(`srv   load_models: Loaded ${MODELS.length} cached model presets`),
      router(`srv    operator(): Available models (${MODELS.length}):`),
      ...MODELS.map((model) => router(`srv    operator():     ${model.id}`)),
      router(
        "srv  llama_server: starting server in router mode. models will be automatically loaded on-demand",
      ),
      router(`srv  llama_server: listening on http://${HOST}:${PORT}`),
      router("srv  llama_server: NOTE: router mode is experimental", null, "WARN"),
      router(
        "srv  llama_server:       it is not recommended to use this mode in untrusted environments",
        null,
        "WARN",
      ),
    ];
  }

  /**
   * The 31 argv tokens a child is spawned with — one per log line, which is
   * exactly why the console folds them: `--ctx-size` and `131072` are two
   * separate, individually meaningless records that together are the launch
   * command Steward's drift check is about.
   */
  function launchArgs(model: ModelSpec, port: number): string[] {
    const [cacheK = "f16", cacheV = "f16"] = model.kvCache.split("/");
    return [
      "/opt/homebrew/bin/llama-server",
      "--model",
      `/Users/steward/.local/share/llama/models/${model.id}.gguf`,
      "--alias",
      model.id,
      "--ctx-size",
      String((model.ctx ?? 4096) * (model.parallel ?? 1)),
      "--parallel",
      String(model.parallel ?? 1),
      "--n-gpu-layers",
      String(model.gpuLayers ?? 99),
      "--cache-type-k",
      cacheK,
      "--cache-type-v",
      cacheV,
      "--flash-attn",
      model.flashAttn,
      "--threads",
      "10",
      "--keep",
      "-1",
      "--slots",
      "--metrics",
      "--jinja",
      "--no-webui",
      "--host",
      HOST,
      "--port",
      String(port),
      "--verbosity",
      "3",
    ];
  }

  /**
   * A model load: 46 lines, 31 of them the args block, and the only textual
   * progress a load has. There is no load-progress line in llama.cpp — the IPC
   * records carry `value: 0.0` then `1.0` and nothing in between — so the
   * dashboard's progress comes from `/models`, never from here.
   */
  function loadEpisode(model: ModelSpec): LogDraft[] {
    const port = portFor(model.id);
    const path = `/Users/steward/.local/share/llama/models/${model.id}.gguf`;
    return [
      router(
        `srv          load: spawning server instance with name=${model.id} on port ${port}`,
        model.id,
      ),
      router("srv          load: spawning server instance with args:"),
      ...launchArgs(model, port).map((arg) =>
        router(`srv          load:   ${arg}`, null, "INFO", "args"),
      ),
      child(
        `cmd_child_to_router:state:{"state":"loading","payload":{"id":"${model.id}"},"value":0.0}`,
        model.id,
      ),
      child(
        "cmn  common_param: common_params_print_info: verbosity = 3 (adjust with the `-lv N` CLI arg)",
        model.id,
      ),
      child(`srv    load_model: loading model '${path}'`, model.id),
      // Comp-less library warnings: no component, no function convention — the
      // class the naive `<comp> <fn>:` grammar gets wrong.
      child(
        "load: setting token '<|message|>' (200008) attribute to USER_DEFINED (16), old attributes: 8",
        model.id,
        "WARN",
      ),
      child(
        "load: setting token '<|channel|>' (200005) attribute to USER_DEFINED (16), old attributes: 8",
        model.id,
        "WARN",
      ),
      child(
        "load: special_eog_ids contains both '<|return|>' and '<|end|>' tokens, removing '<|end|>' token from EOG list",
        model.id,
        "WARN",
      ),
      child(
        `load: override 'tokenizer.ggml.add_bos_token' to 'true' for ${model.short}`,
        model.id,
        "WARN",
      ),
      child(
        `cmd_child_to_router:state:{"state":"loading","payload":{"id":"${model.id}"},"value":0.5}`,
        model.id,
      ),
      child(
        `srv    load_model: initializing, n_slots = ${model.parallel ?? 1}, n_ctx_slot = ${model.ctx ?? 4096}, kv_unified = 'false'`,
        model.id,
      ),
      child("srv  llama_server: model loaded", model.id),
      child(`srv  llama_server: listening on http://${HOST}:${port}`, model.id),
      child(
        "srv    operator(): child server monitoring thread started, waiting for EOF on stdin...",
        model.id,
      ),
      child(
        `cmd_child_to_router:state:{"state":"ready","payload":{"id":"${model.id}","meta":{"n_ctx":${model.ctx ?? 4096},"n_ctx_train":${model.nativeCtx ?? 4096},"size":${Math.round((model.sizeGB ?? 1) * 1e9)}}},"value":1.0}`,
        model.id,
      ),
    ];
  }

  /**
   * One inference: the router's proxy line and seven child lines, plus a live
   * rate line for every ~3 s the generation ran. That is the whole of it —
   * llama.cpp writes nothing else per request.
   */
  interface RequestOptions {
    /**
     * Rate lines to guarantee. The seeded story needs at least one on first
     * paint, and a dice roll is no way to get first-paint coverage.
     */
    minRateLines?: number;
    /**
     * A task id to use instead of the counter's next. The seeded story uses it
     * twice: once for a request that logs a LOWER id than the one before it on
     * the same port (ids are allocated at enqueue and slots granted at dequeue,
     * so a deferred task really does log out of order), and once to make two
     * children collide on the same id.
     */
    task?: number;
    /** Pins the decode slot, so the slot badge's reveal path is exercised. */
    slot?: number;
    /** Emits `truncated = 1` — the one signal that a reply lost its context. */
    truncated?: boolean;
  }

  function requestEpisode(model: ModelSpec, options: RequestOptions = {}): LogDraft[] {
    const port = portFor(model.id);
    const task = options.task ?? nextTaskFor(port);
    const slot = options.slot ?? Math.floor(random() * (model.parallel ?? 1));
    const promptTokens = Math.floor(40 + random() * 3000);
    const decoded = Math.floor(40 + random() * 600);
    const promptMs = 40 + random() * 400;
    const evalMs = decoded * (5 + random() * 8);
    const tps = (decoded / evalMs) * 1000;
    const cacheHit = Number(random().toFixed(3));
    // One rate line per three seconds of generation, and none at all for a
    // request that finished inside the window — which is most of them.
    const rateLines = Math.max(options.minRateLines ?? 0, Math.min(3, Math.floor(evalMs / 3000)));
    const timing = (body: string): LogDraft =>
      slotLine("print_timings", slot, task, body, model.id);

    return [
      router(
        `srv  proxy_reques: proxying request to model ${model.id} on port ${port}`,
        model.id,
        "INFO",
        "proxy",
      ),
      // `task -1`: no task is attached when the slot is chosen, which is why
      // this line has no trace button and joins its trace by adjacency.
      slotLine(
        "get_available_slot",
        slot,
        -1,
        `selected slot by LCP similarity, sim_best = ${cacheHit.toFixed(3)} (> 0.100 thold), f_keep = 0.024`,
        model.id,
        "event",
        { cacheHit },
      ),
      slotLine("launch_slot_with_task", slot, task, "processing task, is_child = 0", model.id),
      ...Array.from({ length: rateLines }, (_unused, index) =>
        slotLine(
          "print_timings_tg",
          slot,
          task,
          `n_decoded = ${Math.floor((decoded * (index + 1)) / (rateLines + 1))}, tg = ${tps.toFixed(2)} t/s, tg_3s = ${(tps * (0.9 + random() * 0.2)).toFixed(2)} t/s`,
          model.id,
          "rate",
        ),
      ),
      timing(
        `prompt eval time = ${promptMs.toFixed(2)} ms / ${promptTokens} tokens (${(promptMs / promptTokens).toFixed(2)} ms per token, ${((promptTokens / promptMs) * 1000).toFixed(2)} tokens per second)`,
      ),
      timing(
        `       eval time = ${evalMs.toFixed(2)} ms / ${decoded} tokens (${(evalMs / decoded).toFixed(2)} ms per token, ${tps.toFixed(2)} tokens per second)`,
      ),
      timing(
        `      total time = ${(promptMs + evalMs).toFixed(2)} ms / ${promptTokens + decoded} tokens`,
      ),
      timing(`   graphs reused = ${Math.floor(random() * 90000)}`),
      slotLine(
        "release",
        slot,
        task,
        `stop processing: n_tokens = ${promptTokens + decoded}, truncated = ${options.truncated === true ? 1 : 0}`,
        model.id,
        "event",
        options.truncated === true ? { contextLost: true } : {},
      ),
    ];
  }

  /**
   * One `/slots` or `/metrics` poll. This is the line the console hides by
   * default, and Steward is the one causing it: two per snapshot per loaded
   * model, forever, whether or not anybody is using the server.
   */
  function pollEpisode(model: ModelSpec): LogDraft[] {
    return [
      router(
        `srv  proxy_reques: proxying request to model ${model.id} on port ${portFor(model.id)}`,
        model.id,
        "INFO",
        "proxy",
      ),
    ];
  }

  /** An unload: five lines in about a sixth of a second. */
  function unloadEpisode(model: ModelSpec): LogDraft[] {
    return [
      router(`srv        unload: stopping model instance name=${model.id}`, model.id),
      router(`srv    operator(): stopping model instance name=${model.id}`, model.id),
      child("srv    operator(): exit command received, exiting...", model.id),
      child("srv    operator(): operator(): cleaning up before exit...", model.id),
      // A failed exit reports the same level; only the status number differs.
      router(`srv    operator(): instance name=${model.id} exited with status 0`, model.id),
    ];
  }

  /**
   * A client that hangs up mid-stream — one of only two ways a real router logs
   * an `E`, and the honest one to simulate. Note the shape of it: the ERROR is
   * router-wide and the matching WARN is attributed, so one event lands in two
   * different scopes. The console must not invent an attribution to tidy that up.
   */
  function disconnectEpisode(model: ModelSpec): LogDraft[] {
    const task = nextTaskFor(portFor(model.id));
    return [
      router("srv    operator(): http client error: Connection handling canceled", null, "ERROR"),
      child("srv          stop: cancel task, id_task = 0", model.id, "WARN"),
      slotLine(
        "release",
        0,
        task,
        `stop processing: n_tokens = ${Math.floor(100 + random() * 900)}, truncated = 0`,
        model.id,
      ),
    ];
  }

  /**
   * A shape no classifier rule matches: router-origin, unframed, no `name=`,
   * none of the boot vocabulary — and a payload that LOOKS pipe-framed without
   * being it. It exists so `other` is never zero, because `other` is the drift
   * alarm and an alarm that has never fired has never been seen to work.
   */
  function unclassifiedEpisode(): LogDraft[] {
    return [router("srv   frobnicate: widget 3 | zone 7 | reticulating splines")];
  }

  /**
   * What happens next on an otherwise idle router. The weights are the measured
   * ones: Steward's own polling is almost all of it, a real request is rare, an
   * `E` is rarer still, and sometimes the answer is that nothing happens — which
   * is the state a real router spends most of its life in.
   */
  function planTraffic(): void {
    const loaded = MODELS.filter((model) => !unloaded.has(model.id));
    const model = loaded[Math.floor(random() * loaded.length)];
    // Nothing resident means nothing to proxy and no child to write: the log
    // goes quiet rather than inventing traffic.
    if (model === undefined) return;

    const roll = random();
    if (roll < 0.93) pending.push(...pollEpisode(model));
    else if (roll < 0.95) pending.push(...requestEpisode(model));
    else if (roll < 0.951) pending.push(...disconnectEpisode(model));
    // Otherwise: silence.
  }

  /**
   * Forgets queued lines for a model that has just gone away — and everything
   * queued once nothing is resident at all, because a router with no children
   * has nothing left in flight to write about.
   */
  function dropPending(modelId: string): void {
    const kept = pending.filter((draft) => draft.modelId !== modelId);
    pending.length = 0;
    const anyLeft = MODELS.some((model) => model.id !== modelId && !unloaded.has(model.id));
    if (anyLeft) pending.push(...kept);
  }

  /** The line before the one being appended — the catalogue rule's only state. */
  let lastLine: { family: LogFamily; message: string } | null = null;

  function append(draft: LogDraft): void {
    seq += 1;
    const line: LogLine = {
      seq,
      ts: now(),
      level: draft.level,
      modelId: draft.modelId,
      message: draft.message,
      kind: draft.kind,
      origin: draft.origin,
      // Through the parser's own rules, not a copy of them: a simulation that
      // classified its lines differently from the real source would be a second
      // grammar to keep in step, and the two would drift.
      family: classifyFamily({
        frame: draft.frame ?? null,
        kind: draft.kind,
        origin: draft.origin,
        message: draft.message,
        // The catalogue rule is positional, so the simulation has to carry the
        // same one line of state the parser does.
        previous: lastLine === null ? null : { family: lastLine.family, message: lastLine.message },
      }),
      ...(draft.port === undefined ? {} : { port: draft.port }),
      ...(draft.frame === undefined ? {} : { frame: draft.frame }),
      ...(draft.contextLost === true ? { contextLost: true } : {}),
      ...(draft.cacheHit === undefined ? {} : { cacheHit: draft.cacheHit }),
    };
    lastLine = { family: line.family ?? "other", message: line.message };
    log.push(line);
    if (log.length > maxLogLines) log.splice(0, log.length - maxLogLines);
    for (const listener of listeners) listener(line);
  }

  /**
   * Writes a burst immediately rather than queueing it. Load and unload are
   * operator actions whose lines land in a couple of hundred milliseconds — long
   * before the next log tick — and dribbling them out would misrepresent both
   * the cadence and the causality.
   */
  function flush(drafts: readonly LogDraft[]): void {
    for (const draft of drafts) append(draft);
  }

  /** Seeded lines ignore the running check — they are pre-existing scrollback. */
  function emit(seeded: boolean): void {
    if (!running && !seeded) return;
    if (pending.length === 0) planTraffic();
    const count = seeded ? 1 : 1 + (random() < 0.4 ? 1 : 0);
    for (let i = 0; i < count; i += 1) {
      const draft = pending.shift();
      if (draft === undefined) return;
      append(draft);
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
      // The simulation has no launchd plist to re-read and no consent map to
      // fall out of, so it asserts NOTHING about drift. `unknown` renders no
      // notice — and, unlike a fabricated `clean`, it is not a claim that a
      // machine the mock never looked at is configured correctly.
      drift: unknownDrift("the simulated source does not re-validate launch flags"),
      throughputTps: running ? throughputTps : 0,
      requestsInFlight,
      throughputHistory: [...throughputHistory],
      // The simulated series is a shape, not a measurement of any wall clock, so
      // the mock claims no window and the tile prints none. Inventing one would
      // put a span on a tile that nothing was ever timed over.
      throughputWindowSeconds: null,
      requestsQueued: running ? requestsQueued : 0,
      config: [...CONFIG],
    };
  }

  // The scrollback a client sees on connect is a story, not a sample: the router
  // booted, loaded what is resident, dropped the model it is no longer holding,
  // served a request, and had one client hang up. That is what puts the
  // router-wide rows, the args fold, a live rate line, a model lifecycle exit
  // and the ERROR path on the console's FIRST paint, rather than leaving them to
  // the dice.
  pending.push(...bootEpisode());
  for (const model of MODELS) {
    if (!unloaded.has(model.id)) pending.push(...loadEpisode(model));
  }
  // Why the embedder is unloaded now: the router evicted it, and said so.
  const [firstUnloaded] = MODELS.filter((model) => unloaded.has(model.id));
  if (firstUnloaded !== undefined) pending.push(...unloadEpisode(firstUnloaded));
  // Then the cases none of this is visible without. Each is here because a
  // console feature is unproven until the simulation produces the shape it is
  // for: an operator (and a test) has to be able to SEE it working.
  const loadedForStory = MODELS.filter((model) => !unloaded.has(model.id));
  const [firstLoaded, secondLoaded] = loadedForStory;
  if (firstLoaded !== undefined) {
    // A first request, which takes task 0 on its port — sparse ids start there.
    pending.push(...requestEpisode(firstLoaded, { minRateLines: 1, task: 0, slot: 0 }));
    // A SECOND slot id, so the slot badge's `parallel > 1` reveal path runs.
    pending.push(
      ...requestEpisode(firstLoaded, { slot: (firstLoaded.parallel ?? 1) > 1 ? 1 : 0, task: 211 }),
    );
    // A task id that goes DOWN in file order — ids are allocated at enqueue and
    // slots granted at dequeue, so a deferred task logs later with a lower id —
    // carrying the `truncated = 1` that is 0/217 on the machine this was
    // measured on, and is exactly why it has to be reachable here.
    pending.push(...requestEpisode(firstLoaded, { task: 209, slot: 0, truncated: true }));
    pending.push(...disconnectEpisode(firstLoaded));
  }
  // Two children, two ports, the SAME task id. A trace keyed on the id alone
  // shows both models' lines under one request; keyed on `(port, task)` it does
  // not, and the difference is visible here.
  if (secondLoaded !== undefined) {
    pending.push(...requestEpisode(secondLoaded, { task: 0 }));
  }
  pending.push(...unclassifiedEpisode());
  // Then ordinary traffic up to the seed size — mostly Steward's own polling,
  // which is exactly what a real idle router's tail looks like. Traffic is
  // bursty and sometimes silent, so this counts lines rather than attempts; the
  // outer bound keeps a simulation with nothing resident from spinning.
  for (let attempt = 0; attempt < seedLines * 4 && log.length < seedLines; attempt += 1) {
    emit(true);
  }

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

    attachLogs(listener: (line: LogLine) => void, limit: number): LogAttachment {
      // One step, no suspension point: the same guarantee the file tailer makes,
      // so the stream route has one contract whichever source is behind it.
      const backlog = limit <= 0 ? [] : log.slice(-limit);
      listeners.add(listener);
      return {
        backlog,
        unsubscribe: () => {
          listeners.delete(listener);
        },
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
      const wasLoaded = !unloaded.has(modelId);
      if (action === "unload") {
        // The lines come first: they describe the instance that is going away,
        // and a real unload names it on the way out.
        if (running && wasLoaded) flush(unloadEpisode(model));
        // Traffic still queued for it dies with the instance — a child that has
        // exited writes nothing, and the console would otherwise show slot work
        // for a model the dashboard already reports as gone.
        dropPending(modelId);
        unloaded.add(modelId);
        modelRates.delete(modelId);
        // Its slots go with it; a later load starts from a fresh, idle pool.
        slotGroups.delete(modelId);
        // Ports are ephemeral: the next load of this model gets a new one.
        modelPorts.delete(modelId);
      } else {
        unloaded.delete(modelId);
        ensureGroup(model);
        if (running && !wasLoaded) flush(loadEpisode(model));
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
