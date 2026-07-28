/**
 * A {@link StewardDataSource} that shows live CONFIG, MODELS and SLOTS over an
 * otherwise simulated dashboard, and performs load/unload for real.
 *
 * It is composite: it holds a `fallback` (the mock) and delegates the panels it
 * does not own yet — the host-metrics band, requests, throughput history, and the
 * log console — straight to it, overriding `config`, `service`, `models`, and
 * `slots` with what a real `llama-server` reports. This is a step in a gradual
 * mock→live migration; the remaining panels stay simulated until later phases.
 *
 * Reading the server must never throw or hang the dashboard: it is not always
 * up, and that is a state to show, not an error to crash on. Every failure —
 * connection refused, timeout, a 401, any non-2xx, a malformed body — degrades
 * that section honestly while the fallback keeps every other panel animating. A
 * per-model read that fails drops only that model's slots and rate, never the
 * whole snapshot.
 *
 * `setModel` is the exception: an operator action that fails is an error to
 * surface, so it rejects with a message rather than swallowing it. It does not
 * wait for the model to finish loading — the POST returns while the child is
 * still spawning, and the poll layer watches the status reach its terminal
 * value.
 *
 * Keep this module free of Node and DOM APIs: `fetch`, `AbortController`, and
 * `AbortSignal` are all cross-runtime globals.
 */

import type { HostMetricsProvider } from "./host-metrics.js";
import { parseRouterConfig } from "./llama-config.js";
import type { LlamaConnection } from "./llama-connection.js";
import { listenAddress } from "./llama-connection.js";
import { parseModels } from "./llama-models.js";
import { parseMetrics, parseSlots } from "./llama-slots.js";
import type { StewardDataSource, Unsubscribe } from "./source.js";
import {
  type ConfigEntry,
  type HostMetrics,
  type LogLine,
  type MemoryTopology,
  type ModelAction,
  type ModelInfo,
  type ServiceAction,
  type ServiceInfo,
  type SlotInfo,
  type Snapshot,
  THROUGHPUT_HISTORY_SIZE,
  THROUGHPUT_SAMPLE_SECONDS,
} from "./types.js";

/** The local process behind the server, for facts HTTP does not expose. */
export interface ServiceProcess {
  pid: number;
  /** Epoch ms the process started, or null when the probe cannot read it. */
  startedAt: number | null;
}

/**
 * Resolves the OS process listening on a host:port. Node-side and
 * platform-specific (it shells out), so it is injected rather than imported here
 * — this module stays free of Node APIs. Returns null when nothing is found.
 */
export type ServiceProbe = (host: string, port: number) => Promise<ServiceProcess | null>;

/**
 * The minimal HTTP surface Steward uses. The global `fetch` satisfies it, and a
 * test can supply a stub without standing up a server — narrower than the DOM
 * `fetch` type on purpose. `text()` is here for the Prometheus `/metrics` body.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>;

/**
 * The live host-metrics overlay: a collector to read the readings off, the
 * machine's static memory topology (from `steward.json`, it picks the gauge
 * SET), and the staleness horizon. Injected together and only when the operator
 * has configured AND consented to a collector; absent, the HOST band keeps
 * delegating to the fallback exactly as before.
 */
export interface HostMetricsOverlay {
  /** The running collector. Owned and closed by this source. */
  provider: HostMetricsProvider;
  /** Static machine memory layout, overlaid onto {@link Snapshot.memoryTopology}. */
  topology: MemoryTopology;
  /**
   * A sample whose arrival is older than this (typically `3 × intervalMs`) is
   * treated as unavailable: its readings are nulled rather than held, so the
   * band never shows a dimmed-old number — n/a is honest, a stale figure is not.
   */
  staleMs: number;
}

