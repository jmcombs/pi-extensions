/**
 * The llama.cpp log-line parser.
 *
 * One raw line in, one structured record out. It is pure and Node-free on
 * purpose: the file tailer (`server/log-tailer.ts`) owns the I/O, the sequence
 * numbers and the port→model map, and this module owns nothing but the grammar.
 *
 * **The grammar is looser than it looks.** llama.cpp's log framework prepends at
 * most three optional things, and *everything after the level letter is
 * free-form message text*:
 *
 * ```
 * ^(?:\[(?<port>\d+)\]\s+)?                # router-added child prefix
 *  (?:(?<elapsed>\d+\.\d{2}\.\d{3}\.\d{3})\s+)?   # per-process elapsed MM.SS.mmm.uuu
 *  (?:(?<level>[IWED])\s+)?                # level letter
 *  (?<message>.*)$                         # message, verbatim
 * ```
 *
 * The `<component> <fn>:` shape (`srv  proxy_reques:`, `slot print_timing:`) is a
 * convention of *some* call sites, NOT log structure, and requiring it is wrong:
 * library-level lines carry no component at all (`E gguf_init_from_file: …`,
 * `W load: …`), and every line of a fatal model-load failure — the highest-value
 * lines in the whole stream — is in that class. So the parser never requires it.
 *
 * Two further rules follow from what real logs contain:
 *
 * - **No level letter means INFO.** 98.95% of a real corpus is `I`, the only
 *   level-less lines are the router↔child IPC records, and an operator running
 *   `--no-log-prefix` loses the letter entirely. Guessing anything else would
 *   manufacture severity.
 * - **The elapsed stamp is never turned into a time.** It is per-process and
 *   resets for every child, so it is not sortable across processes (a router
 *   line stamped `1408.02.766` really does precede a child line stamped
 *   `1408.01.683` for the same request). It stays inside the message, where it
 *   is what it is, and ordering comes from the tailer's `seq`.
 *
 * Nothing here throws. A line that matches nothing degrades to an INFO event
 * carrying the raw text, because a log console that drops what it cannot parse
 * is worse than one that shows it.
 */

import type { LogKind, LogLevel, LogOrigin } from "./types.js";

/** One parsed line, before the tailer stamps it with a `seq` and a `ts`. */
export interface ParsedLogLine {
  level: LogLevel;
  /** `child` when the router prefixed the line with `[port]`, else `router`. */
  origin: LogOrigin;
  /** The `[port]` prefix's port for a child line, else `null`. */
  port: number | null;
  /**
   * The model this line names *in its own text* (`name=X`, `proxying request to
   * model X`), or `null`. Router-wide lines — the boot banner, the preset
   * catalogue, the launch-args block — name nobody, and that is not a gap to
   * fill in: 26% of a filtered real log is genuinely about no single model.
   */
  modelName: string | null;
  /**
   * The port {@link modelName} was named *with* (`… name=X on port P`), or
   * `null`. The tailer folds this into its port→model map so a child that spawns
   * while Steward is watching is attributed before the next `/models` poll.
   */
  namedPort: number | null;
  kind: LogKind;
  /** Everything after the level letter, verbatim — what the console renders. */
  message: string;
}

/**
 * `[port]`, elapsed and level are each optional; the message is whatever is
 * left. Deliberately no component/function group — see the module comment.
 */
const LINE = /^(?:\[(\d+)\]\s+)?(?:(\d+\.\d{2}\.\d{3}\.\d{3})\s+)?(?:([IWED])\s+)?([\s\S]*)$/;

/**
 * ANSI SGR sequences. A file sink never contains them (verified: 0 of 15,842
 * lines), but `--log-colors on`, or a source that hands us a TTY-captured
 * stream, would put them in front of the level letter and break every match
 * below. Built from a string so the escape byte never appears in a regex
 * literal.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** Steward's own polling causes most of these — see {@link LogKind}. */
const PROXY = /(?:^|\s)proxy_reques\b|proxying request to model\b/;

/** The header that opens a launch-args run. It is a normal line, not an `args` one. */
const ARGS_HEADER = /spawning server instance with args:/;

/**
 * A continuation *inside* an args run: `srv          load:   --ctx-size`. Two or
 * more spaces after `load:` is what separates it from the header (one space) and
 * from `load: spawning …`.
 */
const ARGS_CONTINUATION = /(?:^|\s)load:\s{2,}\S/;

/** The same continuation with `--no-log-prefix`: the bare, indented value. */
const ARGS_BARE = /^\s{2,}\S/;

