/**
 * Runs the operator's declared start/stop/restart commands — the Node body
 * behind {@link ServiceController}.
 *
 * Unlike the host collector (a long-lived stream), control is one-shot. The
 * argv is passed as an array and NEVER through `shell: true` — the config is a
 * code-execution surface already, and a shell would add word-splitting and
 * metacharacter expansion on top of it. Only commands that passed the config's
 * ownership check and the per-command consent gate ever reach here.
 *
 * It never throws, never rejects, and — the guarantee the whole dashboard leans
 * on — always settles. The deadline is this module's own (SIGTERM, then SIGKILL
 * after a grace, then an answer either way) rather than `execFile`'s single
 * SIGTERM, which a command that traps it survives indefinitely. A non-zero exit,
 * a timeout, a missing binary, or an action with no consented command all
 * resolve as a failure with a readable detail, because "launchctl: permission
 * denied" on screen is worth more to an operator than a stack trace in a
 * terminal they are not reading. And a success is only the command's own
 * verdict: the caller re-polls, because a `KeepAlive` job exits 0 from a stop
 * and comes straight back.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { ServiceController, ServiceControlResult } from "../core/llama-source.js";
import type { ServiceAction } from "../core/types.js";

/**
 * How long a control command may run before it is killed. Generous next to the
 * probe's 1.5s: `launchctl bootout` waits on the job it is tearing down, and a
 * `systemctl restart` blocks until the unit settles.
 */
const CONTROL_TIMEOUT_MS = 10_000;

/**
 * Grace between the SIGTERM at the deadline and the SIGKILL that follows it,
 * and the point at which this module answers whatever the child does. A command
 * that traps or ignores SIGTERM would otherwise never settle: `execFile`'s own
 * `timeout` option signals once and then waits forever on a child that survives
 * it, and one unresolved promise here would hang the API handler, the browser's
 * fetch, and the control row with it.
 */
const KILL_ESCALATION_MS = 750;

/** Output past this is a runaway, not a message an operator wants to read. */
const MAX_OUTPUT_BYTES = 256 * 1024;

/** Longest failure detail we surface; the rest is noise on a rail 260px wide. */
const MAX_DETAIL_LENGTH = 160;

/**
 * Longest program name inside a detail. A launcher can live behind a very long
 * absolute path, and the reason ("permission denied") must survive the clamp —
 * so the path gives up its head, not the message its tail.
 */
const MAX_PROGRAM_LENGTH = 48;

/** The consented commands, keyed by action. A missing action cannot be run. */
export type ServiceControlCommands = Partial<Record<ServiceAction, string[]>>;

