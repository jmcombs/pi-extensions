/**
 * The data-source seam.
 *
 * Every fact the dashboard shows enters through a `StewardDataSource`, and
 * every action it takes leaves through one. The server owns the instance; the
 * browser never talks to `llama-server` directly. Swapping the mock source for
 * a live one is therefore a one-line change in the server and touches nothing
 * else.
 *
 * Keep this module free of Node and DOM APIs — see `./types.ts`.
 */

import type { LogLine, ModelAction, ServiceAction, Snapshot } from "./types.js";

/** Unsubscribes a log listener. Safe to call more than once. */
export type Unsubscribe = () => void;

export interface StewardDataSource {
  /** Identifies the source in diagnostics, e.g. `mock` or `llama.cpp`. */
  readonly name: string;

  /** One complete read of current state. Called on every metrics poll. */
  snapshot(): Promise<Snapshot>;

  /**
   * The most recent lines the source has buffered, oldest first, so a client
   * that connects mid-run does not start with an empty console.
   */
  recentLogs(limit: number): LogLine[];

  /**
   * Streams every subsequent line to `listener`. The source is responsible for
   * its own ring buffer; listeners receive lines as they arrive.
   */
  subscribeLogs(listener: (line: LogLine) => void): Unsubscribe;

  /**
   * Starts, stops, or restarts the service. Resolves once the source believes
   * the transition finished — callers re-poll {@link snapshot} rather than
   * assuming it succeeded.
   */
  setService(action: ServiceAction): Promise<void>;

  /**
   * Loads or unloads one model. Expected to be slow for large models; callers
   * show a pending state until it resolves.
   */
  setModel(modelId: string, action: ModelAction): Promise<void>;

  /** Releases timers, sockets, and file handles. */
  close(): void;
}