export interface LlamaSourceOptions {
  /** Where to read the server. */
  connection: LlamaConnection;
  /** The source every non-live fact comes from; owned and closed by this one. */
  fallback: StewardDataSource;
  /** HTTP transport. Defaults to the global `fetch`; injected in tests. */
  fetch?: FetchLike;
  /**
   * Resolves the OS process behind the connection, for the SERVICE panel's real
   * pid and uptime — facts llama-server does not report over HTTP. Injected
   * (it is Node-side and platform-specific); omitted, pid and uptime read n/a
   * while the live/stopped state still comes through.
   */
  probeService?: ServiceProbe;
  /**
   * The live host-metrics collector and its topology. Omitted, the HOST band
   * (memory topology and sensors) rides through from the fallback unchanged.
   */
  host?: HostMetricsOverlay;
}

/** How long to wait on any one call before treating the server as unreachable. */
const CALL_TIMEOUT_MS = 4000;

/**
 * The cadence at which a throughput sample is appended to the rolling history.
 * llama.cpp reports an instantaneous rate, not a series, so Steward accumulates
 * one, at the same cadence the mock uses so the sparkline's two-minute axis is
 * true. Gating on the snapshot clock (not the call count) keeps the window at
 * that span regardless of how many clients are polling.
 */
const THROUGHPUT_SAMPLE_MS = THROUGHPUT_SAMPLE_SECONDS * 1000;

export class LlamaSource implements StewardDataSource {
  readonly name = "llama.cpp";

  readonly #connection: LlamaConnection;
  readonly #fallback: StewardDataSource;
  readonly #fetch: FetchLike;
  readonly #probeService: ServiceProbe | null;
  /** The live host-metrics overlay, or null when no collector is configured. */
  readonly #host: HostMetricsOverlay | null;
  /** In-flight reads and actions, aborted on {@link close}. */
  readonly #inFlight = new Set<AbortController>();
  /** Rolling real throughput samples, oldest first — the band's sparkline. */
  readonly #throughputHistory: number[] = [];
  /** Snapshot clock at the last history sample, so sampling stays time-paced. */
  #lastSampleAt = 0;

  constructor(options: LlamaSourceOptions) {
    this.#connection = options.connection;
    this.#fallback = options.fallback;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#probeService = options.probeService ?? null;
    this.#host = options.host ?? null;
  }

  async snapshot(): Promise<Snapshot> {
    // The fallback owns every panel we have not moved yet and is the dashboard's
    // data spine. The live reads are fully guarded and never reject, so they can
    // only ever add the overlay — never be the reason a repaint fails. Config
    // and the model list are independent, so fetch them alongside the fallback
    // rather than serialising. (A fallback that itself fails is the spine
    // failing; the server turns that into a 5xx and the client retries, which
    // beats painting invented panels over a dead source.)
    const [base, props, modelsRaw] = await Promise.all([
      this.#fallback.snapshot(),
      this.#readProps(),
      this.#getJson("/models"),
    ]);

    const config = this.#configFromProps(props);
    const service = await this.#serviceFromProps(props);
    const { models, slots, throughputTps, requestsInFlight, requestsQueued } =
      await this.#readModelsAndSlots(modelsRaw);
    const throughputHistory = this.#sampleThroughput(base.now, throughputTps);
    // When a collector is configured, the HOST band is live: its topology comes
    // from `steward.json` and its readings from the collector's latest sample.
    // With no collector, the band — including `memoryTopology` — rides through
    // from the fallback via `...base`, exactly as before.
    const host = this.#overlayHost(base);
    return {
      ...base,
      config,
      service,
      models,
      slots,
      throughputTps,
      throughputHistory,
      requestsInFlight,
      requestsQueued,
      ...host,
    };
  }

