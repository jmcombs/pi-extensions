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

import { parseRouterConfig } from "./llama-config.js";
import type { LlamaConnection } from "./llama-connection.js";
import { listenAddress } from "./llama-connection.js";
import { parseModels } from "./llama-models.js";
import { parseSlots, parseTps } from "./llama-slots.js";
import type { StewardDataSource, Unsubscribe } from "./source.js";
import type {
  ConfigEntry,
  LogLine,
  ModelAction,
  ModelInfo,
  ServiceAction,
  ServiceInfo,
  SlotInfo,
  Snapshot,
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
}

/** How long to wait on any one call before treating the server as unreachable. */
const CALL_TIMEOUT_MS = 4000;

export class LlamaSource implements StewardDataSource {
  readonly name = "llama.cpp";

  readonly #connection: LlamaConnection;
  readonly #fallback: StewardDataSource;
  readonly #fetch: FetchLike;
  readonly #probeService: ServiceProbe | null;
  /** In-flight reads and actions, aborted on {@link close}. */
  readonly #inFlight = new Set<AbortController>();

  constructor(options: LlamaSourceOptions) {
    this.#connection = options.connection;
    this.#fallback = options.fallback;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#probeService = options.probeService ?? null;
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
    const { models, slots } = await this.#readModelsAndSlots(modelsRaw);
    return { ...base, config, service, models, slots };
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
  async #readModelsAndSlots(
    modelsRaw: unknown,
  ): Promise<{ models: ModelInfo[]; slots: SlotInfo[] }> {
    const parsed = parseModels(modelsRaw);

    const enriched = await Promise.all(
      parsed.map(async (model): Promise<{ model: ModelInfo; slots: SlotInfo[] }> => {
        // Only a resident model has slots to read; loading/downloading/unloaded
        // models have none yet, so we do not probe for them.
        if (model.status !== "resident") return { model, slots: [] };

        const [slotsRaw, metricsText] = await Promise.all([
          this.#getJson(`/slots?model=${encodeURIComponent(model.id)}`),
          this.#getText(`/metrics?model=${encodeURIComponent(model.id)}`),
        ]);

        // A dropped per-model read leaves the model resident with no slots
        // rather than removing it from the list entirely.
        if (slotsRaw === undefined) return { model, slots: [] };

        const slots = parseSlots(slotsRaw, model.id);
        const processing = slots.some((slot) => slot.state === "processing");
        const tps = metricsText === undefined ? null : parseTps(metricsText);

        return {
          model: {
            ...model,
            status: processing ? "active" : "resident",
            parallel: slots.length,
            tokensPerSecond: processing ? tps : null,
          },
          slots,
        };
      }),
    );

    return {
      models: enriched.map((entry) => entry.model),
      slots: enriched.flatMap((entry) => entry.slots),
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