/**
 * The in-flight generation line: `… | n_decoded = 764, tg = 84.60 t/s, tg_3s = …`.
 * Both halves are required so a future completion summary that merely counts
 * decoded tokens is not mistaken for the ~3 s live-rate readout.
 */
const RATE_DECODED = /\bn_decoded\s*=/;
const RATE_TG = /\btg(?:_3s)?\s*=|\bt\/s\b/;

/** `spawning … name=X on port P`, `stopping model instance name=X`, `… name=X exited …`. */
const NAMED = /\bname=(\S+)/;

/** `proxy_reques: proxying request to model X on port P`. */
const PROXIED = /proxying request to model (\S+)(?: on port (\d+))?/;

/** The port a `name=`-bearing line associates the model with, when it states one. */
const NAMED_PORT = /\bon port (\d+)/;

function toLevel(letter: string | undefined): LogLevel {
  switch (letter) {
    case "W":
      return "WARN";
    case "E":
      return "ERROR";
    case "D":
      return "DEBUG";
    default:
      // No letter is INFO, not "unknown": that is what llama.cpp means by it.
      return "INFO";
  }
}

/** A real TCP port from a captured group, or `null`. */
function toPort(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * Which model a line names, and the port it names it with. Router lines that
 * name a model are attributable even though they are router-emitted — a spawn,
 * an unload, an exit and a proxied request all say who they are about, and the
 * console has a model column to fill.
 */
function readNamed(message: string): { modelName: string | null; namedPort: number | null } {
  const proxied = PROXIED.exec(message);
  if (proxied !== null) {
    return { modelName: proxied[1] ?? null, namedPort: toPort(proxied[2]) };
  }
  const named = NAMED.exec(message);
  if (named !== null) {
    return { modelName: named[1] ?? null, namedPort: toPort(NAMED_PORT.exec(message)?.[1]) };
  }
  return { modelName: null, namedPort: null };
}

/**
 * Whether this line continues the previous one's launch-args run. Membership is
 * positional — a contiguous run under the `with args:` header — because that is
 * how the block is actually emitted: N independent, self-contained lines with no
 * continuation marker of their own. A line that does not match ends the run.
 */
function continuesArgs(previous: ParsedLogLine | null, message: string): boolean {
  if (previous === null) return false;
  const inRun = previous.kind === "args" || ARGS_HEADER.test(previous.message);
  if (!inRun) return false;
  return ARGS_CONTINUATION.test(message) || ARGS_BARE.test(message);
}

/**
 * Classifies a line. Order matters only in that `proxy` and `rate` are decided
 * by shape and `args` by position, and no line is ever two of them in practice.
 */
function classify(message: string, origin: LogOrigin, previous: ParsedLogLine | null): LogKind {
  if (PROXY.test(message)) return "proxy";
  if (RATE_DECODED.test(message) && RATE_TG.test(message)) return "rate";
  // The args block is router-emitted; a child line that happened to look like a
  // continuation is not part of it.
  if (origin === "router" && !ARGS_HEADER.test(message) && continuesArgs(previous, message)) {
    return "args";
  }
  return "event";
}

/**
 * Parses one raw line.
 *
 * `previous` is the line immediately before it in the file, and is used for one
 * thing only: deciding whether this line continues a launch-args run. Pass
 * `null` at the start of a stream, or after a truncation or a reopen — the worst
 * a wrong answer costs is one fold boundary.
 *
 * Never throws. A line that is empty, malformed, or from a future llama.cpp
 * still comes back as an INFO event whose message is the text as read.
 */
export function parseLogLine(raw: string, previous: ParsedLogLine | null = null): ParsedLogLine {
  const clean = raw.replace(ANSI, "").replace(/\r$/, "");
  const match = LINE.exec(clean);
  // `LINE` cannot fail (every group is optional and the tail is `[^]*`), but a
  // parser that would throw on a line is not one to trust a live tail to.
  if (match === null) {
    return {
      level: "INFO",
      origin: "router",
      port: null,
      modelName: null,
      namedPort: null,
      kind: "event",
      message: clean,
    };
  }

  const port = toPort(match[1]);
  const level = toLevel(match[3]);
  const message = match[4] ?? "";
  const origin: LogOrigin = port === null ? "router" : "child";
  const { modelName, namedPort } = readNamed(message);

  return {
    level,
    origin,
    port,
    modelName,
    namedPort,
    kind: classify(message, origin, previous),
    message,
  };
}
