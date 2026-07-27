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
  /** Context length, or `null` when unloaded (same reason as {@link sizeGB}). */
  ctx: number | null;
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
   * count. Known from the slot array once loaded; `null` when unloaded.
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
  /** Aggregate generation rate across all slots, tokens/second. */
  throughputTps: number;
  requestsPerMinute: number;
  /** Rolling tok/s samples, oldest first. 42 samples ≈ 2 minutes. */
  throughputHistory: number[];
  /** Distinct client sessions attached, for the requests tile sub-line. */
  sessions: number;
  config: ConfigEntry[];
}

/** Number of samples in {@link Snapshot.throughputHistory}. */
export const THROUGHPUT_HISTORY_SIZE = 42;

/** Seconds between throughput samples, matching the metrics poll. */
export const THROUGHPUT_SAMPLE_SECONDS = 3;
