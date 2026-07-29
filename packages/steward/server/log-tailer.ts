/**
 * The Node body behind {@link LogTailer}: it follows `llama-server`'s combined
 * stdout/stderr redirect and turns every appended line into a {@link LogLine}.
 *
 * The source is deliberately the router's stdout redirect (what launchd's
 * `StandardOutPath`/`StandardErrorPath` capture), not `--log-file`: llama.cpp
 * propagates `--log-file` into every child model server, so that file gets each
 * child line twice — once written by the child, once echoed by the router — and
 * interleaves concurrent writers. The router's stdout has a single writer and
 * carries the children's output in order, `[port]`-prefixed.
 *
 * It **polls `fs.stat`** rather than watching. `fs.watch` misses appends on
 * Windows and has its own locking quirks there; polling a local file every few
 * hundred ms is portable, predictable, and cheap next to what the dashboard
 * already does per snapshot.
 *
 * The hazards it handles, in the order they actually happen on this platform:
 *
 *   - **The file is unlinked under us.** macOS runs `com.apple.tmp_cleaner`
 *     daily at 00:00 and deletes any `/tmp` file whose atime, mtime and ctime all
 *     exceed three days — so a router stopped for a long weekend loses its log.
 *     That is reported as a distinct `missing` state, never as an error, and it
 *     is self-healing: the tailer keeps polling and picks the path back up the
 *     moment something recreates it.
 *   - **The service restarts.** launchd APPENDS across restarts (16 boots in one
 *     observed file), so a restart is not a rotation: the offset stands, the
 *     sequence numbers keep climbing, and the console simply gets a fresh banner.
 *     Resetting `seq` here would make the client's replay/restart detection
 *     re-adopt the whole buffer.
 *   - **Truncation and replacement.** A shrinking file (`copytruncate`) restarts
 *     at offset 0; a changed inode (delete-and-recreate, logrotate create-new)
 *     reopens. Neither resets `seq`.
 *   - **Partial trailing lines.** A read can land mid-line, so an unterminated
 *     tail is buffered and only emitted once its newline arrives — and, per the
 *     bounded-splitter lesson from `host-collector.ts`, a newline-less flood is
 *     discarded rather than accumulated, so memory stays bounded whatever is
 *     written.
 *
 * Nothing here throws. A path that does not exist, cannot be read, or vanishes
 * mid-run is a state the console renders honestly, not a crash.
 */

import { closeSync, fstatSync, openSync, readSync, type Stats, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { LogTailer } from "../core/llama-source.js";
import { type ParsedLogLine, parseLogLine } from "../core/log-parse.js";
import type { LogAttachment, Unsubscribe } from "../core/source.js";
import type { LogLine, LogSourceState, LogStreamStatus } from "../core/types.js";
import { createLineSplitter } from "./host-collector.js";

/** The environment variable that points Steward at a log file explicitly. */
export const LOG_FILE_ENV = "STEWARD_LOG_FILE";

/**
 * Where a launchd-managed router's combined redirect lands on this platform by
 * convention. Only ever adopted when the file actually exists — naming a path
 * nobody configured, in a console that then reports it as missing, would send an
 * operator hunting a file that was never theirs.
 */
export const DEFAULT_LOG_PATH = "/tmp/llama-router.log";

/** How often the file is re-`stat`ed. Fast enough to feel live, cheap enough to ignore. */
const DEFAULT_POLL_INTERVAL_MS = 400;

/**
 * How much of an existing file is read as backlog on the first poll (and after a
 * reopen). 256 KB is ~3,000 real lines — far more than the 200 the client
 * replays — while a log that has grown for months is not read whole.
 */
const DEFAULT_BACKLOG_BYTES = 256 * 1024;

/** Lines kept for {@link LogTailer.recent}; the client's own buffer is no larger. */
const DEFAULT_MAX_LINES = 500;

/**
 * Longest single line assembled before it is discarded. Same cap and the same
 * reasoning as the host collector's: a producer that writes without newlines
 * must not be able to grow this process's memory.
 */
const MAX_LINE_LENGTH = 64 * 1024;

/**
 * Bytes read per poll. A tail that falls a long way behind (a burst, a long
 * pause in the event loop) catches up over several polls instead of blocking one
 * of them on a multi-megabyte read.
 */
const MAX_READ_PER_POLL = 1024 * 1024;

export interface FileTailerOptions {
  /** The log file to follow. It need not exist yet. */
  path: string;
  /** Milliseconds between `stat` polls. `0` leaves the tailer unscheduled (tests drive `poll`). */
  pollIntervalMs?: number;
  /** Bytes of existing file read as backlog on the first poll. */
  backlogBytes?: number;
  /** Lines retained for {@link LogTailer.recent}. */
  maxLines?: number;
  /** Arrival clock stamped on each line. Injected in tests; defaults to `Date.now`. */
  now?: () => number;
}

/** A file tailer plus the poll its timer drives, so tests need no timers. */
export interface FileTailer extends LogTailer {
  /** Runs one `stat`-and-read cycle. Never throws. */
  poll(): void;
}

/** Node's `stat` error shape, narrowed enough to read the code off. */
function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "unknown error";
}

