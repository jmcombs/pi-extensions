/**
 * Domain types shared by every layer of Steward.
 *
 * The server produces these, the browser consumes them, and the data source
 * (mock today, a live `llama-server` later) is the only thing that knows how
 * they were obtained. Keep this module free of Node and DOM APIs: it is
 * type-checked by both the Node project and the browser project.
 */

import type { DriftState } from "./drift.js";

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

/**
 * Whether a parallel slot is currently generating.
 *
 * `unknown` is a real answer, not a placeholder: occupancy is established from
 * the server's own log events, and a slot Steward has not yet seen an event for
 * — a child that spawned a moment ago, a stream that was interrupted, a
 * `release` that fell out of the buffer — is a slot whose state was never
 * measured. Reporting it as `idle` would be a guess, and a slot silently stuck
 * on `processing` because its `release` was missed is the exact failure this
 * value exists to prevent.
 */
export type SlotState = "processing" | "idle" | "unknown";

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
  /**
   * The actions this machine can actually perform: one entry per action that
   * `steward.json` declares a command for AND that the operator has consented
   * to. Config, not a reading — a machine with no control configured reports an
   * empty list, and the block shows a single setup affordance rather than
   * buttons that could not work.
   */
  controls: ServiceAction[];
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
  /**
   * Tokens the slot's context currently holds, or `null` when nothing has
   * reported it. The log states this at the end of a request (`release`'s
   * `n_tokens`) and, for a long prefill, while it runs — so a slot that has not
   * served a request since Steward started watching genuinely has no figure, and
   * `0` would claim an empty context we never measured.
   */
  promptTokens: number | null;
  /**
   * The slot's context length in tokens, or `null` when the model's launch
   * configuration does not state it. Structural, not a reading: it comes from
   * the model's `--ctx-size`/`meta.n_ctx`, which is fixed for the life of the
   * child process.
   */
  ctxTotal: number | null;
  /**
   * Tokens generated so far this turn, or `null` while unmeasured. llama.cpp
   * only prints a running `n_decoded` for a generation long enough to cross its
   * ~3 s reporting interval, so a short request has no count until it finishes.
   */
  decoded: number | null;
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

/**
 * What kind of record a line is, decided by the producer while it parses.
 *
 * `proxy` and `args` exist because the console suppresses or folds them by
 * default and has to be able to say honestly what it is not showing; `rate`
 * exists so a future suppression needs no parser change. Nothing is ever
 * dropped for its kind — classification is tagging, so every filter the console
 * builds on it stays reversible. Absent means `event`: an ordinary line, shown
 * as-is.
 *
 * - `proxy` — the router's `proxy_reques` lines. 86.9% of a real log, and most
 *   of them are Steward's own `/slots` + `/metrics` polls watching itself.
 * - `args` — the contiguous continuation run under `spawning … with args:`.
 *   Individually meaningless (`--ctx-size`, then `131072`), collectively the
 *   exact launch command line.
 * - `rate` — the ~3 s in-flight `n_decoded … tg = N t/s` generation line.
 */
export type LogKind = "event" | "proxy" | "args" | "rate";

/**
 * Which process wrote the line: `child` when the router prefixed it with
 * `[port]`, `router` otherwise. It is the only way to tell a router-wide line
 * (no model involved — render `router`) from a child line whose port has not
 * been mapped yet (model genuinely unknown — render `—`). Absent means the
 * source predates the field, and a null `modelId` is treated as router-wide.
 */
export type LogOrigin = "router" | "child";

/**
 * Operator-facing grouping of records — the console's `kind` chips.
 *
 * Deliberately four values, not the research's six: proxied requests already
 * have a purpose-built toggle and the launch-args block already has a fold, so
 * neither earns a chip. Absent means `other`.
 *
 * `other` is the drift alarm and needs no alarm built: a llama-server message
 * shape Steward has never seen lands there and stays visible, and a count that
 * starts climbing is the signal.
 */
export type LogFamily = "requests" | "models" | "startup" | "other";