  /**
   * The live HOST band, or an empty overlay (`{}`) when no collector is
   * configured — leaving the fallback's `metrics` and `memoryTopology` in place.
   *
   * With a collector: `memoryTopology` is the machine's static config, and the
   * sensors are the latest validated sample. A sample older than the staleness
   * horizon, or no sample yet, nulls every reading (`NaN` for the always-present
   * figures, `null` for temperatures) so Phase 1's dashed/hatched gauges show it
   * honestly — a held-stale number is never shown.
   */
  #overlayHost(base: Snapshot): Partial<Snapshot> {
    if (this.#host === null) return {};
    const sample = this.#host.provider.latest();
    const fresh = sample !== null && base.now - sample.receivedAt <= this.#host.staleMs;
    const metrics: HostMetrics = fresh
      ? {
          vramUsedGB: finiteOr(sample.reading.vramUsedGB, Number.NaN),
          vramTotalGB: finiteOr(sample.reading.vramTotalGB, Number.NaN),
          ramUsedGB: finiteOr(sample.reading.ramUsedGB, Number.NaN),
          ramTotalGB: finiteOr(sample.reading.ramTotalGB, Number.NaN),
          gpuUtil: finiteOr(sample.reading.gpuUtil, Number.NaN),
          cpuUtil: finiteOr(sample.reading.cpuUtil, Number.NaN),
          gpuTempC: sample.reading.gpuTempC,
          cpuTempC: sample.reading.cpuTempC,
        }
      : UNAVAILABLE_METRICS;
    return { metrics, memoryTopology: this.#host.topology };
  }

  /**
   * Appends the current throughput to the rolling history, but only once per
   * {@link THROUGHPUT_SAMPLE_MS} of snapshot time, so the window spans a fixed
   * ~2 minutes no matter how often (or from how many clients) snapshots are
   * taken. Returns a copy so a consumer cannot mutate the live buffer.
   */
  #sampleThroughput(now: number, throughputTps: number): number[] {
    if (now - this.#lastSampleAt >= THROUGHPUT_SAMPLE_MS) {
      this.#lastSampleAt = now;
      this.#throughputHistory.push(throughputTps);
      while (this.#throughputHistory.length > THROUGHPUT_HISTORY_SIZE) {
        this.#throughputHistory.shift();
      }
    }
    return [...this.#throughputHistory];
  }

  recentLogs(limit: number): LogLine[] {
    return this.#fallback.recentLogs(limit);
  }

  subscribeLogs(listener: (line: LogLine) => void): Unsubscribe {
    return this.#fallback.subscribeLogs(listener);
  }

  setService(action: ServiceAction): Promise<void> {
    return this.#fallback.setService(action);
  }

  /**
   * Loads or unloads a model on the router. Resolves once the server accepts the
   * request (`{"success":true}`), which is *before* a load has finished — the
   * caller polls {@link snapshot} for the status to reach its terminal value.
   * Rejects with a readable message on any non-2xx, surfacing a 404 for an
   * unknown id, so the UI can notify the operator.
   */
  async setModel(modelId: string, action: ModelAction): Promise<void> {
    const path = action === "load" ? "/models/load" : "/models/unload";
    const controller = new AbortController();
    this.#inFlight.add(controller);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
      const response = await this.#fetch(`${this.#connection.baseUrl}${path}`, {
        method: "POST",
        headers: { ...this.#authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId }),
        signal,
      });

      if (!response.ok) {
        throw new Error(`${action} failed: HTTP ${response.status}`);
      }
      const body = await response.json();
      if (!(isRecord(body) && body.success === true)) {
        throw new Error(`${action} failed: llama.cpp did not confirm`);
      }
    } finally {
      this.#inFlight.delete(controller);
    }
  }

  close(): void {
    for (const controller of this.#inFlight) controller.abort();
    this.#inFlight.clear();
    this.#host?.provider.close();
    this.#fallback.close();
  }

  /** The bearer header, present only when the connection carries a key. */
  #authHeaders(): Record<string, string> {
    return this.#connection.apiKey === ""
      ? {}
      : { Authorization: `Bearer ${this.#connection.apiKey}` };
  }

  /**
   * A guarded JSON GET: the parsed body, or `undefined` on any failure (non-2xx,
   * timeout, refused connection, unreadable body). Callers turn `undefined` into
   * a degraded section rather than a thrown error.
   */
  async #getJson(path: string): Promise<unknown | undefined> {
    const controller = new AbortController();
    this.#inFlight.add(controller);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
      const response = await this.#fetch(`${this.#connection.baseUrl}${path}`, {
        headers: this.#authHeaders(),
        signal,
      });
      if (!response.ok) return undefined;
      return await response.json();
    } catch {
      return undefined;
    } finally {
      this.#inFlight.delete(controller);
    }
  }

  /** A guarded text GET, for the Prometheus `/metrics` scrape. */
  async #getText(path: string): Promise<string | undefined> {
    const controller = new AbortController();
    this.#inFlight.add(controller);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
      const response = await this.#fetch(`${this.#connection.baseUrl}${path}`, {
        headers: this.#authHeaders(),
        signal,
      });
      if (!response.ok) return undefined;
      return await response.text();
    } catch {
      return undefined;
    } finally {
      this.#inFlight.delete(controller);
    }
  }

  /**
   * The live `models` and flat `slots` for one snapshot. Each loaded model gets
   * its `/slots` and `/metrics` read concurrently; a model with a busy slot is
   * upgraded to `active` and given its rate. A failure to read `/models` yields
   * empty lists (an honest "nothing to show", not the mock's invented models),
   * and a per-model read that fails drops only that model's slots and rate.
   */
  async #readModelsAndSlots(modelsRaw: unknown): Promise<{
    models: ModelInfo[];
    slots: SlotInfo[];
    throughputTps: number;
    requestsInFlight: number;
    requestsQueued: number;
  }> {
    const parsed = parseModels(modelsRaw);

    const enriched = await Promise.all(
      parsed.map(async (model): Promise<EnrichedModel> => {
        // Only a resident model has slots to read; loading/downloading/unloaded
        // models have none yet, so we do not probe for them.
        if (model.status !== "resident") {
          return { model, slots: [], tps: 0, processing: 0, deferred: 0 };
        }

        const [slotsRaw, metricsText] = await Promise.all([
          this.#getJson(`/slots?model=${encodeURIComponent(model.id)}`),
          this.#getText(`/metrics?model=${encodeURIComponent(model.id)}`),
        ]);

        // A dropped per-model read leaves the model resident with no slots
        // rather than removing it from the list entirely.
        if (slotsRaw === undefined) {
          return { model, slots: [], tps: 0, processing: 0, deferred: 0 };
        }

        const slots = parseSlots(slotsRaw, model.id);
        const busy = slots.some((slot) => slot.state === "processing");
        const metrics = metricsText === undefined ? null : parseMetrics(metricsText);

        return {
          model: {
            ...model,
            status: busy ? "active" : "resident",
            parallel: slots.length,
            tokensPerSecond: busy ? (metrics?.tps ?? null) : null,
          },
          slots,
          // llama.cpp's rate gauge persists its last value after generation
          // ends, so a model only contributes to throughput while it is
          // actually processing — an idle model reads 0, not a stale average.
          tps: busy ? (metrics?.tps ?? 0) : 0,
          // Request gauges are live counts, taken as-is from every resident
          // model and summed for the band's requests tile.
          processing: metrics?.requestsProcessing ?? 0,
          deferred: metrics?.requestsDeferred ?? 0,
        };
      }),
    );

    return {
      models: enriched.map((entry) => entry.model),
      slots: enriched.flatMap((entry) => entry.slots),
      throughputTps: enriched.reduce((sum, entry) => sum + entry.tps, 0),
      requestsInFlight: enriched.reduce((sum, entry) => sum + entry.processing, 0),
      requestsQueued: enriched.reduce((sum, entry) => sum + entry.deferred, 0),
    };
  }

  /**
   * One guarded `/props` read, shared by CONFIG and SERVICE so the server is hit
   * once per snapshot. `status` is 0 when the server could not be reached at all
   * (refused, timeout, an aborted close) — distinct from an HTTP error it did
   * answer with. `body` is the parsed props only on a 2xx.
   */
  async #readProps(): Promise<PropsRead> {
    const controller = new AbortController();
    this.#inFlight.add(controller);
    try {
      // A dead server must not stall the metrics poll, so the read is bounded
      // by a timeout as well as by close().
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
      const response = await this.#fetch(`${this.#connection.baseUrl}/props`, {
        headers: this.#authHeaders(),
        signal,
      });
      const body = response.ok ? await response.json() : null;
      return { status: response.status, body };
    } catch {
      return { status: 0, body: null };
    } finally {
      this.#inFlight.delete(controller);
    }
  }

  /**
   * The live CONFIG rows, or a degraded block that always keeps the address in
   * view. Never throws: every failure mode maps to an honest status row.
   */
  #configFromProps(read: PropsRead): ConfigEntry[] {
    const address = listenAddress(this.#connection.baseUrl);
    if (read.status === 401) {
      return [
        { key: "status", value: "API key required — run /login llama.cpp" },
        { key: "address", value: address },
      ];
    }
    if (read.status === 0) {
      // Refused, timed out, or an aborted close — we could not reach it.
      return [
        { key: "status", value: "llama.cpp not reachable" },
        { key: "address", value: address },
      ];
    }
    if (read.body === null) {
      return [
        { key: "status", value: `llama.cpp error (HTTP ${read.status})` },
        { key: "address", value: address },
      ];
    }
    return parseRouterConfig(read.body, this.#connection.baseUrl);
  }

  /**
   * The real SERVICE panel. `running` is a live reachability check — a 2xx to
   * `/props`, not the mock's standing "true" — so a stopped server reads
   * stopped. pid and uptime have no HTTP source, so they come from the injected
   * process probe while the server is up, and read n/a when it is absent or
   * finds nothing.
   */
  async #serviceFromProps(read: PropsRead): Promise<ServiceInfo> {
    const { host, port } = splitHostPort(this.#connection.baseUrl);
    const running = read.status >= 200 && read.status < 300;
    if (!running) {
      return { running: false, startedAt: null, pid: null, host, port, build: "" };
    }
    const build =
      isRecord(read.body) && typeof read.body.build_info === "string" ? read.body.build_info : "";
    const process = this.#probeService === null ? null : await this.#safeProbe(host, port);
    return {
      running: true,
      startedAt: process?.startedAt ?? null,
      pid: process?.pid ?? null,
      host,
      port,
      build,
    };
  }

  /** The injected probe, guarded: a probe that throws yields no pid or uptime. */
  async #safeProbe(host: string, port: number): Promise<ServiceProcess | null> {
    if (this.#probeService === null) return null;
    try {
      return await this.#probeService(host, port);
    } catch {
      return null;
    }
  }
}

