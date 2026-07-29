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
 * ^(?:\[ *(?<port>\d+) *\]\s+)?            # router-added child prefix
 *  (?:(?<elapsed>\d+\.\d{2}\.\d{3}\.\d{3})\s+)?   # per-process elapsed M+.SS.mmm.uuu
 *  (?:(?<level>[IWED])\s+)?                # level letter
 *  (?<message>.*)$                         # message, verbatim
 * ```
 *
 * Three details of that shape are dictated by llama.cpp's `printf` formats, and
 * each of them has bitten a parser written from a sample of one log:
 *
 * - **The `[port]` prefix is space-padded.** The router forwards child output as
 *   `LOG("[%5d] %s", port, buffer)`, so the port is right-aligned in a
 *   five-wide field: `[57409]` for an ephemeral port, but `[ 8080]` for a
 *   four-digit one. Requiring `\[\d+\]` silently demotes every such line to a
 *   router line and throws away its model attribution.
 * - **The elapsed stamp's leading field is unbounded.** It is printed
 *   `"%d.%02d.%03d.%03d"` from a running total of *minutes* — only the last
 *   three fields are fixed-width. A process up for three hours stamps
 *   `180.05.123.456`, and a long-lived router reaches four digits.
 * - **A forwarded child line carries no router-side framing at all.** `LOG` is
 *   `GGML_LOG_LEVEL_NONE`, and the whole prefix block — timestamp *and* level
 *   letter — is skipped for that level. What follows `[port] ` is the child's
 *   own line, complete with whatever prefix the child itself emitted, or none
 *   at all when the child used `LOG` too (the `cmd_child_to_router:state:` IPC
 *   records). Every field ahead of the message is therefore independently
 *   optional, which is why they are matched that way rather than as a unit.
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

import type { LogFamily, LogFrame, LogKind, LogLevel, LogOrigin } from "./types.js";

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
  /**
   * The `SLT_*` macro's pipe frame, or `null` when the line did not carry one.
   * A nullable enrichment like every other: no match means the line is returned
   * whole and the console renders it exactly as it did before this existed.
   */
  frame: LogFrame | null;
  /** Which console chip the line answers to. Never `null` — see {@link classifyFamily}. */
  family: LogFamily;
  /** `truncated = 1` on a release line. `false` means the line did not say so. */
  contextLost: boolean;
  /** `sim_best` as a 0–1 fraction, or `null` where the line reported none. */
  cacheHit: number | null;
  /**
   * Everything after {@link frame} (or after the level letter when unframed),
   * verbatim — what the console renders. `frame.raw + message` re-forms the
   * line the file wrote, byte for byte.
   */
  message: string;
}

/**
 * `[port]`, elapsed and level are each optional; the message is whatever is
 * left. Deliberately no component/function group — see the module comment.
 *
 * The padding inside the brackets is tolerated on both sides so a change of
 * field width or alignment upstream cannot cost us attribution; only digits and
 * spaces are accepted there, so message text such as `[warn] …` is still text.
 * The minutes field is `\d+` because it counts minutes without wrapping.
 */
const LINE = /^(?:\[ *(\d+) *\]\s+)?(?:(\d+\.\d{2}\.\d{3}\.\d{3})\s+)?(?:([IWED])\s+)?([\s\S]*)$/;

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

/**
 * `slot print_timing: id  0 | task 81259 | ` — the `SLT_*` macro's frame,
 * applied to the text after the level letter.
 *
 * Group 1 is the WHOLE prefix through the second pipe, head included, because
 * that is the only split under which `frame.raw + message` re-forms the line
 * byte for byte — and byte-exact export is what makes relocating the frame a
 * relocation rather than a rewrite. The `[\s\S]*` tail is what keeps this a
 * nullable enrichment: a line that does not match comes back whole and
 * untouched, with the frame still in its message where it always was.
 */
const FRAME = /^(.*?\bid\s+(-?\d+)\s\|\stask\s(-?\d+)\s\|\s)([\s\S]*)$/;

/**
 * `truncated = 1` on a `release` line: a context shift discarded the front of
 * this request's conversation before the reply was written. Only ever read as a
 * positive — `truncated = 0` is 217/217 of a measured corpus and a badge on
 * every one of them would train the eye to skip the pixel where the real thing
 * appears.
 */
const TRUNCATED = /\btruncated\s*=\s*1\b/;

/** `sim_best = 0.473` — the fraction of the prompt already in the KV cache. */
const SIM_BEST = /\bsim_best\s*=\s*([01]?\.\d+|\d+)/;

/** The args block's header, which carries no `name=` of its own. */
const SPAWNING = /spawning server instance/;

/**
 * The router's own boot vocabulary — the ONE place the family classifier reads
 * prose, and the reason it is a list of literal substrings rather than a
 * function name: `operator()` is 41% of llama.cpp's log call sites and covers
 * four unrelated concerns, so any rule keyed on a function name is broken
 * before it ships. A phrase that churns costs one row moving to `other`, which
 * is visible, countable and never a dropped line.
 */
/**
 * A line INDENTED under a header — the shape of a continuation, whatever it
 * continues. Two or more spaces after the `<component> <fn>:` head is what
 * separates it from an ordinary line, and it reads the component literal (a
 * macro constant, byte-stable for 18 months) and the indentation, never the
 * function name.
 *
 * The router's preset catalogue is emitted this way: one `Available models (N)`
 * header followed by a line per preset, each carrying nothing but a model id.
 * There is no literal in those lines to key on — so, exactly like the launch
 * args, membership is positional.
 */
const INDENTED_CONTINUATION = /^srv\s+\S+:\s{2,}\S/;

/** The header the preset catalogue hangs off. */
const CATALOGUE_HEADER = /Available models \(/;

const STARTUP_PHRASES: readonly string[] = [
  "starting server in router mode",
  "listening on",
  "router mode is experimental",
  "untrusted environments",
  "model presets",
  "Available models (",
  "common_params_print_info",
  "chat template supports",
];

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
 * Splits the pipe frame off the front of a message, or leaves it alone.
 *
 * The split point is the second pipe, so what comes back satisfies
 * `frame.raw + body === message` for every input, matched or not. A frame whose
 * numbers do not parse is treated as no frame at all: an enrichment that cannot
 * be trusted is better absent than wrong, and the row renders exactly as it did
 * before.
 */
function readFrame(message: string): { frame: LogFrame | null; body: string } {
  const match = FRAME.exec(message);
  if (match === null) return { frame: null, body: message };
  const slot = Number.parseInt(match[2] ?? "", 10);
  const task = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isInteger(slot) || !Number.isInteger(task)) return { frame: null, body: message };
  return { frame: { slot, task, raw: match[1] ?? "" }, body: match[4] ?? "" };
}

/** `sim_best` as a 0–1 fraction, or `null` when the line reported none. */
function readCacheHit(message: string): number | null {
  const match = SIM_BEST.exec(message);
  if (match === null) return null;
  const value = Number.parseFloat(match[1] ?? "");
  return Number.isFinite(value) ? value : null;
}

/** What {@link classifyFamily} needs. A subset of a parsed line, so a simulated
 * source can classify its own drafts through the same rules instead of a copy. */
export interface FamilyInput {
  frame: LogFrame | null;
  kind: LogKind;
  origin: LogOrigin;
  /** The post-frame message — the same text {@link ParsedLogLine.message} carries. */
  message: string;
  /**
   * The line immediately before this one, for the one positional rule: the
   * preset catalogue's members carry no literal of their own and belong to
   * their header. Omit it and they fall to `other`, which is visible and
   * countable — the rule degrades the same way every other one does.
   */
  previous?: { family: LogFamily; message: string } | null;
}

/**
 * Whether this line continues a preset-catalogue run. Membership is positional,
 * exactly as it is for the launch-args block and for the same reason: the run
 * is N self-contained lines with no continuation marker of their own, and a
 * line that does not match ends it.
 */
function continuesCatalogue(
  previous: { family: LogFamily; message: string } | null | undefined,
  message: string,
): boolean {
  if (previous === null || previous === undefined) return false;
  const inRun =
    previous.family === "startup" &&
    (CATALOGUE_HEADER.test(previous.message) || INDENTED_CONTINUATION.test(previous.message));
  return inRun && INDENTED_CONTINUATION.test(message);
}

/**
 * Which console chip a line answers to. First match wins.
 *
 * **It reads zero function names**, and that is the whole point: llama.cpp's
 * `__func__` values are truncated to 12 characters, collide (`print_timing` is
 * three different functions), mean two unrelated things depending on component
 * (`load`), and are `operator()` for 41% of call sites. The rules key on the
 * 18-month-stable pipe frame, on classifications the parser already made, on
 * the `[port]` prefix, and — once, in rule 6 — on prose.
 *
 * Only rule 6 can rot, and when it does a row moves to `other`. Nothing is ever
 * dropped, and `other`'s count is the alarm.
 */
export function classifyFamily(input: FamilyInput): LogFamily {
  // 1. Pipe-framed: the line is a slot doing work on a request.
  if (input.frame !== null) return "requests";
  // 2. A proxied request IS a request, even though the toggle owns showing it.
  if (input.kind === "proxy") return "requests";
  // 3. The launch-args run is part of the model coming up.
  if (input.kind === "args") return "models";
  // 4. Anything that names an instance — spawn, unload, LRU eviction, exit. The
  //    args HEADER carries no `name=` and is caught by name, or it would land in
  //    `other`, orphaned from the fold it introduces.
  if (NAMED.test(input.message) || SPAWNING.test(input.message)) return "models";
  // 5. A child process wrote it, so it is that model's own boot/vocab/KV output.
  //    This is what catches the component-less vocab warnings without ever
  //    naming `llama_vocab::impl::load`.
  if (input.origin === "child") return "models";
  // 6. The one prose-dependent rule, plus the catalogue members that hang off
  //    one of its phrases positionally.
  if (STARTUP_PHRASES.some((phrase) => input.message.includes(phrase))) return "startup";
  if (continuesCatalogue(input.previous, input.message)) return "startup";
  // 7. Everything else stays visible, and countable.
  return "other";
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
      frame: null,
      family: "other",
      contextLost: false,
      cacheHit: null,
      message: clean,
    };
  }

  const port = toPort(match[1]);
  const level = toLevel(match[3]);
  const origin: LogOrigin = port === null ? "router" : "child";
  // The frame comes off first, so every enrichment below reads the same text
  // the console will paint. Framed lines carry no `name=` and are never proxy
  // or args records, so nothing the older rules depended on moved.
  const { frame, body } = readFrame(match[4] ?? "");
  const { modelName, namedPort } = readNamed(body);
  const kind = classify(body, origin, previous);

  return {
    level,
    origin,
    port,
    modelName,
    namedPort,
    kind,
    frame,
    family: classifyFamily({ frame, kind, origin, message: body, previous }),
    contextLost: TRUNCATED.test(body),
    cacheHit: readCacheHit(body),
    message: body,
  };
}
