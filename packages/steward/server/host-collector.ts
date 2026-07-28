/**
 * The Node body behind {@link HostMetricsProvider}: it spawns the operator's
 * declared collector command and drains a persistent NDJSON stream from its
 * stdout, keeping the latest validated reading for the live source to overlay.
 *
 * This is the long-lived process that clears the per-poll-exec timeout blocker —
 * Steward spawns the collector once and reads it, rather than shelling out on
 * every snapshot. The hazards it guards against were all verified real on this
 * hardware (plan H1):
 *
 *   - It spawns `detached: true` and, on close, kills the whole PROCESS GROUP
 *     (`process.kill(-pid)`). A plain `child.kill()` orphans a collector that is
 *     itself a shell pipeline (`macmon | jq …`) — each respawn would leak one.
 *   - It reads stdout line-by-line and validates every line against the schema
 *     (see `core/host-metrics.ts`); malformed, oversized, or non-UTF8 lines are
 *     dropped, never turned into an all-`null` sample.
 *   - A producer that exits is respawned with exponential backoff, under a
 *     failure CAP so a command that cannot stay up (or a `jq` that block-buffers
 *     and never emits) fails honestly instead of fork-bombing. A spawn that does
 *     produce a valid sample resets the streak, so an occasional restart over a
 *     long healthy run never accretes toward the cap.
 *   - stderr is inherited (the operator's terminal), never treated as data.
 *
 * Node-only (spawns processes); injected into the otherwise Node-free
 * {@link LlamaSource}. Staleness is judged by the overlay, not here — this module
 * only stamps each sample's arrival time.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import {
  type HostMetricsProvider,
  type HostSample,
  parseHostMetricsLine,
} from "../core/host-metrics.js";

/** The child-spawn surface this module uses; injected in tests for observability. */
export type SpawnHostCollector = (command: string, args: string[]) => ChildProcess;

export interface HostCollectorOptions {
  /**
   * How many consecutive failed (re)starts to tolerate before giving up. A start
   * that yields at least one valid sample resets the count. Default 5.
   */
  maxRespawns?: number;
  /** First backoff after a failure, ms; doubles each further failure. Default 500. */
  minBackoffMs?: number;
  /** Ceiling for the backoff, ms. Default 5000. */
  maxBackoffMs?: number;
  /** Grace after SIGTERM before a SIGKILL escalation on close. Default 750. */
  killEscalationMs?: number;
  /** Arrival clock for each sample. Injected in tests; defaults to `Date.now`. */
  now?: () => number;
  /** The spawner. Injected in tests; defaults to a `detached` `node:child_process` spawn. */
  spawn?: SpawnHostCollector;
}

/**
 * Longest stdout line we will assemble. A producer emitting a newline-less flood
 * must never buffer without bound (Node's own line readers have no such cap), so
 * the splitter below discards a run that exceeds this and resyncs at the next
 * newline — memory stays bounded whatever the producer emits.
 */
const MAX_LINE_LENGTH = 64 * 1024;

/** Grace after SIGTERM before escalating to SIGKILL on a producer that ignores it. */
const KILL_ESCALATION_MS = 750;

const DEFAULT_MAX_RESPAWNS = 5;
const DEFAULT_MIN_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 5000;

/** Feeds decoded stdout chunks in; hands complete, within-cap lines out. */
export interface LineSplitter {
  push(chunk: string): void;
}

/**
 * A bounded NDJSON line splitter. It accumulates decoded chunks and emits each
 * complete line (a trailing `\r` stripped, for CRLF producers) to `onLine`,
 * reassembling lines split across chunks. Crucially, it NEVER holds more than
 * `maxLineLength` of a single unterminated line: once the bytes since the last
 * newline exceed the cap it discards the buffer and enters a resync — dropping
 * everything until the next newline — so an unterminated flood cannot grow
 * memory without bound. An over-cap line that does eventually terminate is
 * dropped whole; the following line parses normally.
 */
export function createLineSplitter(
  maxLineLength: number,
  onLine: (line: string) => void,
): LineSplitter {
  // Bytes accumulated since the last newline, always ≤ maxLineLength.
  let pending = "";
  // True while discarding the tail of an over-cap run, until the next newline.
  let overflowed = false;

  return {
    push(chunk: string): void {
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf("\n", start);
        if (newline === -1) {
          // No line terminator in the remainder: buffer it, unless doing so
          // would breach the cap — in which case drop and resync, never store it.
          const rest = chunk.slice(start);
          if (!overflowed) {
            if (pending.length + rest.length > maxLineLength) {
              pending = "";
              overflowed = true;
            } else {
              pending += rest;
            }
          }
          return;
        }

        let segment = chunk.slice(start, newline);
        if (segment.endsWith("\r")) segment = segment.slice(0, -1);
        if (overflowed) {
          // This newline ends the over-cap run; resume normal buffering after it.
          overflowed = false;
          pending = "";
        } else if (pending.length + segment.length > maxLineLength) {
          // A completed but over-cap line — dropped whole, like any bad line.
          pending = "";
        } else {
          const line = pending + segment;
          pending = "";
          onLine(line);
        }
        start = newline + 1;
      }
    },
  };
}

