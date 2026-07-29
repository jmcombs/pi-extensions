/**
 * Re-validates, every snapshot, that `llama-server` is still running with the
 * flags `steward.json` says it was launched with — the Node body behind
 * {@link DriftProbe}.
 *
 * It is handed the pid the snapshot ALREADY resolved for the SERVICE block and
 * reads that process's live command line with `ps`. Taking the pid rather than
 * a host and port is deliberate: re-running `lsof` here would cost a second
 * ~60 ms subprocess on every poll, and — because the two lookups would land at
 * different instants — a restart could leave the SERVICE block and the drift
 * notice describing two different processes. One lookup, one process, one story.
 * The comparison itself is pure and lives in `core/drift.ts`, so what counts as
 * drift can be proven without a real server.
 *
 * Two properties matter more than anything this module does:
 *
 *   - It NEVER throws and never reports a verdict it did not reach. No pid, no
 *     `ps`, a permission error, an empty or truncated line — all of them are
 *     `unknown`, which renders nothing. Fabricating "clean" would restore the
 *     exact false all-clear this check exists to remove; fabricating "drifted"
 *     would nag a machine that is configured correctly, which spends the same
 *     trust.
 *   - It is cheap enough to run on every poll, without ever going quiet. The
 *     command line of a process cannot change while it lives, so a SUCCESSFUL
 *     read is cached and serves every later snapshot; a new (or vanished) pid
 *     drops it. A FAILED read is never cached as an answer — it backs off and is
 *     retried, because a check that stopped running while still rendering
 *     nothing is indistinguishable from a machine that is fine.
 *
 * macOS/Linux only, like the service probe: a platform without `ps` simply
 * reports `unknown`, which is the honest answer.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DriftProbe, LaunchDrift } from "../core/drift.js";
import { diffLaunchArgv, unknownLaunchDrift } from "../core/drift.js";

const run = promisify(execFile);

/** No single probe command may hang the metrics poll. */
const PROBE_TIMEOUT_MS = 1500;

/**
 * How many polls a failed read waits before it is retried, at most. A read that
 * keeps failing (a `ps` that is not there, a process we may not inspect) backs
 * off rather than shelling out every 1.6 s — but it NEVER gives up, because a
 * check that has quietly stopped running looks exactly like a compliant machine.
 */
const MAX_RETRY_SKIP = 8;

/**
 * Reads one process's live command line — the argv joined on single spaces, as
 * `ps` prints it — or `null` when it cannot be read. Injected in tests, so the
 * probe is proven against a fake process list rather than this machine's real
 * `llama-server`.
 */
export type ArgvReader = (pid: number) => Promise<string | null>;

export interface DriftProbeOptions {
  /** The argv `/initialize-steward` recorded, from `steward.json`'s `llama` block. */
  launchArgv: readonly string[];
  /** Overrides the `ps` command-line read. */
  readArgv?: ArgvReader;
}

/**
 * One process's full command line, or `null`.
 *
 * `-ww` is not decoration. `ps` truncates to the display width, and while both
 * macOS and Linux hand back the whole line when stdout is a pipe (verified on
 * this machine: a 10 KB argv came back whole), `-ww` asks for unlimited width
 * explicitly rather than relying on that. Anything the flag fails to prevent is
 * still caught downstream, where a line cut mid-token is reported `unknown`.
 *
 * `args=` (rather than `command=`) is the portable spelling of "the argv" on
 * both platforms; the trailing `=` drops the header row.
 */
async function processArgv(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run("ps", ["-ww", "-o", "args=", "-p", String(pid)], {
      timeout: PROBE_TIMEOUT_MS,
    });
    // A process that exited between the lsof and the ps prints nothing and
    // exits non-zero; a header-only read is empty too. Either way: no line.
    const line = stdout.split("\n")[0]?.trim() ?? "";
    return line === "" ? null : line;
  } catch {
    // ps missing, the pid gone (exit 1), a permission error, or timed out.
    return null;
  }
}

/**
 * A drift probe over one recorded argv, with a per-pid cache of the live
 * command line. Build it only when `steward.json` carries a `llama` block: with
 * nothing recorded there is nothing to compare against, and the caller should
 * omit the probe entirely rather than pass an empty argv.
 */
export function createDriftProbe(options: DriftProbeOptions): DriftProbe {
  const launchArgv = [...options.launchArgv];
  const readArgv = options.readArgv ?? processArgv;
  /**
   * The command line of the pid we last read SUCCESSFULLY, so `ps` runs once
   * per process. Only successes are cached: a failed read is a gap in what we
   * know, and caching it would turn one timed-out `ps` into a check that never
   * runs again for that process — silently, since `unknown` renders nothing.
   */
  let cache: { pid: number; argv: string } | null = null;
  /** Consecutive failed reads of the current pid, and the polls left to skip. */
  let failure: { pid: number; consecutive: number; skip: number } | null = null;

  return async (pid: number | null): Promise<LaunchDrift> => {
    if (pid === null) {
      // A pid we never resolved is not evidence about the flags. Both caches go
      // with it: a pid is reused, so the next one is a different process.
      cache = null;
      failure = null;
      return unknownLaunchDrift("the listening process could not be identified");
    }
    if (cache !== null && cache.pid !== pid) cache = null;
    if (failure !== null && failure.pid !== pid) failure = null;

    if (cache !== null) return diffLaunchArgv(launchArgv, cache.argv);
    if (failure !== null && failure.skip > 0) {
      // Backing off, not giving up: the read is retried once the skips run out.
      failure.skip -= 1;
      return unknownLaunchDrift("the launch command line could not be read");
    }

    let argv: string | null;
    try {
      argv = await readArgv(pid);
    } catch {
      argv = null;
    }
    if (argv === null) {
      // A timed-out `ps`, an EAGAIN, or the window between `lsof` finding the
      // port and the process being inspectable while it starts up: all
      // transient, all worth another look on a later poll.
      const consecutive = (failure?.consecutive ?? 0) + 1;
      failure = { pid, consecutive, skip: Math.min(consecutive - 1, MAX_RETRY_SKIP) };
      return unknownLaunchDrift("the launch command line could not be read");
    }

    failure = null;
    cache = { pid, argv };
    return diffLaunchArgv(launchArgv, argv);
  };
}
