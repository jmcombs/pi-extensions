/**
 * Config drift — the honesty check behind everything `steward.json` asserts.
 *
 * Steward's facts about a machine (which flags `llama-server` was launched
 * with, which commands the operator approved) come from an artifact written
 * once, by the `/initialize-steward` skill. Nothing stops the operator editing
 * their launchd plist or systemd unit afterwards, and nothing announces it when
 * they do. Without a re-check, a machine that lost `--metrics` shows a dark
 * throughput tile AND — because "fully compliant renders nothing" — an implicit
 * all-clear. This module is the type surface that makes the mismatch visible.
 *
 * Two independent producers feed one notice:
 *   - {@link LaunchDrift}: the live process argv diffed against what was
 *     recorded (the Node body that reads it lives in `server/drift-probe.ts`;
 *     the comparison itself is {@link diffLaunchArgv}, here, so it is testable
 *     without a real `llama-server`).
 *   - {@link ConsentDrift}: a collector or control command `steward.json`
 *     declares but whose exact command is NOT in the consent map. Today that
 *     silently does nothing — no collector, no button — and the operator has no
 *     way to tell an inert panel from an unconfigured one.
 *
 * The load-bearing rule for both: a check that could not be made is `unknown`,
 * never a quiet "clean" and never a fabricated "drifted". A false alarm on a
 * correctly configured machine costs exactly as much trust as a missed one.
 *
 * Keep this module free of Node and DOM APIs — see `./types.ts`.
 */

import type { ServiceAction } from "./types.js";

/**
 * The verdict of the launch-argv re-check.
 *
 * `unknown` is the honest degrade: no listening process, no `ps`, a permission
 * error, a command line the process list truncated, or no recorded argv to
 * compare against. It renders nothing, exactly as `clean` does — the difference
 * is that `clean` is a statement and `unknown` is an absence of one.
 */
export type LaunchDriftStatus = "clean" | "drifted" | "unknown";

/** The program path recorded at setup against the one running now. */
export interface ProgramChange {
  recorded: string;
  observed: string;
}

/**
 * How the running process's argv compares to the argv `/initialize-steward`
 * recorded. `added` and `removed` are whole flag GROUPS (`--port 8080`, not two
 * loose tokens), so the notice can name what actually changed rather than
 * printing two command lines and leaving the operator to spot the difference.
 */
export interface LaunchDrift {
  status: LaunchDriftStatus;
  /** Groups the live process carries that were not recorded, e.g. `--no-slots`. */
  added: string[];
  /** Groups that were recorded and are gone now, e.g. `--metrics`. */
  removed: string[];
  /** Set when the binary itself changed; `null` when it did not. */
  program: ProgramChange | null;
  /** Why no verdict could be reached (`unknown` only); `null` otherwise. */
  reason: string | null;
}

/**
 * Commands `steward.json` declares but that carry no matching entry in its
 * consent map. Steward refuses to run them — that is the security gate working
 * — but silence makes the resulting empty panel indistinguishable from one that
 * was never configured.
 */
export interface ConsentDrift {
  /** True when a collector is declared and its exact command is unapproved. */
  hostCollector: boolean;
  /** Declared-but-unapproved control actions, in start/stop/restart order. */
  controls: ServiceAction[];
}

/** Both producers, as carried on a {@link import("./types.js").Snapshot}. */
export interface DriftState {
  launch: LaunchDrift;
  consent: ConsentDrift;
}

/**
 * Re-validates the launch argv of one already-identified process. Node-side and
 * platform-specific (it shells out to `ps`), so it is injected rather than
 * imported by the source — this module stays free of Node APIs, mirroring
 * {@link import("./llama-source.js").ServiceProbe}.
 *
 * It takes the pid the snapshot already resolved rather than a host and port,
 * so the drift notice and the SERVICE block can never end up describing two
 * different processes (and so a second `lsof` is not run per poll). A `null`
 * pid — nothing listening, or no process probe configured — is a check that
 * could not be made. It never rejects: every failure is an `unknown`
 * {@link LaunchDrift}.
 */
export type DriftProbe = (pid: number | null) => Promise<LaunchDrift>;

/** Nothing declared, nothing unapproved. */
export const NO_CONSENT_DRIFT: ConsentDrift = { hostCollector: false, controls: [] };

/** An "it could not be checked" verdict carrying the reason it could not. */
export function unknownLaunchDrift(reason: string): LaunchDrift {
  return { status: "unknown", added: [], removed: [], program: null, reason };
}

/** The drift state of a source that does not re-validate anything. */
export function unknownDrift(reason: string): DriftState {
  return { launch: unknownLaunchDrift(reason), consent: NO_CONSENT_DRIFT };
}

/**
 * What `ps` prints when it has a process but no argv to show for it: a zombie,
 * or a Linux `/proc` mounted with `hidepid`, comes back as `(llama-server)` or
 * `[llama-server]`. It is a placeholder, not a command line — diffing against it
 * would report every recorded flag removed AND a changed binary, the loudest
 * possible false alarm on a machine that changed nothing.
 */