export interface ServiceControlOptions {
  /** Ceiling on one command's runtime, ms. Defaults to {@link CONTROL_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** The actions offered, in the order the dashboard renders them. */
const ACTION_ORDER: readonly ServiceAction[] = ["start", "stop", "restart"];

/**
 * Drops the control characters a terminal-shaped tool sprays into its output —
 * ANSI colour escapes above all. They are invisible on screen but a screen
 * reader reads them aloud, and this string ends up in a `role="alert"` region.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]+/gu;

function sanitize(text: string): string {
  return text.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
}

/** The first non-empty line of a command's output, cleaned, or null. */
function firstLine(output: unknown): string | null {
  if (typeof output !== "string") return null;
  for (const line of output.split("\n")) {
    const clean = sanitize(line);
    if (clean !== "") return clean;
  }
  return null;
}

/**
 * The program as it reads in a notice. The reason is the part an operator acts
 * on, so a very long path gives up its head (`…/bin/launchctl`) rather than
 * pushing the reason past the clamp.
 */
function programLabel(program: string): string {
  const clean = sanitize(program);
  if (clean.length <= MAX_PROGRAM_LENGTH) return clean;
  return `…${clean.slice(clean.length - (MAX_PROGRAM_LENGTH - 1))}`;
}

/** The finished detail: bounded as a whole, not merely in its fragments. */
function detail(program: string, reason: string): string {
  const text = `${programLabel(program)}: ${reason}`;
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…` : text;
}

/**
 * Everything one finished run knows about itself. `timedOut` and `overflowed`
 * are this module's own verdicts, not the child's: only we know the deadline
 * passed or the output cap was breached, and a child killed for either reason
 * must not be described by whatever it happened to print on the way out.
 */
interface CommandOutcome {
  /** A spawn-level errno (`ENOENT`, `EACCES`), when the program never ran. */
  errorCode?: string;
  /** The exit status, or `null` when a signal ended it. */
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  overflowed?: boolean;
}

/**
 * Turns a finished run into something an operator can act on. The interesting
 * cases are the ones an operator hits in practice: a command that is not
 * installed, one the user may not run, one that hung, and one that ran and
 * refused — the last of which usually explains itself on stderr (`launchctl`'s
 * "Load failed: 5: Input/output error"), so that line is preferred over a bare
 * exit status.
 */
function describeFailure(program: string, timeoutMs: number, outcome: CommandOutcome): string {
  if (outcome.errorCode === "ENOENT") return detail(program, "command not found");
  if (outcome.errorCode === "EACCES" || outcome.errorCode === "EPERM") {
    return detail(program, "permission denied");
  }
  if (outcome.timedOut === true) return detail(program, `timed out after ${timeoutMs}ms`);
  // An overflowing child is killed mid-run, and its truncated output is NOT the
  // reason it failed — reporting that output would invent a failure message out
  // of a chatty command's ordinary chatter.
  if (outcome.overflowed === true) {
    return detail(
      program,
      `produced more than ${MAX_OUTPUT_BYTES / 1024} KB of output and was killed`,
    );
  }

  const line = firstLine(outcome.stderr) ?? firstLine(outcome.stdout);
  if (line !== null) return detail(program, line);
  if (typeof outcome.signal === "string" && outcome.signal !== "") {
    return detail(program, `killed by ${outcome.signal}`);
  }
  if (typeof outcome.exitCode === "number") {
    return detail(program, `exited with status ${outcome.exitCode}`);
  }
  if (outcome.errorCode !== undefined) return detail(program, sanitize(outcome.errorCode));
  return detail(program, "failed");
}

/**
 * Runs one command under a deadline this module owns.
 *
 * `spawn` rather than `execFile`, for two reasons that both cost the operator
 * dearly otherwise. First, `execFile`'s `timeout` (and `promisify`'s) sends a
 * single SIGTERM and then waits on the child forever, so a command that traps
 * it — a wrapper script with `trap '' TERM` — leaves the promise pending, and
 * with it the API request, the browser's fetch, and the control row, which
 * stays disabled until the page is reloaded. Second, `execFile` does not
 * forward `detached`, so there is no process GROUP to signal: killing the
 * direct child of a wrapper leaves the `launchctl` (or `sleep`) it was waiting
 * on running, while the dashboard reports the command killed.
 *
 * So this owns the whole lifecycle — a detached group, bounded output, SIGTERM
 * at the deadline, SIGKILL after a grace, and an answer from our own timer
 * regardless of whether the child ever exits. It is the host collector's lesson
 * applied to a one-shot command.
 */
function runCommand(
  program: string,
  args: string[],
  timeoutMs: number,
): Promise<ServiceControlResult> {
  return new Promise<ServiceControlResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let stdout = "";
    let stderr = "";
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: ServiceControlResult): void => {
      if (settled) return;
      settled = true;
      // Both timers are cleared on every path, so neither outlives the call.
      clearTimeout(deadline);
      clearTimeout(escalation);
      resolve(result);
    };

    const fail = (outcome: CommandOutcome): void => {
      finish({ ok: false, detail: describeFailure(program, timeoutMs, outcome) });
    };

    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        // Its own process group, so the escalation below reaches a wrapper's
        // children too. Never `unref`'d: this run waits for it.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      // A synchronous throw (an invalid program string) is just a failure.
      fail({ errorCode: error instanceof Error ? error.message : String(error) });
      return;
    }

    /**
     * Signals the child's whole process group, falling back to the child alone
     * where there is no group (already reaped, or a platform without negative
     * pids). Every path is guarded: signalling a process that has just exited
     * is a race, not an error.
     */
    const signal = (name: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, name);
      } catch {
        try {
          child.kill(name);
        } catch {
          // Already gone — nothing to signal.
        }
      }
    };

    /**
     * Keeps at most {@link MAX_OUTPUT_BYTES} of a stream. A command that floods
     * its output is killed rather than buffered without bound, and the flood is
     * never mistaken for its reason.
     */
    const collect = (chunk: string, held: string): string => {
      if (held.length + chunk.length <= MAX_OUTPUT_BYTES) return held + chunk;
      if (!overflowed) {
        overflowed = true;
        signal("SIGKILL");
      }
      return held;
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = collect(chunk, stdout);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = collect(chunk, stderr);
    });

    // A listener is required or an 'error' would throw as unhandled. It fires
    // for a program that could not be started at all (ENOENT, EACCES).
    child.once("error", (error: NodeJS.ErrnoException) => {
      fail({ errorCode: error.code ?? error.message, stdout, stderr });
    });

    // 'close' rather than 'exit': it lands once the pipes are drained, so the
    // reason on stderr is complete by the time it is read.
    child.once("close", (code, signalName) => {
      if (timedOut) {
        fail({ timedOut: true });
        return;
      }
      if (overflowed) {
        fail({ overflowed: true });
        return;
      }
      if (code === 0) {
        finish({ ok: true, detail: null });
        return;
      }
      fail({ exitCode: code, signal: signalName, stdout, stderr });
    });

    deadline = setTimeout(() => {
      timedOut = true;
      // Ask first: a control command mid-teardown deserves the chance to finish
      // what it started, and most tools exit promptly on SIGTERM.
      signal("SIGTERM");
      escalation = setTimeout(() => {
        signal("SIGKILL");
        // Answer regardless of what the child does next. A SIGKILL cannot be
        // trapped, but a process can be unkillable (uninterruptible sleep) or
        // hold its stdio open through a grandchild, and neither may hold the
        // dashboard.
        fail({ timedOut: true });
      }, KILL_ESCALATION_MS);
    }, timeoutMs);
  });
}

/**
 * A controller over the given consented commands. Building one costs nothing
 * and holds nothing: each {@link ServiceController.run} is a single one-shot
 * exec, so the instance can be shared and needs no close.
 */
export function createServiceController(
  commands: ServiceControlCommands,
  options: ServiceControlOptions = {},
): ServiceController {
  const timeoutMs = options.timeoutMs ?? CONTROL_TIMEOUT_MS;
  const actions = ACTION_ORDER.filter((action) => {
    const command = commands[action];
    return command !== undefined && command.length > 0;
  });

  return {
    actions,

    run(action: ServiceAction): Promise<ServiceControlResult> {
      const command = commands[action];
      const program = command?.[0];
      if (command === undefined || program === undefined) {
        // Reachable when a client POSTs an action the dashboard never offered.
        return Promise.resolve({
          ok: false,
          detail: `no consented ${action} command for this machine — run /steward_initialize`,
        });
      }

      return runCommand(program, command.slice(1), timeoutMs);
    },
  };
}