/**
 * The `id %2d | task %d | ` frame that every `SLT_*` macro emits.
 *
 * One shared literal in llama.cpp's `server-common.h`, byte-identical from
 * b4500 (Jan 2025) through b10090 (Jul 2026) across two file moves — the
 * strongest structural guarantee the log offers, and the only one worth
 * relocating out of the message.
 */
export interface LogFrame {
  /** `(slot).id`, 0 .. n_parallel-1. Always 0 on a `--parallel 1` server. */
  slot: number;
  /** `(slot).task->id`, or -1 where no task is attached yet (`get_available_slot`). */
  task: number;
  /**
   * The frame exactly as the file wrote it, INCLUDING the `slot print_timing: `
   * head it sits behind, so `raw + message` re-forms the line byte for byte.
   * That is the guarantee that makes the relocation a relocation rather than a
   * rewrite: Copy and Download reproduce the file, not a reassembly of it.
   */
  raw: string;
}

/** One line of the server log. */
export interface LogLine {
  /** Monotonic per-source sequence number; also the render key. */
  seq: number;
  /**
   * Which log SOURCE produced this line — bumped whenever the server starts
   * reading a different one, and absent from a source that can never change.
   *
   * {@link seq} is monotonic per source and NOTHING else: two sources number
   * their lines independently, and the file tailer reads a backlog window the
   * moment it opens, so a replacement's counter is already in the thousands
   * before it delivers anything. Comparing numbers across that boundary is
   * meaningless in both directions — a higher one reads as "newer" and gets
   * appended, so a console would silently concatenate two different logs under
   * one buffer; a lower one reads as a restart. This field is what makes the
   * boundary legible: a batch that carries a different generation than the
   * buffer replaces it, whatever the sequence numbers say.
   */
  gen?: number;
  /** Epoch ms. Formatted as `HH:MM:SS.mmm` at render time. */
  ts: number;
  level: LogLevel;
  /** Model the line was attributed to, or `null` when it is not slot traffic. */
  modelId: string | null;
  /**
   * Everything after {@link LogFrame.raw} when the line was framed, and the
   * whole text after the level letter when it was not. Always a verbatim SUFFIX
   * of the line as the file wrote it — nothing is paraphrased, reordered or
   * dropped.
   */
  message: string;
  /** What class of record this is; absent means {@link LogKind} `event`. */
  kind?: LogKind;
  /** Which process wrote it; absent means the source does not report it. */
  origin?: LogOrigin;
  /**
   * The `[port]` prefix's port. HALF THE TRACE KEY: task ids are a per-process
   * counter from 0, so task `0` appears under 8 different ports in a single
   * measured corpus. A trace keyed on the id alone would be a real,
   * user-visible bug — it would show one request's lines mixed with another
   * model's.
   */
  port?: number;
  /**
   * The pipe frame, when the line carried one. When absent, {@link message} is
   * the whole text after the level letter, exactly as before this existed, and
   * the task cell is empty — which is the whole degradation path.
   */
  frame?: LogFrame;
  /** Which chip the line answers to; absent means {@link LogFamily} `other`. */
  family?: LogFamily;
  /**
   * `truncated = 1` on a release line: this request's reply was written from a
   * context a shift had already cut the front off. Absent means the line did
   * not say so — never that it said no.
   */
  contextLost?: boolean;
  /** `sim_best` — the fraction of the prompt already in KV cache, 0–1. */
  cacheHit?: number;
}

/**
 * Whether a log source is connected, and — when it is not — which way it
 * failed. `unavailable` means no source was ever discovered (nothing to watch);
 * `missing` means a path IS being watched and the file is not there right now,
 * which on macOS is routinely `com.apple.tmp_cleaner` unlinking a `/tmp` log
 * that went three days untouched. The second is self-healing and must not be
 * reported as the first.
 */
export type LogSourceState = "ok" | "unavailable" | "missing";

