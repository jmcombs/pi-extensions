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

/** What a model is kept resident for. Drives its color assignment. */
export type ModelRole = "chat" | "reason" | "fim" | "embed";

/** Lifecycle of a resident model, as shown on its card. */
export type ModelStatus = "active" | "resident" | "unloaded";

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
  /** Display name — the id with its quantisation suffix trimmed. */
  short: string;
  role: ModelRole;
  /** Quantisation label, e.g. `Q4_K_M`. */
  quant: string;
  sizeGB: number;
  ctx: number;
  /**
   * Layers offloaded to the GPU, or `null` for models where the figure does
   * not apply (embedding models report their pooling mode instead).
   */
  gpuLayers: number | null;
  /** Trailing detail for the card's meta line, e.g. `pooling mean`. */
  detail: string | null;
  status: ModelStatus;
  /** Generation rate while active, else `null`. */
  tokensPerSecond: number | null;
}

/** One parallel slot of the server (`--parallel`). */
export interface SlotInfo {
  id: number;
  /** Owning model, or `null` when the slot is free. */
  modelId: string | null;
  /** Who is holding the slot, e.g. `pi · edit-session`. */
  client: string;
  /** Context consumed, pre-formatted for display, e.g. `12.4k`. */
  ctxUsed: string;
  tokens: number;
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