/** The outcome of one `/props` read: `status` 0 means the server was unreachable. */
interface PropsRead {
  status: number;
  body: unknown | null;
}

/** One model after its live `/slots` and `/metrics` reads, before aggregation. */
interface EnrichedModel {
  model: ModelInfo;
  slots: SlotInfo[];
  /** This model's throughput contribution (0 unless a slot is processing). */
  tps: number;
  /** Requests this model's instance is processing. */
  processing: number;
  /** Requests this model's instance has deferred. */
  deferred: number;
}

/** Splits the connection's base URL into a host and a numeric port. */
function splitHostPort(baseUrl: string): { host: string; port: number } {
  try {
    const url = new URL(baseUrl);
    const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return { host: url.hostname, port };
  } catch {
    return { host: baseUrl, port: 0 };
  }
}

/** True for a non-null object we can read string-keyed fields off. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The reading if it is a real value, else the given fallback (`NaN` for a no-reading gauge). */
function finiteOr(value: number | null, fallback: number): number {
  return value === null ? fallback : value;
}

/**
 * The HOST sensors when the collector has no fresh sample: every figure is a
 * non-reading, so Phase 1's gauges dash/hatch rather than plot a fabricated 0.
 */
const UNAVAILABLE_METRICS: HostMetrics = {
  vramUsedGB: Number.NaN,
  vramTotalGB: Number.NaN,
  ramUsedGB: Number.NaN,
  ramTotalGB: Number.NaN,
  gpuUtil: Number.NaN,
  cpuUtil: Number.NaN,
  gpuTempC: null,
  cpuTempC: null,
};
