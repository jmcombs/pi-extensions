/**
 * The source Steward uses when it has nothing to read.
 *
 * This replaces the simulated source the dashboard used to fall back on. That
 * fallback was a liability: a machine with no `steward.json`, or one whose
 * `llama-server` could not be reached, rendered a complete, plausible, moving
 * dashboard made entirely of invented numbers — indistinguishable from the real
 * thing. It was observed serving three "loaded" models on a machine whose router
 * had ten models and none loaded.
 *
 * Nothing here invents a reading. Every gauge is `NaN` (which the UI renders as
 * a no-reading track, never a zero), every list is empty, drift is `unknown`
 * with a reason, and the service reports itself not running with no controls.
 * The panels go blank and say so, which is the only honest thing a dashboard can
 * do about a machine it cannot see.
 *
 * Keep this module free of Node and DOM APIs — see `./types.ts`.
 */

import { unknownDrift } from "./drift.js";
import type { LogAttachment, StewardDataSource, Unsubscribe } from "./source.js";
import type { HostMetrics, LogLine, ModelAction, ServiceAction, Snapshot } from "./types.js";

/** Why the dashboard has nothing to show, in the operator's vocabulary. */
export const NOT_CONNECTED_REASON =
  "Steward is not connected to this machine — run /steward_initialize";

/**
 * Every gauge as a no-reading. `NaN` is deliberate and load-bearing: the UI
 * distinguishes it from `0`, so an unmeasured host reads as blank rather than as
 * an idle one.
 */
function noReadings(): HostMetrics {
  return {
    vramUsedGB: Number.NaN,
    vramTotalGB: Number.NaN,
    ramUsedGB: Number.NaN,
    ramTotalGB: Number.NaN,
    gpuUtil: Number.NaN,
    cpuUtil: Number.NaN,
    gpuTempC: null,
    cpuTempC: null,
  };
}

/**
 * A complete Snapshot that asserts nothing. `now` is the caller's clock so the
 * dashboard's own staleness logic still works; everything else is absent.
 */
export function disconnectedSnapshot(now: number): Snapshot {
  return {
    now,
    service: {
      running: false,
      startedAt: null,
      pid: null,
      host: "",
      port: 0,
      build: "",
      controls: [],
    },
    models: [],
    slots: [],
    metrics: noReadings(),
    memoryTopology: "unified",
    drift: unknownDrift(NOT_CONNECTED_REASON),
    throughputTps: null,
    throughputWindowSeconds: null,
    requestsInFlight: null,
    throughputHistory: [],
    requestsQueued: null,
    config: [],
  };
}

/** A source with no machine behind it. Every read is empty; every write refuses. */
export function createDisconnectedSource(): StewardDataSource {
  return {
    name: "disconnected",

    async snapshot(): Promise<Snapshot> {
      return disconnectedSnapshot(Date.now());
    },

    recentLogs(): LogLine[] {
      return [];
    },

    subscribeLogs(): Unsubscribe {
      // Nothing will ever arrive, but the contract is a working unsubscribe.
      return () => {};
    },

    attachLogs(): LogAttachment {
      return { backlog: [], unsubscribe: () => {} };
    },

    // Refusing beats resolving: a caller that thinks a start succeeded here
    // would poll forever for a service that was never asked to do anything.
    async setService(action: ServiceAction): Promise<void> {
      throw new Error(`cannot ${action} — ${NOT_CONNECTED_REASON}`);
    },

    async setModel(modelId: string, action: ModelAction): Promise<void> {
      throw new Error(`cannot ${action} ${modelId} — ${NOT_CONNECTED_REASON}`);
    },

    close(): void {},
  };
}