/** The default spawner: detached (its own group), stdout piped, stderr inherited. */
function defaultSpawn(command: string, args: string[]): ChildProcess {
  return nodeSpawn(command, args, {
    detached: true,
    // stdin ignored, stdout is the data channel, stderr goes to the terminal.
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/**
 * Spawns `command` and streams host readings off its stdout. `intervalMs` is the
 * collector's declared cadence (from `steward.json`); the overlay uses it for
 * staleness, and it is reported here only if the collector is given up on.
 */
export function createHostCollector(
  command: string[],
  intervalMs: number,
  options: HostCollectorOptions = {},
): HostMetricsProvider {
  const program = command[0] ?? "";
  const args = command.slice(1);
  const maxRespawns = options.maxRespawns ?? DEFAULT_MAX_RESPAWNS;
  const minBackoffMs = options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const killEscalationMs = options.killEscalationMs ?? KILL_ESCALATION_MS;
  const now = options.now ?? Date.now;
  const spawn = options.spawn ?? defaultSpawn;

  let sample: HostSample | null = null;
  let child: ChildProcess | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let closed = false;

  function handleLine(line: string): void {
    // The splitter guarantees `line` is within the cap; malformed/foreign lines
    // simply fail validation and are dropped.
    const reading = parseHostMetricsLine(line);
    if (reading === null) return;
    // A real reading means this spawn is healthy: forgive its restart history so
    // an occasional respawn over a long, working run never reaches the cap.
    failures = 0;
    sample = { reading, receivedAt: now() };
  }

  function scheduleRespawn(): void {
    failures += 1;
    if (failures > maxRespawns) {
      console.warn(
        `[steward] host collector gave up after ${failures} failed starts ` +
          `(command: ${program}, intervalMs: ${intervalMs})`,
      );
      return;
    }
    const backoff = Math.min(maxBackoffMs, minBackoffMs * 2 ** (failures - 1));
    backoffTimer = setTimeout(spawnOnce, backoff);
  }

  function spawnOnce(): void {
    if (closed) return;
    backoffTimer = null;

    let proc: ChildProcess;
    try {
      proc = spawn(program, args);
    } catch {
      // A synchronous spawn throw (rare) is just another failed start.
      scheduleRespawn();
      return;
    }
    child = proc;

    // exit and error can both fire for one spawn (e.g. ENOENT); settle once so a
    // single failed start counts once toward the cap.
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (child === proc) child = null;
      if (!closed) scheduleRespawn();
    };
    // A listener is required or an 'error' would throw as unhandled.
    proc.once("error", settle);
    proc.once("exit", settle);

    if (proc.stdout !== null) {
      // Own the line-splitting (with a hard cap) rather than delegating to a
      // reader that would buffer an unterminated flood without bound.
      proc.stdout.setEncoding("utf8");
      const splitter = createLineSplitter(MAX_LINE_LENGTH, handleLine);
      proc.stdout.on("data", (chunk: string) => splitter.push(chunk));
    }
  }

  spawnOnce();

  return {
    latest(): HostSample | null {
      return sample;
    },

    close(): void {
      if (closed) return;
      closed = true;
      if (backoffTimer !== null) {
        clearTimeout(backoffTimer);
        backoffTimer = null;
      }
      const proc = child;
      child = null;
      if (proc === null || proc.pid === undefined) return;
      const pid = proc.pid;

      // Signal the whole group: the collector may be a shell pipeline, and a
      // direct kill would orphan the producer feeding it. Fall back to a direct
      // kill when there is no group (already gone, or negative pids unsupported).
      const signalGroup = (signal: NodeJS.Signals): void => {
        try {
          process.kill(-pid, signal);
        } catch {
          try {
            proc.kill(signal);
          } catch {
            // Already dead — nothing to do.
          }
        }
      };

      signalGroup("SIGTERM");
      // A producer that traps or ignores SIGTERM would otherwise linger; escalate
      // to an uncatchable SIGKILL after a grace period. The timer is unref'd so it
      // never keeps the process alive, and is cleared if it lands before firing.
      const escalation = setTimeout(() => signalGroup("SIGKILL"), killEscalationMs);
      escalation.unref();
    },
  };
}
