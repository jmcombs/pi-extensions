/**
 * A {@link StewardDataSource} that shows a live CONFIG block over an otherwise
 * simulated dashboard.
 *
 * It is composite: it holds a `fallback` (the mock) and delegates everything —
 * logs, service and model actions, close — straight to it, overriding only the
 * `config` section of each snapshot with what a real `llama-server` reports at
 * `/props`. This is the first section of a gradual mock→live migration; the rest
 * of the snapshot stays simulated until later phases move it too.
 *
 * Reading `/props` must never throw or hang the dashboard: the service is not
 * always up, and that is a state to show, not an error to crash on. Every
 * failure — connection refused, timeout, a 401, any other non-2xx, a malformed
 * body — degrades to a small honest CONFIG block that still names where we were
 * looking, while the fallback keeps every other panel animating.
 *
 * Keep this module free of Node and DOM APIs: `fetch`, `AbortController`, and
 * `AbortSignal` are all cross-runtime globals.
 */

import { parseRouterConfig } from "./llama-config.js";
import type { LlamaConnection } from "./llama-connection.js";
import { listenAddress } from "./llama-connection.js";
import type { StewardDataSource, Unsubscribe } from "./source.js";
import type { ConfigEntry, LogLine, ModelAction, ServiceAction, Snapshot } from "./types.js";

/**
 * The minimal HTTP surface Steward uses. The global `fetch` satisfies it, and a
 * test can supply a stub without standing up a server — narrower than the DOM
 * `fetch` type on purpose.
 */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

export interface LlamaConfigSourceOptions {
  /** Where to read `/props`. */
  connection: LlamaConnection;
  /** The source every non-CONFIG fact comes from; owned and closed by this one. */
  fallback: StewardDataSource;
  /** HTTP transport. Defaults to the global `fetch`; injected in tests. */
  fetch?: FetchLike;
}

/** How long to wait on `/props` before treating the server as unreachable. */
const PROPS_TIMEOUT_MS = 4000;

export class LlamaConfigSource implements StewardDataSource {
  readonly name = "llama.cpp";

  readonly #connection: LlamaConnection;
  readonly #fallback: StewardDataSource;
  readonly #fetch: FetchLike;
  /** In-flight `/props` reads, aborted on {@link close}. */
  readonly #inFlight = new Set<AbortController>();

  constructor(options: LlamaConfigSourceOptions) {
    this.#connection = options.connection;
    this.#fallback = options.fallback;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async snapshot(): Promise<Snapshot> {
    // The fallback owns every panel but CONFIG and is the dashboard's data
    // spine. The live CONFIG read is fully guarded and never rejects, so it can
    // only ever add the overlay — never be the reason a repaint fails. The two
    // are independent, so run them together rather than serialising the live
    // fetch behind the fallback. (A fallback that itself fails is the spine
    // failing; the server turns that into a 503/500 and the client retries,
    // which beats painting invented models over a dead source.)
    const [base, config] = await Promise.all([this.#fallback.snapshot(), this.#readConfig()]);
    return { ...base, config };
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

  setModel(modelId: string, action: ModelAction): Promise<void> {
    return this.#fallback.setModel(modelId, action);
  }

  close(): void {
    for (const controller of this.#inFlight) controller.abort();
    this.#inFlight.clear();
    this.#fallback.close();
  }

  /**
   * The live CONFIG rows, or a degraded block that always keeps `listen` in
   * view. Never throws: every failure mode maps to an honest status row.
   */
  async #readConfig(): Promise<ConfigEntry[]> {
    const listen = listenAddress(this.#connection.baseUrl);
    const controller = new AbortController();
    this.#inFlight.add(controller);
    try {
      // A dead server must not stall the metrics poll, so the read is bounded
      // by a timeout as well as by close().
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(PROPS_TIMEOUT_MS)]);
      const headers: Record<string, string> = {};
      if (this.#connection.apiKey !== "") {
        headers.Authorization = `Bearer ${this.#connection.apiKey}`;
      }

      const response = await this.#fetch(`${this.#connection.baseUrl}/props`, { headers, signal });
      if (response.status === 401) {
        return [
          { key: "status", value: "API key required — run /login llama.cpp" },
          { key: "listen", value: listen },
        ];
      }
      if (!response.ok) {
        return [
          { key: "status", value: `llama.cpp error (HTTP ${response.status})` },
          { key: "listen", value: listen },
        ];
      }

      const props = await response.json();
      return parseRouterConfig(props, this.#connection.baseUrl);
    } catch {
      // Connection refused, timeout, an aborted close, or an unreadable body:
      // all mean the same thing to the operator — we could not reach it.
      return [
        { key: "status", value: "llama.cpp not reachable" },
        { key: "listen", value: listen },
      ];
    } finally {
      this.#inFlight.delete(controller);
    }
  }
}