/** The health of the log source itself, alongside the line stream. */
export interface LogStreamStatus {
  source: LogSourceState;
  /** The path being watched, so the console can name the file it is missing. */
  path: string | null;
  /** A readable reason when the source is not `ok`, else `null`. */
  detail: string | null;
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
  /**
   * Whether this machine still matches what `steward.json` says about it: the
   * live launch argv against the recorded one, and any command declared but not
   * approved. Always present, because "we did not check" ({@link
   * import("./drift.js").LaunchDrift} `unknown`) is a distinct answer from "we
   * checked and it matches" — and only the first of those is honest when the
   * check could not run.
   */
  drift: DriftState;
  /**
   * Tokens generated per second of wall clock over {@link
   * throughputWindowSeconds}, across all slots — or `null` when no window has
   * been measured.
   *
   * This is throughput in the ordinary sense: what the server produced, divided
   * by the time it had to produce it. It is NOT the speed of whatever request is
   * running at this instant, and on a real box the two are nowhere near each
   * other, because most of the wall clock has no request in it at all. A model's
   * own live speed is still reported per model, on the model that is generating
   * — see {@link ModelInfo.tokensPerSecond} — because "how fast is this request
   * going" is a real question; it is just not one a box-wide tile can answer for
   * a box that is idle nine seconds in ten.
   *
   * Reporting the instant instead was tried and is what this replaced. llama.cpp
   * prints a live rate only once a generation passes 100 tokens AND ~3 s, and on
   * a measured 16,517-request corpus 99.4% of requests never reached that, so
   * the only rate they ever produced was the one on the `eval time` line their
   * `release` follows 17 microseconds later. Sampled every 1.6 s, that tile read
   * `0` while idle and `—` while busy and never once read the truth.
   *
   * `0` is a measurement — the window elapsed and nothing was generated in it.
   * `null` is the absence of one: no window has closed yet, or the event stream
   * broke and the span that window would cover cannot be vouched for.
   */
  throughputTps: number | null;
  /**
   * The wall clock {@link throughputTps} and {@link throughputHistory} cover, in
   * seconds — the span the strip is showing, which grows to ~2 minutes and then
   * rolls.
   *
   * `null` when the figure is not a window measurement at all: a Steward with no
   * log source cannot count tokens and samples llama.cpp's own rate gauge
   * instead, and the mock invents a series outright. The tile reads this to know
   * which claim it is allowed to print beside the number.
   */
  throughputWindowSeconds: number | null;
  /**
   * Requests being processed across all slots right now, or `null` when any
   * slot's occupancy is {@link SlotState} `unknown` and the true count can only
   * be bounded below. llama.cpp exposes no request-rate metric, so the requests
   * tile reports this live count (and {@link requestsQueued}) rather than a
   * per-minute rate it cannot measure.
   */
  requestsInFlight: number | null;
  /**
   * Rolling tok/s samples, oldest first. 42 samples ≈ 2 minutes.
   *
   * Each sample is its own span's tokens over its own span's wall clock, so a
   * sample of `0` says the server generated nothing in those ~3 seconds — a
   * measurement, and the shape of intermittent traffic is exactly what makes the
   * strip worth drawing. An empty array means no span can be vouched for yet,
   * which is what the strip shows after a restart or a break in the log.
   *
   * On a Steward with no log source the samples are gauge readings instead, and
   * only measured ones are appended: a tick that could not be read contributes
   * no sample rather than a fabricated `0`. {@link throughputWindowSeconds} is
   * `null` there, and the axis is the only thing claiming a span.
   */
  throughputHistory: number[];
  /**
   * Requests accepted but waiting for a free slot, or `null` when nothing can
   * report it. The server's log says when a slot is taken and released but never
   * mentions the queue behind it, so a Steward reading occupancy from the log —
   * which is every Steward with a log source — has no honest figure here. It is
   * `null` there, and a number only when the `/metrics` scrape supplied one.
   */
  requestsQueued: number | null;
  config: ConfigEntry[];
}

/** Number of samples in {@link Snapshot.throughputHistory}. */
export const THROUGHPUT_HISTORY_SIZE = 42;

/** Seconds between throughput samples, matching the metrics poll. */
export const THROUGHPUT_SAMPLE_SECONDS = 3;