/**
 * Follows `path`, emitting one {@link LogLine} per appended line.
 *
 * The backlog and the live tail come from ONE offset: every time the tailer
 * starts following a file — first sight, a replacement, a truncation — it
 * anchors at the end minus a backlog window, and every later poll continues from
 * where the last one stopped.
 *
 * Use {@link LogTailer.attach} to open a console: it hands back the backlog and
 * registers the listener in one step, which is the only way to get each line
 * exactly once. Calling {@link LogTailer.recent} and then
 * {@link LogTailer.subscribe} separately is correct only if nothing can poll
 * between them, and a line that arrives in that window is in neither result.
 */
export function createFileTailer(options: FileTailerOptions): FileTailer {
  const path = options.path;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const backlogBytes = options.backlogBytes ?? DEFAULT_BACKLOG_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const now = options.now ?? Date.now;

  const lines: LogLine[] = [];
  const listeners = new Set<(line: LogLine) => void>();
  /** Port→model id, refreshed from `/models` and reinforced by spawn lines. */
  let ports: Map<number, string> = new Map();

  /** Monotonic for the tailer's whole life — never reset, by any of the hazards. */
  let seq = 0;
  /** Byte offset already consumed from the current file. */
  let position = 0;
  /** Identity of the file we are following, so a replacement is detectable. */
  let inode: number | null = null;
  let device: number | null = null;
  /** False until the first poll has anchored the offset. */
  let anchored = false;
  /** Set when a read starts mid-file, so the leading partial line is discarded. */
  let dropPartial = false;
  let source: LogSourceState = "ok";
  let detail: string | null = null;
  let closed = false;

  /** The line before the one being parsed — the args run's only state. */
  let previous: ParsedLogLine | null = null;
  let decoder = new StringDecoder("utf8");
  let splitter = createLineSplitter(MAX_LINE_LENGTH, handleLine);

  /**
   * Attributes and emits one complete line.
   *
   * A child line belongs to whichever model holds its port; a router line
   * belongs to the model it names, if it names one. Everything else is
   * router-wide and stays `null` — roughly a quarter of a real log is genuinely
   * about no single model, and inventing an attribution for it would be worse
   * than the em dash the console renders.
   */
  function handleLine(raw: string): void {
    if (raw.trim() === "") return;
    const parsed = parseLogLine(raw, previous);
    previous = parsed;

    // A spawn seen live maps its port before the next `/models` poll does.
    if (parsed.modelName !== null && parsed.namedPort !== null) {
      ports.set(parsed.namedPort, parsed.modelName);
    }

    const fromPort = parsed.port === null ? null : (ports.get(parsed.port) ?? null);
    const modelId = parsed.origin === "child" ? (fromPort ?? parsed.modelName) : parsed.modelName;

    seq += 1;
    const line: LogLine = {
      seq,
      // The only timestamp in the file is a per-process elapsed counter that is
      // not sortable across processes, so this is arrival time — which is what
      // the console labels it as.
      ts: now(),
      level: parsed.level,
      modelId,
      message: parsed.message,
      kind: parsed.kind,
      origin: parsed.origin,
    };
    lines.push(line);
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
    for (const listener of listeners) listener(line);
  }

  /** Drops every byte of half-read state. Called whenever the file identity changes. */
  function resetStream(): void {
    decoder = new StringDecoder("utf8");
    splitter = createLineSplitter(MAX_LINE_LENGTH, handleLine);
    previous = null;
  }

  /** Where to start reading a file we have not been following: its tail. */
  function anchor(size: number): void {
    position = Math.max(0, size - backlogBytes);
    dropPartial = position > 0;
    resetStream();
  }

  /** Reads at most one chunk of new bytes and feeds them to the splitter. */
  function drain(size: number): void {
    if (position >= size) return;
    const length = Math.min(size - position, MAX_READ_PER_POLL);

    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (error) {
      markUnavailable(error);
      return;
    }
    try {
      // The file can be replaced between the stat above and this open; reading
      // a different inode at our offset would emit garbage. Check identity
      // against the handle we actually hold and let the next poll re-anchor.
      const open = fstatSync(fd);
      if (open.ino !== inode || open.dev !== device) return;

      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, position);
      if (read <= 0) return;
      position += read;

      let text = decoder.write(buffer.subarray(0, read));
      if (dropPartial) {
        // Anchoring mid-file lands in the middle of a line; that fragment is not
        // a record and is never emitted as one.
        const newline = text.indexOf("\n");
        text = newline === -1 ? "" : text.slice(newline + 1);
        if (newline !== -1) dropPartial = false;
      }
      splitter.push(text);
    } catch (error) {
      markUnavailable(error);
    } finally {
      closeSync(fd);
    }
  }

  /** The path is there but unreadable — a permission or I/O problem, not an absence. */
  function markUnavailable(error: unknown): void {
    source = "unavailable";
    detail = `${path} could not be read (${errorCode(error)})`;
  }

  function poll(): void {
    if (closed) return;
    try {
      let stats: Stats;
      try {
        stats = statSync(path);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          // The likely macOS case: `tmp_cleaner` unlinked it. Hold the offset and
          // the sequence, keep polling, and say so — this heals itself.
          source = "missing";
          detail = `${path} does not exist`;
        } else {
          markUnavailable(error);
        }
        return;
      }

      const replaced = anchored && (stats.ino !== inode || stats.dev !== device);
      if (!anchored) {
        // First sight: start at the tail, so a log that has grown for months
        // costs one backlog window rather than a whole-file read.
        inode = stats.ino;
        device = stats.dev;
        anchor(stats.size);
        anchored = true;
      } else if (replaced) {
        // Unlinked and recreated (the `tmp_cleaner` case, once the router writes
        // again), or rotated create-new: a different file, followed from its
        // start — but through the same backlog window as a first sight, so
        // rotating into a pre-populated file cannot flood every connected
        // console with a whole log.
        //
        // Recovery from `missing` lands here, because a recreated file always
        // has a new inode — while a transient stat failure on the SAME file does
        // not, and so cannot make us re-read and re-emit what we already sent.
        inode = stats.ino;
        device = stats.dev;
        anchor(stats.size);
      } else if (stats.size < position) {
        // Truncated in place (`copytruncate`): same file, fresh content, and the
        // same cap again — a truncate followed by a large write before the next
        // poll is otherwise the same flood by another route.
        anchor(stats.size);
      }

      source = "ok";
      detail = null;
      drain(stats.size);
    } catch (error) {
      // Belt and braces: a tail that throws would take the dashboard's poll
      // loop with it.
      markUnavailable(error);
    }
  }

  poll();

  const timer = pollIntervalMs > 0 ? setInterval(poll, pollIntervalMs) : null;
  // The dashboard's HTTP server keeps the process alive; a log tail should never
  // be the reason it cannot exit.
  timer?.unref();

  return {
    recent(limit: number): LogLine[] {
      if (limit <= 0) return [];
      return lines.slice(-limit);
    },

    subscribe(listener: (line: LogLine) => void): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    attach(listener: (line: LogLine) => void, limit: number): LogAttachment {
      // The backlog is taken and the listener registered with no suspension
      // point between them, so a poll cannot land in the gap and drop a line
      // out of both halves.
      const backlog = limit <= 0 ? [] : lines.slice(-limit);
      listeners.add(listener);
      return {
        backlog,
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },

    setPorts(next: ReadonlyMap<number, string>): void {
      // Merged, not replaced, and HTTP wins every conflict: a child that spawned
      // since the last poll is known here from its spawn line and not yet from
      // `/models`, and an empty map (a failed read, or nothing loaded) must not
      // blank out attribution for every child line until the next good poll.
      ports = new Map([...ports, ...next]);
    },

    status(): LogStreamStatus {
      return { source, path, detail };
    },

    poll,

    close(): void {
      closed = true;
      if (timer !== null) clearInterval(timer);
      listeners.clear();
    },
  };
}

