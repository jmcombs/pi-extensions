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

import type { LogLine, LogStreamStatus, ModelAction, ServiceAction, Snapshot } from "./types.js";

/** Unsubscribes a log listener. Safe to call more than once. */
export type Unsubscribe = () => void;

/** A backlog and a live subscription, opened together. See {@link StewardDataSource.attachLogs}. */
export interface LogAttachment {
  /** The lines already buffered when the listener was registered, oldest first. */
  backlog: LogLine[];
  unsubscribe: Unsubscribe;
}

export interface StewardDataSource {
  /** Identifies the source in diagnostics, e.g. `mock` or `llama.cpp`. */
  readonly name: string;

  /** One complete read of current state. Called on every metrics poll. */
  snapshot(): Promise<Snapshot>;

  /**
   * The most recent lines the source has buffered, oldest first, so a client
   * that connects mid-run does not start with an empty console.
   *
   * Pairing this with {@link subscribeLogs} to open a stream is only safe if
   * nothing can run between the two calls — a line that arrives in that window
   * is in neither result. Prefer {@link attachLogs}.
   */
  recentLogs(limit: number): LogLine[];

  /**
   * Streams every subsequent line to `listener`. The source is responsible for
   * its own ring buffer; listeners receive lines as they arrive.
   */
  subscribeLogs(listener: (line: LogLine) => void): Unsubscribe;

  /**
   * Opens a console: the backlog and the live subscription in ONE step, so no
   * line can fall between them. This is the method a stream should use;
   * {@link recentLogs} and {@link subscribeLogs} remain for callers that want
   * only one half.
   *
   * Optional so a source that predates it still satisfies the seam — a caller
   * that does not find it must fall back to the two calls and keep them in the
   * same tick.
   */
  attachLogs?(listener: (line: LogLine) => void, limit: number): LogAttachment;

  /**
   * The health of the log source behind {@link subscribeLogs}, for a console
   * that has to tell "nothing is happening" apart from "nothing is connected"
   * and from "the file we watch was deleted". Optional: a source whose lines are
   * simulated has no file to report on, and a caller that does not find this
   * method should assume the stream is simply live.
   */
  logStatus?(): LogStreamStatus;

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