const PLACEHOLDER_COMMAND = /^\(.*\)$|^\[.*\]$/u;

/**
 * Splits an argv into flag groups: a token starting with `-` opens a group and
 * every following non-flag token belongs to it, so `--port 8080` is one unit and
 * `--metrics` is another. Tokens before the first flag are the program and its
 * bare operands, returned separately — the binary changing is a different fact
 * from a flag changing, and reads differently in the notice.
 *
 * `--flag=value` is normalised to `--flag value`: llama.cpp accepts a flag
 * either way, so treating the two spellings as different would nag an operator
 * whose plist merely writes them differently.
 *
 * Known limitation: a quoted VALUE that itself starts with a dash (`--alias
 * "-Fast- Model"`) opens a group of its own, because a `ps` line has lost the
 * quoting that would say otherwise. It costs only precision in the wording of a
 * diff that is already being reported — the verdict is unaffected while nothing
 * else changed, since both sides group the same way.
 */
function groupArgv(tokens: readonly string[]): { program: string; groups: string[] } {
  const groups: string[] = [];
  const leading: string[] = [];
  let current: string[] | null = null;

  const flush = (): void => {
    if (current !== null) groups.push(current.join(" "));
    current = null;
  };

  for (const token of tokens) {
    if (token.startsWith("-") && token !== "-" && token !== "--") {
      flush();
      const equals = token.indexOf("=");
      // Only a flag's own `=` is split; a VALUE may legitimately contain one
      // (`--override-kv tokenizer.ggml.add_bos_token=bool:false`) and is left
      // exactly as written.
      current = equals > 0 ? [token.slice(0, equals), token.slice(equals + 1)] : [token];
      continue;
    }
    if (current === null) leading.push(token);
    else current.push(token);
  }
  flush();

  return { program: leading.join(" "), groups };
}

/** The groups in `a` that `b` does not have, counting duplicates. */
function missingFrom(a: readonly string[], b: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const group of b) remaining.set(group, (remaining.get(group) ?? 0) + 1);

  const missing: string[] = [];
  for (const group of a) {
    const count = remaining.get(group) ?? 0;
    if (count > 0) remaining.set(group, count - 1);
    else missing.push(group);
  }
  return missing;
}

/** Whitespace-separated tokens, with the empties dropped. */
function tokenize(line: string): string[] {
  return line.split(/\s+/u).filter((token) => token !== "");
}

/**
 * Diffs the live command line against the argv recorded at setup.
 *
 * `observed` is one `ps` line: the argv joined on single spaces, which is
 * exactly what `recorded.join(" ")` produces — so an equal join is a clean
 * verdict no matter how the argv was quoted, and quoting can never fake a drift.
 *
 * What counts as drift is deliberately narrow, because a false alarm on a
 * correctly configured machine is as damaging as a missed one:
 *   - ORDER is not drift. The groups are compared as multisets; a plist that
 *     lists the same flags in a different order changed nothing about how the
 *     server runs.
 *   - A line the process list CUT SHORT is not drift. A truncated line is a
 *     strict prefix of the recorded one that stops mid-token; that is reported
 *     `unknown`. A line that stops exactly at a token boundary is NOT treated as
 *     truncation — that is the single most likely real edit (deleting the last
 *     flag), and swallowing it would defeat the whole check.
 *   - Nothing recorded, nothing observed, or a `ps` PLACEHOLDER in place of a
 *     command line is `unknown`, never `clean`.
 */
export function diffLaunchArgv(recorded: readonly string[], observed: string): LaunchDrift {
  const expectedTokens = recorded.filter((token) => token !== "");
  if (expectedTokens.length === 0) {
    return unknownLaunchDrift("no launch command was recorded for this machine");
  }

  const line = observed.trim();
  if (line === "" || PLACEHOLDER_COMMAND.test(line)) {
    return unknownLaunchDrift("the process list reported no command line");
  }

  const expected = expectedTokens.join(" ");
  if (line === expected) {
    return { status: "clean", added: [], removed: [], program: null, reason: null };
  }

  // Cut mid-token: `ps` gave us less than the process actually holds, so there
  // is no verdict to reach — saying "these flags were removed" here would
  // invent drift out of a display width.
  if (expected.startsWith(line) && expected.charAt(line.length) !== " ") {
    return unknownLaunchDrift("the process list truncated the command line");
  }

  const before = groupArgv(expectedTokens);
  const after = groupArgv(tokenize(line));
  const added = missingFrom(after.groups, before.groups);
  const removed = missingFrom(before.groups, after.groups);
  const program = before.program === after.program ? null : after.program;

  if (added.length === 0 && removed.length === 0 && program === null) {
    // Same program, same groups: the two lines differ only in the order the
    // flags were written, which changes nothing the server does.
    return { status: "clean", added: [], removed: [], program: null, reason: null };
  }

  return {
    status: "drifted",
    added,
    removed,
    program: program === null ? null : { recorded: before.program, observed: program },
    reason: null,
  };
}
