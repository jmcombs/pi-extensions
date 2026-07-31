/**
 * A test stub that stands in for a data source. Test-only: `__fixtures__` is
 * excluded from the published package.
 *
 * This replaces a 1068-line simulation of `llama-server` that used to back the
 * server and wiring tests. That simulation was a liability twice over. It
 * shipped to npm and silently became the dashboard's fallback, so a machine it
 * could not read rendered invented numbers. And as a test subject it was
 * circular: asserting that a simulator produces the values it was written to
 * produce proves nothing about llama.cpp, and encoded our guesses about that
 * server as if they were facts.
 *
 * The rule this file follows: **test against captured reality or pure logic,
 * never against a simulator of a system we do not control.** Real `/slots`,
 * `/props` and `/v1/models` bodies live in `core/__fixtures__/llama/`; this stub
 * models nothing at all. It emits lines a test asks for and returns an empty
 * snapshot, because the subject of the tests that use it is our HTTP server and
 * our config wiring — not the shape of anyone's inference server.
 */

import { disconnectedSnapshot } from "../disconnected-source.js";
import type { LogAttachment, StewardDataSource, Unsubscribe } from "../source.js";
import type { LogLine, ModelAction, ServiceAction, Snapshot } from "../types.js";

/** A source that only moves when a test moves it. */
export interface StubSource extends StewardDataSource {
  attachLogs(listener: (line: LogLine) => void, limit: number): LogAttachment;
  /** Emits exactly one line. Deterministic: the seq is the only thing that moves. */
  tickLogs(): void;
  /** Every line emitted so far, for assertions about ordering and buffering. */
  readonly emitted: LogLine[];
}

export interface StubSourceOptions {
  /** Lines generated up front, so a client that connects first sees scrollback. */
  seedLines?: number;
  /** Clock, in epoch ms. A function so callers can pin or advance it. */
  now?: () => number;
  /** Ring-buffer cap, matching whatever the caller wants to exercise. */
  maxLogLines?: number;
}

const FIXED_NOW = 1_760_000_000_000;

export function createStubSource(options: StubSourceOptions = {}): StubSource {
  const now = options.now ?? (() => FIXED_NOW);
  const maxLogLines = options.maxLogLines ?? 500;
  const buffer: LogLine[] = [];
  const listeners = new Set<(line: LogLine) => void>();
  let seq = 0;

  function makeLine(): LogLine {
    seq += 1;
    return { seq, ts: now(), level: "INFO", modelId: null, message: `line ${seq}` };
  }

  function emit(): void {
    const line = makeLine();
    buffer.push(line);
    if (buffer.length > maxLogLines) buffer.shift();
    for (const listener of listeners) listener(line);
  }

  for (let i = 0; i < (options.seedLines ?? 0); i += 1) emit();

  return {
    name: "stub",
    emitted: buffer,

    async snapshot(): Promise<Snapshot> {
      return disconnectedSnapshot(now());
    },

    recentLogs(limit: number): LogLine[] {
      return buffer.slice(-limit);
    },

    subscribeLogs(listener: (line: LogLine) => void): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    attachLogs(listener: (line: LogLine) => void, limit: number): LogAttachment {
      const backlog = buffer.slice(-limit);
      listeners.add(listener);
      return { backlog, unsubscribe: () => listeners.delete(listener) };
    },

    tickLogs(): void {
      emit();
    },

    async setService(_action: ServiceAction): Promise<void> {},
    async setModel(_modelId: string, _action: ModelAction): Promise<void> {},
    close(): void {
      listeners.clear();
    },
  };
}
