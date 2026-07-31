/**
 * Keeps the live source wired to whatever `steward.json` says RIGHT NOW.
 *
 * The artifact is written by `/initialize-steward`, and an operator runs that
 * with the dashboard open — which is the whole point of a setup flow. Read once
 * at extension load, the config was baked into a closure: a machine that gained
 * a collector, a log path, control commands or a launch baseline saw none of it
 * until the next Pi session, and a machine whose config was deleted kept running
 * the collector it declared. This module is the seam that makes both take effect
 * on the next repaint instead.
 *
 * WHAT TRIGGERS A RE-READ. `fs.watch` on the config's DIRECTORY, never a timer.
 * The directory rather than the file because appearing and disappearing are the
 * two cases that matter most, and a watch on a path that does not exist yet
 * cannot be armed at all — while a rename-into-place (how any careful writer
 * updates a config) replaces the inode a file watch was holding. When the
 * directory itself is missing, the nearest existing ancestor is watched instead
 * and the watch moves down as the directories appear.
 *
 * WHAT SURVIVES A TRIGGER. `fs.watch` is chatty — a single save is routinely two
 * or three events, and a watch on an ancestor sees traffic that has nothing to do
 * with us — so every refresh first takes ONE `stat` and compares an identity
 * tuple: device, inode, mtime, ctime, size, mode and owner. Unchanged means the
 * file is not re-read, not re-parsed, and nothing is rebuilt or respawned. The
 * tuple reaches past mtime and size on purpose — a `chmod o+w` moves neither,
 * and that no-op-looking change is exactly the one the security gate exists to
 * catch.
 *
 * WHAT IT CANNOT SEE. A watch does not begin delivering the instant it is
 * created — on macOS the FSEvents stream starts on another thread — so the
 * window this misses is a change that lands between the startup READ and the
 * watch being armed a moment later, which is not a window an operator can act
 * in. A watch the platform refuses outright (some network mounts) is warned
 * about once, and the config read at startup simply stands.
 *
 * WHAT IS REBUILT. As little as possible, because rebuilding is not free: the
 * collector is a detached process group with a warmup, and respawning one drops
 * the metrics stream. So each part is keyed on the config fields it is actually
 * built from — the collector on its argv and cadence, the tailer on its path, the
 * drift probe on the recorded launch argv — and an unchanged key hands back the
 * SAME instance, which the source reads as "leave this one alone" (see
 * {@link LlamaLiveParts}). Everything else is rebuilt from the new config, so a
 * command whose consent hash went missing stops being offered, and a config that
 * failed to load takes every part down with it.
 *
 * Node-only: it stats, watches, spawns and executes. The source it feeds stays
 * free of all of that.
 */

