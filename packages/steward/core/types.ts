/**
 * Domain types shared by every layer of Steward.
 *
 * The server produces these, the browser consumes them, and the data source
 * (mock today, a live `llama-server` later) is the only thing that knows how
 * they were obtained. Keep this module free of Node and DOM APIs: it is
 * type-checked by both the Node project and the browser project.
 */

/** Log severities Steward renders. `DEBUG` is parsed but rarely emitted. */
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

/**
 * Lifecycle of a model as shown on its card.
 *
 * `active` and `resident` both mean loaded — `active` when at least one of the
 * model's parallel slots is generating, `resident` when it is idle. `loading`
 * and `downloading` are the two ways a load is still in flight: spawning the
 * child, or fetching the weights for the first time. A model llama.cpp reports
 * as `sleeping` folds into `resident` — from the operator's seat it is loaded
 * and ready, which is all the card says.
 */
export type ModelStatus = "active" | "resident" | "loading" | "downloading" | "unloaded";

/** Whether a parallel slot is currently generating. */
export type SlotState = "processing" | "idle";

/** Actions the operator can take on the service as a whole. */
export type ServiceAction = "start" | "stop" | "restart";

/** Actions the operator can take on a single model. */
export type ModelAction = "load" | "unload";

/** The `llama-server` process Steward is pointed at. */
export interface ServiceInfo {
  running: boolean;
  /** Epoch ms the current run began, or `null` when stopped. */
  startedAt: number | null;
  pid: number | null;
  host: string;
  port: number;
  /** llama.cpp build tag, e.g. `b6122`. */
  build: string;
}

/** One model known to the router, resident or not. */
export interface ModelInfo {
  id: string;
  /** Display name — the id with its repo prefix and quant suffix trimmed. */
  short: string;
  /**
   * An embedding model — one whose `architecture.output_modalities` does not
   * include `text`. Drives the card color (embedders get a reserved hue) and
   * the detail line; it is not a guess at what the operator uses it for.
   */
  embedding: boolean;
  /** Quantisation label, e.g. `Q4_0`. Best-effort from the id when unloaded. */
  quant: string;
  /**
   * Size on disk, or `null` when the model is not loaded: llama.cpp only
   * reports a `meta` block (where the byte size lives) for resident models.
   */
  sizeGB: number | null;
  /**
   * Per-slot context length. Loaded: `meta.n_ctx`. Unloaded preset: the pinned
   * `--ctx-size ÷ --parallel`, so it matches the loaded per-slot figure. `null`
   * when neither is known.
   */
  ctx: number | null;
  /**
   * The model's native (training) context window, `meta.n_ctx_train`. Loaded
   * only — llama.cpp ships no `meta` until then — so `null` when unloaded. It is
   * the ceiling the per-slot {@link ctx} is carved out of.
   */
  nativeCtx: number | null;
  /**
   * Layers offloaded to the GPU when `--n-gpu-layers` is pinned in the model's
   * launch args, else `null` — the server's own default is not reported back.
   */
  gpuLayers: number | null;
  /** Trailing detail for the card's meta line, e.g. `embedding`; else `null`. */
  detail: string | null;
  /**
   * Parallel decode slots this model has (`--parallel`). Per-model in routed
   * mode: the router runs one `llama-server` per model, each with its own slot
   * count. Once loaded the slot array is the authority; an unloaded preset model
   * gets it from its pinned `--parallel` arg, and it is `null` when neither is
   * known.
   */
  parallel: number | null;
  /**
   * Flash-attention setting (`--flash-attn`). `auto` is the server default and
   * resolves to on or off at load time; the launch args can pin it either way.
   */
  flashAttn: "on" | "off" | "auto";
  /** KV-cache types as `key/value`, e.g. `q8_0/q8_0` (`--cache-type-k/-v`). */
  kvCache: string;
  status: ModelStatus;
  /** Generation rate while active, else `null`. */
  tokensPerSecond: number | null;
}

/**
 * One parallel slot of one loaded model. Slots are numbered per model, from 0,
 * because in routed mode each model runs its own `llama-server` with its own
 * slot pool — a flat, server-wide slot strip does not exist.
 */
export interface SlotInfo {
  /** Per-model slot index, from 0. */
  id: number;
  /** The model this slot belongs to; always known (slots are fetched per model). */
  modelId: string;
  /** Prompt tokens held in the slot's context (`n_prompt_tokens`); 0 when idle. */
  promptTokens: number;
  /** The slot's context length in tokens (`n_ctx`). */
  ctxTotal: number;
  /** Tokens generated so far this turn (`next_token[0].n_decoded`); 0 when idle. */
  decoded: number;
  state: SlotState;
}

/**
 * How the machine's memory is laid out, a static property of the hardware — not
 * a per-sample reading (per M5: a per-line topology would thrash the gauge set).
 * `discrete` machines have separate VRAM and RAM; `unified` machines (e.g. Apple
 * Silicon) share one pool and expose no readable VRAM total, so they show a
 * single Unified RAM gauge instead of the VRAM+RAM pair.
 */
export type MemoryTopology = "unified" | "discrete";

/** Host sensors. Temperatures are `null` where the platform cannot supply them. */
export interface HostMetrics {
  vramUsedGB: number;
  vramTotalGB: number;
  ramUsedGB: number;
  ramTotalGB: number;
  /** GPU utilisation, 0–1. */
  gpuUtil: number;
  /** CPU utilisation, 0–1. */
  cpuUtil: number;
  gpuTempC: number | null;
  cpuTempC: number | null;
}

/** A read-only key/value row in the rail's config block. */
export interface ConfigEntry {
  key: string;
  value: string;
}

/** One line of the server log. */
export interface LogLine {
  /** Monotonic per-source sequence number; also the render key. */
  seq: number;
  /** Epoch ms. Formatted as `HH:MM:SS.mmm` at render time. */
  ts: number;
  level: LogLevel;
  /** Model the line was attributed to, or `null` when it is not slot traffic. */
  modelId: string | null;
  message: string;
}

/**
 * Everything the dashboard needs for one repaint, other than the log stream.
 * The browser polls this; nothing in it is incremental.
 */
export interface Snapshot {
  /** Epoch ms the snapshot was taken, so the client need not trust its clock. */
  now: number;
  service: ServiceInfo;
  models: ModelInfo[];
  slots: SlotInfo[];
  metrics: HostMetrics;
  /**
   * Which gauge SET the HOST block lays out (VRAM+RAM vs a single Unified
   * Memory). Static machine config, not a reading — it lives here at the top
   * level, never inside {@link HostMetrics}. In a later phase this is read from
   * the `steward.json` config artifact; today the mock reports `discrete`.
   */
  memoryTopology: MemoryTopology;
  /** Aggregate generation rate across all slots, tokens/second. */
  throughputTps: number;
  /**
   * Requests being processed across all slots right now. llama.cpp exposes no
   * request-rate metric, so the requests tile reports this live gauge (and
   * {@link requestsQueued}) rather than a per-minute rate it cannot measure.
   */
  requestsInFlight: number;
  /** Rolling tok/s samples, oldest first. 42 samples ≈ 2 minutes. */
  throughputHistory: number[];
  /** Requests accepted but waiting for a free slot. */
  requestsQueued: number;
  config: ConfigEntry[];
}

/** Number of samples in {@link Snapshot.throughputHistory}. */
export const THROUGHPUT_HISTORY_SIZE = 42;

/** Seconds between throughput samples, matching the metrics poll. */
export const THROUGHPUT_SAMPLE_SECONDS = 3;