/** The `log` block of `steward.json`, as this module needs it. */
export interface LogPathConfig {
  path: string;
}

export interface ResolveLogPathOptions {
  /** The validated `log` block from `steward.json`, or `null` when it has none. */
  config?: LogPathConfig | null;
  /** Environment to read {@link LOG_FILE_ENV} from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Existence test for the convention default. Injected in tests. */
  exists?: (path: string) => boolean;
}

/** True when `path` names a readable regular file. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The log file to follow, or `null` for an honest "no log source".
 *
 * Precedence: `STEWARD_LOG_FILE`, then `steward.json`'s `log.path`, then the
 * platform convention. The first two are taken at their word even when the file
 * is absent — the operator (or the skill) named that path, and a named path that
 * is currently missing is a state worth showing, and one that heals itself. The
 * convention default is only adopted when the file is really there, so a machine
 * that simply has not been wired up says "no log source" instead of blaming a
 * `/tmp` file nobody chose.
 *
 * Service-manager introspection deliberately does not happen here: recording
 * where this machine's router writes its log is the `/initialize-steward` skill's
 * job, and its answer arrives as `log.path`.
 */
export function resolveLogPath(options: ResolveLogPathOptions = {}): string | null {
  const env = options.env ?? process.env;
  const exists = options.exists ?? isFile;

  const override = env[LOG_FILE_ENV];
  if (override !== undefined && override.trim() !== "") return override.trim();

  const configured = options.config?.path;
  if (configured !== undefined && configured.trim() !== "") return configured.trim();

  return exists(DEFAULT_LOG_PATH) ? DEFAULT_LOG_PATH : null;
}