import { type FSWatcher, watch as nodeWatch, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { DriftProbe } from "../core/drift.js";
import type { HostMetricsProvider } from "../core/host-metrics.js";
import type { LlamaLiveParts, LogTailer, ServiceController } from "../core/llama-source.js";
import type { Unsubscribe } from "../core/source.js";
import type { ServiceAction } from "../core/types.js";
import { createDriftProbe } from "./drift-probe.js";
import { createHostCollector } from "./host-collector.js";
import { createFileTailer, type LogPathConfig, resolveLogPath } from "./log-tailer.js";
import { createServiceController, type ServiceControlCommands } from "./service-control.js";
import {
  consentDrift,
  consentedControls,
  hostCollectorConsented,
  readStewardConfig,
  type StewardConfig,
  stewardConfigPath,
} from "./steward-config.js";

/**
 * How long a burst of filesystem events is allowed to settle before the config
 * is re-read.
 *
 * This is not a poll — nothing is scheduled until an event arrives — but it does
 * two useful things when one does. A save is several events, and coalescing them
 * costs one `stat` instead of three. More importantly, a writer that truncates
 * and then writes (rather than renaming into place) is briefly holding a file
 * that parses as malformed JSON, and reading it in that window would tear the
 * collector down and build it straight back up.
 */
const SETTLE_MS = 60;

/** How far up the tree the watch will climb looking for a directory that exists. */
const MAX_ANCESTORS = 3;

/**
 * How many times a watch that dies may be re-armed before Steward stops trying.
 *
 * A watch the OS drops is worth replacing — one transient EMFILE should not
 * cost the operator every later config change — but a watch that cannot stay up
 * must fail honestly rather than re-arm forever, exactly as the host collector's
 * respawn cap does. Past the cap the config read at startup simply stands, and
 * the operator is told.
 */
const MAX_WATCH_LOSSES = 3;

/** Something with a `close()`; a `fs.watch` handle satisfies it, as does a stub. */
export interface Closable {
  close(): void;
}

/**
 * Watches `directory`, calling `onEvent` for changes to `filename` within it.
 *
 * `lost` says the watch itself has ENDED and delivered its last event — the OS
 * dropped it, and the handle is already closed. It is a distinct signal because
 * a dead watch is indistinguishable from a quiet directory from the outside,
 * and a silently dead one means every later config change is missed.
 */
export type WatchDirectory = (
  directory: string,
  onEvent: (filename: string | null, lost: boolean) => void,
) => Closable;

export interface ConfigWiringOptions {
  /** The artifact to follow. Defaults to {@link stewardConfigPath}. */
  path?: string;
  /** Reads and validates the artifact. Injected in tests; defaults to the real gate. */
  read?: (path: string) => StewardConfig | null;
  /** Spawns the host collector. Injected in tests, so none is ever spawned there. */
  createCollector?: (command: string[], intervalMs: number) => HostMetricsProvider;
  /** Builds the service controller. Injected in tests. */
  createController?: (commands: ServiceControlCommands) => ServiceController;
  /** Builds the launch-argv drift probe. Injected in tests. */
  createProbe?: (launchArgv: string[]) => DriftProbe;
  /** Opens a log tail. Injected in tests, so no real file is followed there. */
  createTailer?: (path: string) => LogTailer;
  /** Resolves the log path from the config, the env, and the convention. Injected in tests. */
  resolveLog?: (config: LogPathConfig | null) => string | null;
  /** Watches a directory. Injected in tests, which trigger refreshes by hand. */
  watch?: WatchDirectory;
  /** Defers the refresh so a burst of events costs one read. Injected in tests. */
  settle?: (run: () => void) => Unsubscribe;
  /** Sink for the "cannot watch" warning. Injected in tests; defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * A live view of `steward.json`, expressed as the parts a
 * {@link import("../core/llama-source.js").LlamaSource} is built from.
 *
 * One wiring belongs to one source. It is created with the config already read
 * (so the source starts wired, not empty), and hands over ownership of
 * everything it builds: the source closes the collector and the tailer it is
 * holding, whether that happens at a swap or at its own `close()`. The wiring
 * only ever CREATES, which is what keeps a single owner for a process group.
 */
export interface ConfigWiring {
  /** The parts as of the last read — the source's constructor arguments. */
  readonly parts: LlamaLiveParts;
  /**
   * Registers the source's `reconfigure` and starts watching. The returned
   * unsubscribe stops the watcher and is called by the source's `close()`, so a
   * source that is spent can never be handed a newly spawned collector.
   */
  rewire(apply: (parts: LlamaLiveParts) => void): Unsubscribe;
}

/**
 * The cheap identity of a file: enough to say "nothing about this has changed"
 * without opening it, and `null` when it is not there at all.
 *
 * Content is deliberately not hashed. The point of this gate is that the common
 * case — a watch event that concerns some other file, or the second and third
 * events of one save — costs a single `stat` and stops there.
 *
 * The tuple is wider than a plain mtime+size for two reasons. `ctime` is what
 * catches a `chmod o+w` or a `chown`, which change neither of those and are
 * precisely the edits the security gate exists to refuse; the mode and the
 * owner ride along beside it because they are what the refusal is ABOUT, and a
 * filesystem with a coarse `ctime` should not be able to hide them. And the
 * timestamps are read in nanoseconds rather than milliseconds, which closes the
 * one blind spot a millisecond tuple has — two writes of equal size, to the
 * same inode, inside the same millisecond.
 */
function readIdentity(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return [
      stat.dev,
      stat.ino,
      stat.mtimeNs,
      stat.ctimeNs,
      stat.size,
      stat.mode,
      stat.uid,
      stat.gid,
    ].join(":");
  } catch {
    return null;
  }
}

/** True when two argvs are the same command, token for token. */
function sameCommand(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

/** The control actions, in the order the dashboard renders them. */
const CONTROL_ACTIONS: readonly ServiceAction[] = ["start", "stop", "restart"];

/** True when two consented control sets declare the same commands for the same actions. */
function sameControls(a: ServiceControlCommands, b: ServiceControlCommands): boolean {
  return CONTROL_ACTIONS.every((action) => {
    const left = a[action];
    const right = b[action];
    if (left === undefined || right === undefined) return left === right;
    return sameCommand(left, right);
  });
}

/** The default directory watch: non-persistent, so it never holds the process open. */
function watchDirectory(
  directory: string,
  onEvent: (filename: string | null, lost: boolean) => void,
): Closable {
  const watcher: FSWatcher = nodeWatch(directory, { persistent: false }, (_event, filename) =>
    onEvent(typeof filename === "string" ? filename : null, false),
  );
  // A watch that fails — its directory removed, or a transient error on a
  // filesystem that cannot sustain one — emits an error rather than throwing,
  // and is finished afterwards. Reported as a LOSS, so the wiring replaces it
  // instead of holding a closed handle and going quietly deaf.
  watcher.on("error", () => {
    watcher.close();
    onEvent(null, true);
  });
  return watcher;
}

/** The default settle: one unref'd timer, armed by an event and never by a clock. */
function settleWithTimer(run: () => void): Unsubscribe {
  const timer = setTimeout(run, SETTLE_MS);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * The deepest existing directory at or above `directory`, within
 * {@link MAX_ANCESTORS} steps, or `null` when none of them exists.
 *
 * The climb is bounded because the point of it is a config directory that has
 * not been created yet (`~/.config/steward`), not a home directory that is
 * missing — and every step up widens the watch to files that have nothing to do
 * with Steward.
 */
function nearestExistingDirectory(directory: string): string | null {
  let current = directory;
  for (let step = 0; step <= MAX_ANCESTORS; step += 1) {
    try {
      if (statSync(current).isDirectory()) return current;
    } catch {
      // Not there — try its parent.
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export function createConfigWiring(options: ConfigWiringOptions = {}): ConfigWiring {
  const path = resolvePath(options.path ?? stewardConfigPath());
  const read = options.read ?? ((target: string) => readStewardConfig({ path: target }));
  const createCollector = options.createCollector ?? createHostCollector;
  const createController = options.createController ?? createServiceController;
  const createProbe =
    options.createProbe ?? ((launchArgv: string[]) => createDriftProbe({ launchArgv }));
  const createTailer =
    options.createTailer ?? ((target: string) => createFileTailer({ path: target }));
  const resolveLog =
    options.resolveLog ?? ((config: LogPathConfig | null) => resolveLogPath({ config }));
  const watch = options.watch ?? watchDirectory;
  const settle = options.settle ?? settleWithTimer;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  /** What each owned part was built from, so an unchanged key is not rebuilt. */
  let collector: { command: string[]; intervalMs: number; provider: HostMetricsProvider } | null =
    null;
  let tailer: { path: string; instance: LogTailer } | null = null;
  let probe: { launchArgv: string[]; instance: DriftProbe } | null = null;
  let controller: { commands: ServiceControlCommands; instance: ServiceController } | null = null;

  /**
   * The parts for one config, reusing every running part whose inputs are
   * unchanged.
   *
   * A part dropped here is NOT closed here: it is left out of the returned
   * parts, and the source closes what it was holding when it takes them. One
   * owner, one close — the alternative (closing on the way out AND on the swap)
   * is how a live collector gets killed by a config edit that did not touch it.
   */
  function build(config: StewardConfig | null): LlamaLiveParts {
    const parts: LlamaLiveParts = {};

    // Topology is declared, not measured, so it is known as soon as the config
    // is read — independent of whether the collector below was ever consented.
    // It used to ride along with `host`, which meant a config declaring
    // `discrete` was ignored until its collector was approved, and the dashboard
    // drew the wrong gauge set in the meantime.
    if (config !== null) parts.topology = config.memoryTopology;

    // The collector: keyed on its exact argv and its declared cadence, the two
    // things the running child was started with. Consent is re-checked here
    // rather than trusted from last time, so a command whose hash disappeared
    // from the artifact stops being run instead of riding on the old approval.
    if (config !== null && hostCollectorConsented(config)) {
      const { command, intervalMs } = config.hostCollector;
      if (
        collector === null ||
        collector.intervalMs !== intervalMs ||
        !sameCommand(collector.command, command)
      ) {
        collector = {
          command: [...command],
          intervalMs,
          provider: createCollector(command, intervalMs),
        };
      }
      parts.host = {
        provider: collector.provider,
        // Topology and the staleness horizon are read from the CURRENT config
        // even when the child is reused: they are facts about the machine and
        // the cadence, not state the collector holds.
        topology: config.memoryTopology,
        // Stale past 3× the collector's declared cadence — the readings drop to
        // n/a rather than being held (maintainer decision, plan H3).
        staleMs: 3 * intervalMs,
      };
    } else {
      collector = null;
    }

    // Control: per-action, and only what the operator approved. A rewritten
    // command drops out of this set until its new hash is consented to, which is
    // the security gate doing its job — and `consentDrift` below is what stops
    // that looking like a machine that was never set up.
    const commands = config === null ? {} : consentedControls(config);
    if (Object.keys(commands).length === 0) {
      controller = null;
    } else {
      if (controller === null || !sameControls(controller.commands, commands)) {
        controller = { commands, instance: createController(commands) };
      }
      parts.control = controller.instance;
    }

    // The drift baseline: keyed on the recorded argv, because that is all the
    // probe is built from. Reusing it keeps its per-pid cache, so an unrelated
    // config edit does not cost a `ps` per snapshot until it warms again.
    const launchArgv = config?.llama?.launchArgv ?? null;
    if (launchArgv === null) {
      probe = null;
    } else {
      if (probe === null || !sameCommand(probe.launchArgv, launchArgv)) {
        probe = { launchArgv: [...launchArgv], instance: createProbe(launchArgv) };
      }
      parts.probeDrift = probe.instance;
    }

    if (config !== null) parts.consentDrift = consentDrift(config);

    // The log path is not config-only: `STEWARD_LOG_FILE` and the platform
    // convention still resolve without an artifact, so losing the config does
    // not necessarily lose the console. The tailer is keyed on the resolved
    // path, so a config that changes anything else leaves the tail — and the
    // slot occupancy folded out of it — completely untouched.
    const logPath = resolveLog(config?.log ?? null);
    if (logPath === null) {
      tailer = null;
    } else {
      if (tailer === null || tailer.path !== logPath) {
        tailer = { path: logPath, instance: createTailer(logPath) };
      }
      parts.logTail = tailer.instance;
    }

    return parts;
  }

  let identity = readIdentity(path);
  let parts = build(identity === null ? null : read(path));

  let sink: ((next: LlamaLiveParts) => void) | null = null;
  let watcher: Closable | null = null;
  let watching: string | null = null;
  let cancelSettle: Unsubscribe | null = null;
  let stopped = false;
  /** Watches the OS has dropped on us, capped by {@link MAX_WATCH_LOSSES}. */
  let losses = 0;

  /**
   * One re-read, gated on the file's identity.
   *
   * The gate is the reason a chatty watcher is cheap, and the reason an event
   * that concerns some other file in the directory costs a `stat` and nothing
   * else. Past it, a config that is absent, refused (foreign owner,
   * world-writable) or malformed all arrive here as `null` — and are treated
   * identically, because in all three cases Steward has no artifact it is
   * entitled to act on and must stop acting on the last one.
   */
  function refresh(): void {
    if (stopped) return;
    const next = readIdentity(path);
    if (next === identity) return;
    identity = next;
    parts = build(next === null ? null : read(path));
    sink?.(parts);
  }

  /** Arms (or re-arms) the watch on the deepest directory that exists today. */
  function arm(): void {
    if (stopped) return;
    const directory = nearestExistingDirectory(dirname(path));
    if (directory === null) {
      warn(`[steward] cannot watch ${path} for changes: no directory above it exists`);
      return;
    }
    if (watcher !== null && watching === directory) return;
    watcher?.close();
    watcher = null;
    watching = null;
    try {
      watcher = watch(directory, (filename, lost) => onEvent(directory, filename, lost));
      watching = directory;
    } catch (error) {
      // A platform or filesystem that cannot watch (some network mounts) is a
      // degrade, not a failure: the config read at startup stands, and the
      // operator is told why a later `/initialize-steward` needs a restart.
      const detail = error instanceof Error ? error.message : String(error);
      warn(`[steward] cannot watch ${path} for changes (${detail}); a change needs a restart`);
    }
  }

  function onEvent(directory: string, filename: string | null, lost = false): void {
    if (stopped) return;
    if (lost) {
      // The handle is already closed and will send nothing more. Dropping the
      // reference is what lets `arm` replace it — a watch whose directory still
      // exists would otherwise look like one that is already in the right
      // place, and Steward would stop noticing config changes without a word.
      watcher = null;
      watching = null;
      losses += 1;
      if (losses > MAX_WATCH_LOSSES) {
        warn(
          `[steward] gave up watching ${path} after ${losses} dropped watches; ` +
            "a config change now needs a restart",
        );
        return;
      }
    }
    // Re-checked on every event, because an event is also how we learn that the
    // shape of the tree changed: the config's directory may have just been
    // created under the ancestor we settled for, or removed out from under us.
    // It costs one `stat` and is a no-op while the right directory is watched.
    arm();
    // Inside the config's own directory, only the config's own name is our news
    // — a `filename` we were not given (some platforms omit it, and the lost
    // watch above reports none) is treated as ours.
    if (directory === dirname(path) && filename !== null) {
      if (resolvePath(directory, filename) !== path) return;
    }
    cancelSettle?.();
    cancelSettle = settle(() => {
      cancelSettle = null;
      refresh();
    });
  }

  return {
    get parts(): LlamaLiveParts {
      return parts;
    },

    rewire(apply: (next: LlamaLiveParts) => void): Unsubscribe {
      sink = apply;
      arm();
      return () => {
        stopped = true;
        sink = null;
        cancelSettle?.();
        cancelSettle = null;
        watcher?.close();
        watcher = null;
        watching = null;
      };
    },
  };
}
