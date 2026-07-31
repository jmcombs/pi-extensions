/**
 * A {@link StewardDataSource} that shows live CONFIG, MODELS and SLOTS over an
 * otherwise simulated dashboard, and performs load/unload for real.
 *
 * It is composite: it holds a `fallback` (the mock) and delegates the panels it
 * does not own yet — the host-metrics band, requests, throughput history, and the
 * log console — straight to it, overriding `config`, `service`, `models`, and
 * `slots` with what a real `llama-server` reports. This is a step in a gradual
 * mock→live migration; the remaining panels stay simulated until later phases.
 *
 * Reading the server must never throw or hang the dashboard: it is not always
 * up, and that is a state to show, not an error to crash on. Every failure —
 * connection refused, timeout, a 401, any non-2xx, a malformed body — degrades
 * that section honestly while the fallback keeps every other panel animating. A
 * per-model read that fails drops only that model's slots and rate, never the
 * whole snapshot.
 *
 * `setModel` is the exception: an operator action that fails is an error to
 * surface, so it rejects with a message rather than swallowing it. It does not
 * wait for the model to finish loading — the POST returns while the child is
 * still spawning, and the poll layer watches the status reach its terminal
 * value.
 *
 * Keep this module free of Node and DOM APIs: `fetch`, `AbortController`, and
 * `AbortSignal` are all cross-runtime globals.
 */

import type { ConsentDrift, DriftProbe, DriftState, LaunchDrift } from "./drift.js";
import { NO_CONSENT_DRIFT, unknownLaunchDrift } from "./drift.js";
import type { HostMetricsProvider } from "./host-metrics.js";
import { parseRouterConfig } from "./llama-config.js";
import type { LlamaConnection } from "./llama-connection.js";
import { listenAddress } from "./llama-connection.js";
import { parseModelPorts, parseModels } from "./llama-models.js";
import { parseMetrics, parseSlots } from "./llama-slots.js";
import { createSlotActivity, type SlotActivity, type SlotActivityState } from "./slot-activity.js";
import type { LogAttachment, StewardDataSource, Unsubscribe } from "./source.js";
import {
  type ConfigEntry,
  type HostMetrics,
  type LogLine,
  type LogStreamStatus,
  type MemoryTopology,
  type ModelAction,
  type ModelInfo,
  type ServiceAction,
  type ServiceInfo,
  type SlotInfo,
  type Snapshot,
  THROUGHPUT_HISTORY_SIZE,
  THROUGHPUT_SAMPLE_SECONDS,
} from "./types.js";

/** The local process behind the server, for facts HTTP does not expose. */
export interface ServiceProcess {
  pid: number;
  /** Epoch ms the process started, or null when the probe cannot read it. */
  startedAt: number | null;
}

/**
 * Resolves the OS process listening on a host:port. Node-side and
 * platform-specific (it shells out), so it is injected rather than imported here
 * — this module stays free of Node APIs. Returns null when nothing is found.
 */
export type ServiceProbe = (host: string, port: number) => Promise<ServiceProcess | null>;

/**
 * The outcome of one control command. `ok` reports only that the command ran
 * and reported success — NOT that the service reached the state the operator
 * asked for. A launchd job with `KeepAlive`, for instance, exits 0 from a stop
 * and is relaunched a moment later. The snapshot poll (`/props` reachability)
 * is the source of truth; this is just the command's own verdict.
 */
export interface ServiceControlResult {
  ok: boolean;
  /** A readable reason when `ok` is false (permission denied, not found, …). */
  detail: string | null;
}

/**
 * Runs the operator's declared start/stop/restart commands. Node-side and
 * platform-specific (it executes a program), so it is injected rather than
 * imported here — this module stays free of Node APIs. See
 * `server/service-control.ts` for the real one.
 */
export interface ServiceController {
  /**
   * The actions this machine has a declared, consented command for, in
   * start/stop/restart order. Rides onto {@link ServiceInfo.controls} so the
   * dashboard offers exactly what can actually run.
   */
  readonly actions: readonly ServiceAction[];
  /**
   * Runs one action. Never rejects: a non-zero exit, a timeout, a missing
   * binary, or an action with no command all resolve as a failure carrying a
   * readable detail.
   */
  run(action: ServiceAction): Promise<ServiceControlResult>;
}

/**
 * Follows the running server's log and hands the console real lines.
 *
 * Node-side (it reads a file, or shells out to a journal), so it is injected
 * rather than imported here — this module stays free of Node APIs. See
 * `server/log-tailer.ts` for the file implementation. With none configured, the
 * log console keeps delegating to the fallback source exactly as before.
 */
export interface LogTailer {
  /** The most recent lines the tailer holds, oldest first. */
  recent(limit: number): LogLine[];
  /** Streams every line read after this call. */
  subscribe(listener: (line: LogLine) => void): Unsubscribe;
  /**
   * The backlog and the subscription in one step. Backlog and live tail come
   * from one offset, so this — and only this — delivers every line exactly once:
   * a poll landing between a separate `recent` and `subscribe` would put its
   * lines in neither.
   */
  attach(listener: (line: LogLine) => void, limit: number): LogAttachment;
  /**
   * Refreshes the port→model map the tailer attributes child lines with. The
   * router prefixes child lines with `[port]` and nothing else, and the log's own
   * mapping line is written once per load — so the live `/models` body, which
   * carries each loaded model's `--port`, is the reliable source.
   */
  setPorts(ports: ReadonlyMap<number, string>): void;
  /** Whether the source is connected, and how it failed when it is not. */
  status(): LogStreamStatus;
  /** Releases timers and file handles. */
  close(): void;
}

/**
 * The minimal HTTP surface Steward uses. The global `fetch` satisfies it, and a
 * test can supply a stub without standing up a server — narrower than the DOM
 * `fetch` type on purpose. `text()` is here for the Prometheus `/metrics` body.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>;

/**
 * The live host-metrics overlay: a collector to read the readings off, the
 * machine's static memory topology (from `steward.json`, it picks the gauge
 * SET), and the staleness horizon. Injected together and only when the operator
 * has configured AND consented to a collector; absent, the HOST band keeps
 * delegating to the fallback exactly as before.
 */
export interface HostMetricsOverlay {
  /** The running collector. Owned and closed by this source. */
  provider: HostMetricsProvider;
  /** Static machine memory layout, overlaid onto {@link Snapshot.memoryTopology}. */
  topology: MemoryTopology;
  /**
   * A sample whose arrival is older than this (typically `3 × intervalMs`) is
   * treated as unavailable: its readings are nulled rather than held, so the
   * band never shows a dimmed-old number — n/a is honest, a stale figure is not.
   */
  staleMs: number;
}

/**
 * The parts of the live source that `steward.json` decides — and that it can
 * therefore gain, change, or lose while the dashboard is open.
 *
 * They are grouped because they are swapped together, by
 * {@link LlamaSource.reconfigure}. An ABSENT key means "this machine has none",
 * never "keep what you had": a source still serving a collector the config
 * stopped declaring is serving a config that is gone, which is the same
 * dishonesty as a held-stale reading.
 *
 * IDENTITY is the swap protocol for the two parts that own an OS resource. Hand
 * back the same {@link HostMetricsOverlay.provider} — or the same
 * {@link LogTailer} — and the source leaves the running one completely alone;
 * hand back a different one, or none, and the source closes what it held. That
 * is what keeps a `steward.json` rewrite whose collector is unchanged from
 * dropping the metrics stream and re-running the collector's warmup, while a
 * rewrite that really does change the command still stops the old child.
 */
export interface LlamaLiveParts {
  /**
   * Runs the operator's declared start/stop/restart commands. Injected (it is
   * Node-side) and present only when `steward.json` declares control commands
   * the operator has consented to. Omitted, {@link LlamaSource.setService}
   * keeps delegating to the fallback and the block offers no controls.
   */
  control?: ServiceController;
  /**
   * The live host-metrics collector and its topology. Omitted, the HOST band
   * (memory topology and sensors) rides through from the fallback unchanged.
   */
  host?: HostMetricsOverlay;
  /**
   * Re-reads the launch argv of the process behind {@link ServiceInfo.pid} and
   * diffs it against the one `steward.json` recorded. Injected (it is Node-side
   * and platform-specific) and present only when the config carries a
   * `llama.launchArgv` to compare against; omitted, the snapshot reports drift
   * `unknown` — the check is unavailable, which is not the same as passing it.
   * It needs {@link LlamaSourceOptions.probeService} to have found a pid, so
   * without a service probe the check reports itself unavailable too.
   */
  probeDrift?: DriftProbe;
  /**
   * Commands `steward.json` declares but has not approved, computed from the
   * config each time it is read. Omitted, nothing is reported as unapproved —
   * which is also the honest answer once there is no config to declare anything.
   */
  consentDrift?: ConsentDrift;
  /**
   * The machine's memory layout as `steward.json` declares it, independent of
   * whether a collector was consented.
   *
   * This used to ride along with {@link LlamaLiveParts.host}, so a config
   * declaring `discrete` was ignored unless its collector had also been
   * approved — and the dashboard then drew whatever topology the fallback
   * happened to carry. Topology is a static fact about the hardware, not a
   * reading, so it is known the moment the config is read.
   */
  topology?: MemoryTopology;
  /**
   * The live log tail, owned and closed by this source. Present only when a log
   * source was discovered (see `server/log-tailer.ts`); omitted, the console
   * keeps delegating to the fallback exactly as it does today rather than
   * showing an empty panel with no explanation.
   */
  logTail?: LogTailer;
}

export interface LlamaSourceOptions extends LlamaLiveParts {
  /** Where to read the server. */
  connection: LlamaConnection;
  /** The source every non-live fact comes from; owned and closed by this one. */
  fallback: StewardDataSource;
  /** HTTP transport. Defaults to the global `fetch`; injected in tests. */
  fetch?: FetchLike;
  /**
   * Resolves the OS process behind the connection, for the SERVICE panel's real
   * pid and uptime — facts llama-server does not report over HTTP. Injected
   * (it is Node-side and platform-specific); omitted, pid and uptime read n/a
   * while the live/stopped state still comes through.
   */
  probeService?: ServiceProbe;
  /**
   * Subscribes this source to later versions of its {@link LlamaLiveParts} —
   * the `steward.json` watcher (`server/config-wiring.ts`), injected because
   * watching a file is Node-side. It is handed this source's own
   * {@link LlamaSource.reconfigure} and returns the unsubscribe, which
   * {@link LlamaSource.close} calls FIRST: nothing may hand a freshly spawned
   * collector to a source that has stopped being able to close one.
   *
   * Omitted, the parts this source was constructed with are the ones it keeps —
   * which is what every test that does not care about re-wiring gets.
   */
  rewire?: (apply: (parts: LlamaLiveParts) => void) => Unsubscribe;
}

/** How long to wait on any one call before treating the server as unreachable. */
const CALL_TIMEOUT_MS = 4000;

/**
 * The cadence at which a throughput sample is appended to the rolling history.
 * llama.cpp reports an instantaneous rate, not a series, so Steward accumulates
 * one, at the same cadence the mock uses so the sparkline's two-minute axis is
 * true. Gating on the snapshot clock (not the call count) keeps the window at
 * that span regardless of how many clients are polling.
 */
const THROUGHPUT_SAMPLE_MS = THROUGHPUT_SAMPLE_SECONDS * 1000;

/**
 * The span the sparkline claims to show — its sample count times its cadence,
 * so the two can never drift apart. A history whose newest sample is older than
 * this no longer describes that window and is discarded rather than displayed.
 */
const THROUGHPUT_WINDOW_MS = THROUGHPUT_HISTORY_SIZE * THROUGHPUT_SAMPLE_MS;

/**
 * How much of the tailer's buffer is folded into slot state when the source
 * starts. The tailer holds 500 lines, so this takes all of it: a Steward that
 * starts mid-flight then knows what every slot was doing as of the newest line
 * in the file, instead of waiting for the next request to tell it.
 */
const ACTIVITY_BACKLOG = 500;

/**
 * How much history an open console is handed when the log source underneath it
 * changes. The same window the API route replays to a console that connects
 * fresh, for the same reason: it is what the client's buffer holds.
 */
const CONSOLE_REPLAY_LINES = 200;

export class LlamaSource implements StewardDataSource {
  readonly name = "llama.cpp";

  readonly #connection: LlamaConnection;
  readonly #fallback: StewardDataSource;
  readonly #fetch: FetchLike;
  readonly #probeService: ServiceProbe | null;
  // Every part `steward.json` decides is mutable, because the artifact is: the
  // operator can run `/initialize-steward` — or delete the file — with the
  // dashboard open, and `reconfigure` swaps these in place rather than making
  // them wait for a new Pi session.
  /** The declared control commands, or null when none are configured/consented. */
  #control: ServiceController | null;
  /** The live host-metrics overlay, or null when no collector is configured. */
  #host: HostMetricsOverlay | null;
  /** The launch-argv re-check, or null when nothing was recorded to check. */
  #probeDrift: DriftProbe | null;
  /** Declared-but-unapproved commands, as of the config we last read. */
  #consentDrift: ConsentDrift;
  /** Declared memory layout from `steward.json`, or null when none is declared. */
  #topology: MemoryTopology | null = null;
  /** The live log tail, or null when no log source was discovered. */
  #logTail: LogTailer | null;
  /**
   * Slot occupancy folded from the log, or null when there is no log to fold.
   *
   * Its presence is the either/or: with it, SLOTS and the request/throughput
   * figures come from events and the per-model `/slots` and `/metrics` polls do
   * not run at all; without it they are the only way to know anything and run
   * exactly as they always did. Never both — running the timers alongside the
   * event stream would keep every line of the noise this exists to remove.
   */
  #activity: SlotActivity | null;
  /** Detaches {@link #activity} from the tailer; null when there is no tail. */
  #detachActivity: Unsubscribe | null;
  /**
   * The consoles listening to this source, held HERE rather than on whatever is
   * feeding them.
   *
   * A browser's log stream is opened once and lives for as long as the tab does,
   * so subscribing it straight to the tailer would end the moment the tailer was
   * replaced: the console would go quiet while `logStatus()` cheerfully reported
   * a healthy new source. The subscribers belong to the source, which keeps one
   * upstream subscription and re-points it at each swap — so a console opened
   * before `/initialize-steward` ran is reading the real log a moment after it
   * did, without being reopened.
   */
  readonly #logListeners = new Set<(line: LogLine) => void>();
  /** Detaches the fan-out from whatever currently feeds it (a tail, or the fallback). */
  #detachLogFeed: Unsubscribe | null = null;
  /**
   * Which log source the console is being fed from, bumped on every swap and
   * stamped onto every line that leaves here.
   *
   * `LogLine.seq` is monotonic per SOURCE, and a swap changes the source: the
   * file tailer anchors on a 256 KB backlog window as it opens, so a
   * replacement's counter is already in the thousands before it delivers a
   * line, and the fallback's starts from its own base. Without this the client
   * would read those numbers as ordinary progress and append — quietly showing
   * one buffer of two different logs, with nothing on screen to say so.
   */
  #logGeneration = 0;
  /** Stops the `steward.json` watcher; null when nothing is watching. */
  #stopRewire: Unsubscribe | null = null;
  /** Set by {@link close}, so nothing can be handed to a spent source. */
  #closed = false;
  /**
   * Every collector and tailer this source has closed.
   *
   * The swap protocol is identity-based, so "have I already released this one?"
   * is a question with an exact answer, and this is it. It matters because the
   * resources on the other side of it are a detached PROCESS GROUP and an open
   * file handle: closing one twice is not obviously harmless (the collector's
   * own `close` happens to guard, but a source must not depend on its callee to
   * make its accounting true), and closing one never leaks a process.
   */
  readonly #released = new WeakSet<object>();
  /** In-flight reads and actions, aborted on {@link close}. */
  readonly #inFlight = new Set<AbortController>();
  /**
   * Closed throughput samples, oldest first — the band's sparkline, measured
   * from generated tokens. Used on the event path only.
   */
  readonly #samples: ThroughputSample[] = [];
  /**
   * Tokens drained from the tracker that the open sample has not closed over
   * yet. Snapshots arrive faster than samples close (and from every connected
   * browser), so the ledger is drained every snapshot and banked here.
   */
  #pendingTokens = 0;
  /**
   * Rolling `/metrics` gauge readings, oldest first — the same sparkline on the
   * POLLING path, where tokens cannot be counted and a sampled gauge is all
   * there is.
   */
  readonly #gaugeHistory: number[] = [];
  /** Snapshot clock at the last closed sample, so sampling stays time-paced. */
  #lastSampleAt = 0;
  /**
   * The log source's health at the previous snapshot, so a change of state can
   * be treated as a break in the event stream. Null before the first snapshot.
   */
  #lastLogSource: string | null = null;

  constructor(options: LlamaSourceOptions) {
    this.#connection = options.connection;
    this.#fallback = options.fallback;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#probeService = options.probeService ?? null;

    // The config-driven parts start empty and are installed through the same
    // path every later change takes, so a source that is built with a collector
    // and one that gains a collector an hour later are wired identically —
    // there is no construction-only branch to fall out of step.
    this.#control = null;
    this.#host = null;
    this.#probeDrift = null;
    this.#consentDrift = NO_CONSENT_DRIFT;
    this.#topology = null;
    this.#logTail = null;
    this.#activity = null;
    this.#detachActivity = null;
    this.reconfigure(options);
    // `reconfigure` pointed the console's fan-out at a tail if the config named
    // one. With no tail it is the fallback's simulated lines the console shows,
    // and the fan-out has to be pointed at those from here.
    if (this.#detachLogFeed === null) this.#feedConsole();

    // Subscribed last, so the first parts this source ever sees are the ones it
    // was constructed with, and a watcher that fires synchronously on subscribe
    // cannot reach a half-built source.
    this.#stopRewire = options.rewire?.((parts) => this.reconfigure(parts)) ?? null;
  }

  /**
   * Installs a new set of config-driven parts — what `steward.json` says about
   * this machine, as of now.
   *
   * This is the whole of Steward's answer to an artifact that changes under it.
   * `/initialize-steward` can be run, re-run, or its output deleted while the
   * dashboard is open, and each of those has to take effect on the next repaint
   * rather than on the next Pi session: a collector appears, a log path moves,
   * a control command loses its consent hash, the file is removed entirely.
   *
   * Two rules make that safe. Every part is REPLACED, never merged — an absent
   * part means this machine has none, so a config that is gone takes its
   * collector, its buttons and its drift baseline with it instead of leaving
   * them running on an approval that no longer exists. And a part that owns an
   * OS resource is closed when it is replaced by a different one, which is why
   * the caller must hand back the SAME provider/tailer instance for anything it
   * decided not to rebuild (see {@link LlamaLiveParts}) — the collector is a
   * detached process group, and dropping a reference to one leaks a process.
   */
  reconfigure(parts: LlamaLiveParts): void {
    if (this.#closed) {
      // A source that can no longer serve anything must still not leak what it
      // is handed. The watcher is stopped before this can happen, so it is
      // insurance and not a path — but the thing it would leak is a process
      // group. {@link #release} makes it exact in both directions: a resource
      // this source already closed is not closed again, and one it has never
      // seen is closed once however many times it arrives.
      this.#release(parts.host?.provider);
      this.#release(parts.logTail);
      return;
    }
    // Neither of these owns a resource: control is argv the executor re-reads
    // per action, drift is a probe holding a per-pid cache and a plain record.
    this.#control = parts.control ?? null;
    this.#probeDrift = parts.probeDrift ?? null;
    this.#consentDrift = parts.consentDrift ?? NO_CONSENT_DRIFT;
    this.#topology = parts.topology ?? null;
    this.#swapHost(parts.host ?? null);
    this.#swapTail(parts.logTail ?? null);
  }

  /**
   * Swaps the host-metrics overlay, closing the collector only when the
   * PROVIDER itself changed.
   *
   * The overlay object and the collector inside it have separate lifetimes on
   * purpose: an operator who edits `memoryTopology` (or whose collector cadence
   * is unchanged but whose file was rewritten) gets a new overlay around the
   * same running child, and the metrics stream never breaks. Killing and
   * respawning it would blank the HOST band for the length of the collector's
   * warmup — n/a readings that describe nothing but Steward's own churn.
   */
  #swapHost(next: HostMetricsOverlay | null): void {
    const previous = this.#host;
    this.#host = next;
    if (previous !== null && previous.provider !== next?.provider) {
      this.#release(previous.provider);
    }
  }

  /** Closes a collector or a tailer, once, ever. */
  #release(resource: { close(): void } | null | undefined): void {
    if (resource === null || resource === undefined) return;
    if (this.#released.has(resource)) return;
    this.#released.add(resource);
    resource.close();
  }

  /**
   * Swaps the log tail, and with it everything that was derived from the old
   * one.
   *
   * A tail that is replaced (the path moved) or removed (the config that named
   * it is gone) is a break in the event stream, not a continuation of it: the
   * slot tracker's occupancy came from lines of a file we have stopped reading,
   * and the throughput ledger's banked tokens were counted from it. Both are
   * dropped, exactly as {@link #syncActivity} drops them when the file itself
   * goes missing — the strip empties and refills rather than straddling the gap
   * with samples that understate a window they claim to measure.
   */
  #swapTail(next: LogTailer | null): void {
    const previous = this.#logTail;
    if (previous === next) return;

    this.#detachActivity?.();
    this.#detachActivity = null;
    this.#activity = null;
    this.#logTail = next;
    // The console is about to start hearing a different source, whose sequence
    // numbers have nothing to do with the ones it holds. Saying so is the only
    // thing that stops the client merging two logs into one buffer.
    this.#logGeneration += 1;
    // Re-pointed before the old tailer is closed, so no console is ever
    // subscribed to something that has stopped reading.
    this.#feedConsole();
    this.#release(previous);
    // And handed the new source's own recent history in the same breath, so a
    // console that was open across the swap shows the new log rather than
    // refilling one line at a time from whatever happens next.
    this.#replayToConsoles();

    if (next !== null) {
      const activity = createSlotActivity();
      // `attach` hands back the backlog and registers the listener with no
      // suspension point between them, and folding the backlog immediately
      // after — synchronously, before the tailer's next poll can run — means
      // every line is folded exactly once and in order. Attaching here rather
      // than on the first snapshot means occupancy is tracked from the moment
      // the tail exists: a request that starts and finishes before the browser
      // has even connected is still accounted for.
      const attachment = next.attach((line) => activity.observe(line), ACTIVITY_BACKLOG);
      for (const line of attachment.backlog) activity.observe(line);
      this.#activity = activity;
      this.#detachActivity = attachment.unsubscribe;
    }

    // Both throughput paths reset: the swap also decides WHICH of them runs, and
    // carrying either series across it would plot one measurement under the
    // other's axis.
    this.#samples.length = 0;
    this.#gaugeHistory.length = 0;
    this.#pendingTokens = 0;
    this.#lastSampleAt = 0;
    this.#lastLogSource = null;
  }

  async snapshot(): Promise<Snapshot> {
    // The fallback owns every panel we have not moved yet and is the dashboard's
    // data spine. The live reads are fully guarded and never reject, so they can
    // only ever add the overlay — never be the reason a repaint fails. Config
    // and the model list are independent, so fetch them alongside the fallback
    // rather than serialising. (A fallback that itself fails is the spine
    // failing; the server turns that into a 5xx and the client retries, which
    // beats painting invented panels over a dead source.)
    const [base, props, modelsRaw] = await Promise.all([
      this.#fallback.snapshot(),
      this.#readProps(),
      this.#getJson("/models"),
    ]);

    // The log console attributes a child line by the `[port]` the router
    // prefixed it with, and this body is where the ports are: one refresh per
    // snapshot keeps the map right across load/unload cycles without the tailer
    // needing an HTTP client of its own. The same map is what joins a tracked
    // port back to the model whose slots it is, so it is parsed once and used
    // for both.
    const ports = parseModelPorts(modelsRaw);
    // `setPorts` is deliberately given the empty map from a failed read: the
    // tailer MERGES, so an empty map is a no-op there and cannot blank out
    // attribution. The tracker replaces, so it is told the difference instead.
    this.#logTail?.setPorts(ports);
    this.#syncActivity(modelsRaw === undefined ? null : ports);

    const config = this.#configFromProps(props);
    const service = await this.#serviceFromProps(props);
    const { models, slots, throughputTps, requestsInFlight, requestsQueued } =
      await this.#readModelsAndSlots(modelsRaw, ports, base.now);
    // The two paths measure different things and say so. With a log there are
    // token counts to divide by wall clock, which is throughput; without one
    // there is only llama.cpp's own rate gauge, sampled.
    const activity = this.#activity;
    const throughput =
      activity === null
        ? this.#sampleGauge(base.now, throughputTps)
        : this.#sampleGenerated(base.now, activity);
    // When a collector is configured, the HOST band is live: its topology comes
    // from `steward.json` and its readings from the collector's latest sample.
    // With no collector, the band — including `memoryTopology` — rides through
    // from the fallback via `...base`, exactly as before.
    const host = this.#overlayHost(base);
    const drift = await this.#readDrift(service);
    return {
      ...base,
      config,
      service,
      drift,
      models,
      slots,
      throughputTps: throughput.tps,
      throughputHistory: throughput.history,
      throughputWindowSeconds: throughput.windowSeconds,
      requestsInFlight,
      requestsQueued,
      ...host,
    };
  }

  /**
   * The live HOST band, or an empty overlay (`{}`) when no collector is
   * configured — leaving the fallback's `metrics` and `memoryTopology` in place.
   *
   * With a collector: `memoryTopology` is the machine's static config, and the
   * sensors are the latest validated sample. A sample older than the staleness
   * horizon, or no sample yet, nulls every reading (`NaN` for the always-present
   * figures, `null` for temperatures) so Phase 1's dashed/hatched gauges show it
   * honestly — a held-stale number is never shown.
   */
  #overlayHost(base: Snapshot): Partial<Snapshot> {
    // Topology first, and on its own: a config that declares `discrete` is
    // telling us about the hardware, which is true whether or not its collector
    // was ever approved. Without this the fallback's topology won and the
    // dashboard drew the wrong gauges on a correctly configured machine.
    const declared: Partial<Snapshot> =
      this.#topology === null ? {} : { memoryTopology: this.#topology };
    if (this.#host === null) return declared;
    const sample = this.#host.provider.latest();
    const fresh = sample !== null && base.now - sample.receivedAt <= this.#host.staleMs;
    const metrics: HostMetrics = fresh
      ? {
          vramUsedGB: finiteOr(sample.reading.vramUsedGB, Number.NaN),
          vramTotalGB: finiteOr(sample.reading.vramTotalGB, Number.NaN),
          ramUsedGB: finiteOr(sample.reading.ramUsedGB, Number.NaN),
          ramTotalGB: finiteOr(sample.reading.ramTotalGB, Number.NaN),
          gpuUtil: finiteOr(sample.reading.gpuUtil, Number.NaN),
          cpuUtil: finiteOr(sample.reading.cpuUtil, Number.NaN),
          gpuTempC: sample.reading.gpuTempC,
          cpuTempC: sample.reading.cpuTempC,
        }
      : UNAVAILABLE_METRICS;
    return { metrics, memoryTopology: this.#host.topology };
  }

  /**
   * Whether this machine still matches what `steward.json` says about it.
   *
   * The launch check runs against the process the SERVICE block just resolved —
   * the same pid, from the same lookup, in the same snapshot — so the two can
   * never describe different processes across a restart, and the port is not
   * looked up twice. A stopped service (or one whose pid we could not resolve)
   * has nothing to re-read and reports `unknown` rather than "clean": a server
   * that is not running cannot be running the right flags. A probe that throws
   * is a failed check, never a verdict — the whole point of this field is that
   * Steward stops asserting facts it did not verify.
   *
   * Consent drift is config, not a reading: it is computed once and reported
   * every snapshot unchanged.
   */
  async #readDrift(service: ServiceInfo): Promise<DriftState> {
    const consent = this.#consentDrift;
    const probe = this.#probeDrift;
    if (probe === null) {
      return {
        launch: unknownLaunchDrift("no launch command was recorded for this machine"),
        consent,
      };
    }
    if (!service.running) {
      return { launch: unknownLaunchDrift("the service is not running"), consent };
    }
    let launch: LaunchDrift;
    try {
      launch = await probe(service.pid);
    } catch {
      launch = unknownLaunchDrift("the launch command line could not be read");
    }
    return { launch, consent };
  }

  /**
   * THROUGHPUT from the log: tokens the server generated, over the wall clock it
   * had to generate them in.
   *
   * This is what the word means, and it is the only reading of it the log can
   * support honestly. The alternative — the rate a request prints when it
   * finishes — is a real measurement of that request, but it exists in the log
   * for the 17 microseconds between `eval time` and `release`, and a dashboard
   * sampling every 1.6 s never lands inside it. Reading it that way is what this
   * replaced, and against a real 10-minute stretch of log at one request every
   * 5 s it produced 372 readings: 0 tok/s when idle, a dash when busy, not one
   * non-zero number, and 42 sparkline bars of 0 while the box generated 10,881
   * tokens. Tokens do not have that problem. They are counted once, by the
   * tracker, and they wait in its ledger until a sample closes over them.
   *
   * A sample closes no more than once per {@link THROUGHPUT_SAMPLE_MS} of
   * snapshot time, so the span the strip covers is set by the clock rather than
   * by how often — or from how many browsers — snapshots are taken (which is why
   * the axis reports the span it measured rather than the nominal one).
   *
   * Every sample is a measurement, including the ones that read 0: a span in
   * which the server generated nothing
   * really did have a throughput of nothing. That is not the fabricated zero the
   * dash exists to avoid — the dash is for a window we cannot vouch for, and it
   * is what this returns until one has closed.
   */
  #sampleGenerated(now: number, activity: SlotActivity): ThroughputReading {
    // Drained every snapshot, banked here: reading the ledger more often than
    // samples close cannot lose tokens, because it is a count and not a rate.
    this.#pendingTokens += activity.takeGeneratedTokens();
    const elapsed = now - this.#lastSampleAt;
    // Nothing here can be attributed to a span the strip is showing: either this
    // is the first snapshot (the tail's backlog can hold hours of completed
    // requests) or nobody has asked for one in longer than the window itself, so
    // the banked tokens cover an unknown stretch. Piling them into the next bar
    // would draw a spike that never happened, and keeping the old bars under an
    // axis that says "the last two minutes" is the held-stale-value dishonesty
    // this whole change set out to remove, relocated into a chart. Both are
    // dropped and the accounting starts here.
    if (this.#lastSampleAt === 0 || elapsed > THROUGHPUT_WINDOW_MS) {
      this.#samples.length = 0;
      this.#pendingTokens = 0;
      this.#lastSampleAt = now;
      return noThroughput();
    }
    if (elapsed >= THROUGHPUT_SAMPLE_MS) {
      // The sample records the span it actually covered, not the nominal one, so
      // its rate is true even when a snapshot arrived late.
      this.#samples.push({ tokens: this.#pendingTokens, spanMs: elapsed });
      this.#pendingTokens = 0;
      this.#lastSampleAt = now;
      while (this.#samples.length > THROUGHPUT_HISTORY_SIZE) this.#samples.shift();
    }
    return readThroughput(this.#samples);
  }

  /**
   * THROUGHPUT with no log: llama.cpp's own rate gauge, sampled.
   *
   * The polling path cannot count tokens. `/metrics` does carry a token counter,
   * but it is printed to five significant figures (`1.2757e+06` on a live
   * server), so a difference across one sample is quantised to steps of a
   * hundred tokens and a 90-token request is as likely to read 0 as 100. So this
   * path samples the gauge exactly as it always did, and reports no window,
   * which is how the tile knows not to claim one.
   *
   * A tick whose rate could not be measured contributes no sample at all.
   * Pushing a `0` for it would draw a trough the server never had, and holding
   * the previous bar would draw a plateau it never had either — so the series
   * stays a series of measurements, and the clock is not advanced, so the very
   * next snapshot that CAN measure takes the sample instead. A history whose
   * newest sample has fallen out of the window it claims to span is dropped, and
   * the strip renders empty — which is what "nothing was measured recently"
   * looks like.
   */
  #sampleGauge(now: number, throughputTps: number | null): ThroughputReading {
    // Checked before the append so it applies to a resumed poll loop as well as
    // to an unmeasurable stretch: in both cases the retained bars are older than
    // the window and describe a period the strip is no longer showing.
    if (this.#gaugeHistory.length > 0 && now - this.#lastSampleAt > THROUGHPUT_WINDOW_MS) {
      this.#gaugeHistory.length = 0;
    }
    if (throughputTps !== null && now - this.#lastSampleAt >= THROUGHPUT_SAMPLE_MS) {
      this.#lastSampleAt = now;
      this.#gaugeHistory.push(throughputTps);
      while (this.#gaugeHistory.length > THROUGHPUT_HISTORY_SIZE) {
        this.#gaugeHistory.shift();
      }
    }
    // A copy, so a consumer cannot mutate the live buffer.
    return { tps: throughputTps, history: [...this.#gaugeHistory], windowSeconds: null };
  }

  /**
   * The console's backlog: real lines when a log source was discovered, else the
   * fallback's simulated ones. Both come from the same buffer the live tail
   * feeds, so replaying this and then subscribing loses nothing and repeats
   * nothing.
   */
  recentLogs(limit: number): LogLine[] {
    const lines =
      this.#logTail !== null ? this.#logTail.recent(limit) : this.#fallback.recentLogs(limit);
    return lines.map((line) => this.#stamp(line));
  }

  subscribeLogs(listener: (line: LogLine) => void): Unsubscribe {
    this.#logListeners.add(listener);
    return () => {
      this.#logListeners.delete(listener);
    };
  }

  /**
   * Opens a console against whichever source is live, atomically — and keeps it
   * open across a change of source.
   *
   * The backlog is taken and the listener registered with no suspension point
   * between them, which is the guarantee that costs nothing to keep and a
   * dropped line to lose: the tailer and the mock both emit from a timer, so
   * neither can land between these two statements. What the listener is
   * registered ON is this source, not the thing currently feeding it — see
   * {@link #logListeners} — so a tail that appears or moves later reaches this
   * console without it being reopened.
   */
  attachLogs(listener: (line: LogLine) => void, limit: number): LogAttachment {
    const backlog = this.recentLogs(limit);
    this.#logListeners.add(listener);
    return {
      backlog,
      unsubscribe: () => {
        this.#logListeners.delete(listener);
      },
    };
  }

  /**
   * Points the console fan-out at whatever is live now: the tail when there is
   * one, the fallback's simulation when there is not. Exactly one upstream
   * subscription is held, and the consoles never see the seam.
   */
  #feedConsole(): void {
    this.#detachLogFeed?.();
    const emit = (line: LogLine): void => {
      const stamped = this.#stamp(line);
      for (const listener of this.#logListeners) listener(stamped);
    };
    this.#detachLogFeed =
      this.#logTail === null ? this.#fallback.subscribeLogs(emit) : this.#logTail.subscribe(emit);
  }

  /**
   * Marks a line with the source it came from. The stamp is applied here, on
   * the way out, rather than by the tailer: the tailer has no idea it is one of
   * several, and the fallback's lines need the same mark for the swap in the
   * other direction — a tail that goes away — to be legible too.
   */
  #stamp(line: LogLine): LogLine {
    return { ...line, gen: this.#logGeneration };
  }

  /**
   * Hands every open console the current source's recent history, so a swap
   * re-populates them instead of leaving them empty.
   *
   * These lines carry the new generation, so the client replaces its buffer
   * with them rather than appending — which is what makes this safe to send to
   * a console that is already showing hundreds of lines from the old source.
   */
  #replayToConsoles(): void {
    if (this.#logListeners.size === 0) return;
    for (const line of this.recentLogs(CONSOLE_REPLAY_LINES)) {
      for (const listener of this.#logListeners) listener(line);
    }
  }

  /**
   * Whether the log console is looking at anything, and what went wrong when it
   * is not.
   *
   * With no tailer configured this reports `unavailable` WHILE
   * {@link recentLogs} and {@link subscribeLogs} keep serving the fallback's
   * simulated lines — that combination is deliberate (the fallback behaviour is
   * preserved byte for byte) and the console must render it honestly: it has
   * lines, and they are not the server's. An empty console and a console that
   * was never connected are different states, and only one of them is worth an
   * operator's time.
   */
  logStatus(): LogStreamStatus {
    if (this.#logTail !== null) return this.#logTail.status();
    return {
      source: "unavailable",
      path: null,
      detail: "no llama-server log file was discovered",
    };
  }

  /**
   * Runs the operator's declared command for `action`, or — with no controller
   * configured — keeps delegating to the fallback exactly as before.
   *
   * Resolving means the command reported success, NOT that the service reached
   * the requested state: the exit code is never treated as truth (a `KeepAlive`
   * job relaunches itself after a clean stop, and a start returns long before
   * the port is listening). The caller re-polls {@link snapshot}, whose
   * `running` comes from `/props` reachability, to find out what actually
   * happened. A failed command rejects with its readable detail so the operator
   * sees "permission denied" rather than a silent no-op.
   */
  async setService(action: ServiceAction): Promise<void> {
    const control = this.#control;
    if (control === null) return this.#fallback.setService(action);
    const result = await control.run(action);
    if (!result.ok) throw new Error(result.detail ?? `${action} failed`);
  }

  /**
   * Loads or unloads a model on the router. Resolves once the server accepts the
   * request (`{"success":true}`), which is *before* a load has finished — the
   * caller polls {@link snapshot} for the status to reach its terminal value.
   * Rejects with a readable message on any non-2xx, surfacing a 404 for an
   * unknown id, so the UI can notify the operator.
   */
  async setModel(modelId: string, action: ModelAction): Promise<void> {
    const path = action === "load" ? "/models/load" : "/models/unload";
    const controller = new AbortController();
    this.#inFlight.add(controller);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
      const response = await this.#fetch(`${this.#connection.baseUrl}${path}`, {
        method: "POST",
        headers: { ...this.#authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId }),
        signal,
      });

      if (!response.ok) {
        throw new Error(`${action} failed: HTTP ${response.status}`);
      }
      const body = await response.json();
      if (!(isRecord(body) && body.success === true)) {
        throw new Error(`${action} failed: llama.cpp did not confirm`);
      }
    } finally {
      this.#inFlight.delete(controller);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Stopped first: a watcher that fired after this point would spawn a
    // collector for a source that has already released everything it owns.
    this.#stopRewire?.();
    this.#stopRewire = null;
    for (const controller of this.#inFlight) controller.abort();
    this.#inFlight.clear();
    this.#detachLogFeed?.();
    this.#detachLogFeed = null;
    this.#logListeners.clear();
    this.#detachActivity?.();
    this.#detachActivity = null;
    this.#activity = null;
    this.#release(this.#host?.provider);
    this.#release(this.#logTail);
    // Dropped as well as closed: a spent source holds nothing, and the parts it
    // is handed afterwards are judged against what it has released rather than
    // against what it happens to still be pointing at.
    this.#host = null;
    this.#logTail = null;
    this.#fallback.close();
  }

  /** The bearer header, present only when the connection carries a key. */
  #authHeaders(): Record<string, string> {
    return this.#connection.apiKey === ""
      ? {}
      : { Authorization: `Bearer ${this.#connection.apiKey}` };
  }

  /**
   * A guarded JSON GET: the parsed body, or `undefined` on any failure (non-2xx,
   * timeout, refused connection, unreadable body). Callers turn `undefined` into
   * a degraded section rather than a thrown error.
   */
  async #getJson(path: string): Promise<unknown | undefined> {
    const controller = new AbortController();
    this.#inFlight.add(controller);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
      const response = await this.#fetch(`${this.#connection.baseUrl}${path}`, {
        headers: this.#authHeaders(),
        signal,
      });
      if (!response.ok) return undefined;
      return await response.json();
    } catch {
      return undefined;
    } finally {
      this.#inFlight.delete(controller);
    }
  }

  /** A guarded text GET, for the Prometheus `/metrics` scrape. */
  async #getText(path: string): Promise<string | undefined> {
    const controller = new AbortController();
    this.#inFlight.add(controller);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
      const response = await this.#fetch(`${this.#connection.baseUrl}${path}`, {
        headers: this.#authHeaders(),
        signal,
      });
      if (!response.ok) return undefined;
      return await response.text();
    } catch {
      return undefined;
    } finally {
      this.#inFlight.delete(controller);
    }
  }

  /**
   * Keeps the tracker attached to reality: children that have exited are
   * forgotten, and a change in the log source's own health is treated as a break
   * in the event stream.
   *
   * The health transition is the honest half of re-sync. When the file is
   * deleted (macOS unlinks a stale `/tmp` log daily) and later recreated, lines
   * were lost in between and there is no way to know which — so nothing is
   * carried across it. What that does NOT catch is the tailer re-anchoring on a
   * file that stayed readable throughout (a truncate, a same-second replace),
   * which is invisible from out here; the staleness bound inside the tracker is
   * what covers that case, and it resolves to `unknown` rather than guessing.
   *
   * `ports` is `null` when the `/models` read itself failed, and that case must
   * not be confused with "no models are loaded". Both parse to an empty map, but
   * one is news and the other is the absence of news: retaining against a failed
   * read would drop every port record on a single 4 s timeout against a busy
   * router, discarding all slot state and forcing a fresh `/slots` read for every
   * model — turning a flapping `/models` into exactly the per-snapshot polling
   * this replaced.
   */
  #syncActivity(ports: ReadonlyMap<number, string> | null): void {
    const activity = this.#activity;
    if (activity === null) return;
    const source = this.#logTail?.status().source ?? null;
    if (this.#lastLogSource !== null && source !== this.#lastLogSource) {
      activity.resync();
      // The throughput window goes with the tracker's state. Lines were lost, so
      // the tokens generated across the break were not counted and the samples
      // that straddle it understate a span they claim to measure. Resetting the
      // clock to 0 makes the next snapshot start the accounting over: the strip
      // empties and refills, which is what "we lost the stream" looks like.
      this.#samples.length = 0;
      this.#pendingTokens = 0;
      this.#lastSampleAt = 0;
    }
    this.#lastLogSource = source;
    if (ports === null) return;
    // A model that was unloaded takes its port's slot and task numbering with
    // it; a model reloaded on a fresh port must not inherit either.
    activity.retain(ports.keys());
  }

  /**
   * The live `models` and flat `slots` for one snapshot — from the log when
   * there is one, and from the per-model endpoints when there is not.
   *
   * The branch is the whole point of this seam, and it is exclusive. With a log
   * source, occupancy is folded from events that the server writes anyway, and
   * the only HTTP a loaded model costs is a single `/slots` read when its child
   * first appears. With no log source there is no other way to know anything, so
   * the original per-snapshot `/slots` + `/metrics` polls run unchanged — a
   * Steward with no logging is a degraded Steward, and polling is what it has.
   */
  async #readModelsAndSlots(
    modelsRaw: unknown,
    ports: ReadonlyMap<number, string>,
    now: number,
  ): Promise<ModelsAndSlots> {
    const parsed = parseModels(modelsRaw);
    const activity = this.#activity;
    if (activity !== null) return this.#modelsFromEvents(parsed, ports, activity, now);
    return this.#modelsFromPolling(parsed);
  }

  /**
   * SLOTS from the log.
   *
   * Structure and state come from different places on purpose. How many slots a
   * model has and how big each one's context is are fixed by its launch
   * arguments — `--parallel` and `--ctx-size`, both of which `/v1/models` states
   * for loaded and unloaded models alike, and which the router answers from its
   * own memory without proxying anything or writing a line. Occupancy is the
   * only part that changes request to request, and that is what the events
   * carry.
   *
   * A slot the events have said nothing about is `unknown`, not idle, and a
   * model whose child has no port we can join to (so no events can be
   * attributed) is every slot `unknown`. That is the state the seed exists to
   * clear, and the state a lost `release` decays back into rather than sticking
   * on `busy`.
   */
  async #modelsFromEvents(
    parsed: ModelInfo[],
    ports: ReadonlyMap<number, string>,
    activity: SlotActivity,
    now: number,
  ): Promise<ModelsAndSlots> {
    const portByModel = new Map<string, number>();
    for (const [port, id] of ports) portByModel.set(id, port);

    // The one-shot seed: ONE `/slots` read per child process, taken when its
    // occupancy has never been established (it just loaded, or Steward just
    // started, or we lost track of it). `needsSeed` goes false the moment the
    // port is settled and stays false, and it is budget-capped, so a caller
    // asking on every snapshot still cannot turn this back into a poll.
    await Promise.all(
      parsed.map(async (model) => {
        if (model.status !== "resident") return;
        const port = portByModel.get(model.id);
        // `--parallel` is passed through so the tracker can tell "every lane I
        // know about is settled" from "three of this model's four lanes have
        // never been mentioned", which from inside it look identical.
        if (port === undefined || !activity.needsSeed(port, now, model.parallel)) return;
        const stamp = activity.beginSeed(port, now);
        const raw = await this.#getJson(`/slots?model=${encodeURIComponent(model.id)}`);
        // A read that failed spent one of the budget and nothing more: the slots
        // stay `unknown` and the next event establishes them.
        if (raw === undefined) return;
        activity.applySeed(
          port,
          stamp,
          parseSlots(raw, model.id).map((slot) => ({
            slot: slot.id,
            state: slot.state,
            promptTokens: slot.promptTokens,
            decoded: slot.decoded,
          })),
          now,
        );
      }),
    );

    const models: ModelInfo[] = [];
    const slots: SlotInfo[] = [];
    let busyTotal = 0;
    /** Any slot, on any model, whose occupancy we cannot state at all. */
    let uncertain = false;

    for (const model of parsed) {
      if (model.status !== "resident") {
        models.push(model);
        continue;
      }
      const port = portByModel.get(model.id);
      const tracked = port === undefined ? EMPTY_ACTIVITY : activity.resolve(port, now);
      // `--parallel` is the authority on how many lanes exist. Without it, the
      // lanes the log has actually mentioned are all we can honestly draw.
      const count = model.parallel ?? highestSlot(tracked);

      // Every figure below is scoped to THIS model and rolled up afterwards.
      // They were once declared outside the loop, which quietly made them
      // dashboard-global: one model with one unresolvable lane then dashed the
      // rate and the request count for every other model on the box, including
      // ones that were perfectly well understood.
      let busy = 0;
      let rate = 0;
      let measured = false;
      let modelUncertain = false;
      for (let id = 0; id < count; id += 1) {
        const state = tracked.get(id);
        slots.push({
          id,
          modelId: model.id,
          promptTokens: state?.promptTokens ?? null,
          // Structural, from the launch args — the same per-slot figure the
          // model card shows, so the two can never disagree.
          ctxTotal: model.ctx,
          decoded: state?.decoded ?? null,
          state: state?.state ?? "unknown",
        });
        if (state === undefined || state.state === "unknown") {
          modelUncertain = true;
          continue;
        }
        if (state.state !== "processing") continue;
        busy += 1;
        // A lane generating with no rate reading yet leaves this model's card
        // dashed — llama.cpp prints no live rate until a generation crosses 100
        // tokens AND ~3 s, so most requests never have one while they run. It
        // does not touch the band's throughput, which is measured from completed
        // tokens rather than from whatever is legible mid-request.
        if (state.rateTps !== null) {
          rate += state.rateTps;
          measured = true;
        }
      }

      busyTotal += busy;
      uncertain = uncertain || modelUncertain;
      models.push({
        ...model,
        // `active` is only ever claimed for a slot we watched take a task.
        status: busy > 0 ? "active" : "resident",
        // Structure comes from `--parallel` and nowhere else. `count` can fall
        // back to the highest lane the log happened to mention, which is a lower
        // bound inferred from traffic — fine for deciding how many rows to draw,
        // not something to state as the model's lane count.
        parallel: model.parallel,
        // A model's own rate is unaffected by what any other model is doing.
        tokensPerSecond: busy > 0 && measured ? rate : null,
      });
    }

    return {
      models,
      slots,
      // Throughput is not a per-snapshot figure on this path. It is measured
      // from the tokens the log reports generated, over the wall clock they took
      // — accounting that spans snapshots and belongs to the source, not to one
      // read of the slot table.
      throughputTps: null,
      // A lower bound is not a count. With any slot unknown the honest answer is
      // that we do not know how many requests are in flight.
      requestsInFlight: uncertain ? null : busyTotal,
      // `requests_deferred` — requests accepted and waiting for a free slot —
      // has no log line at all. The events say when a slot is taken and given
      // back, never what is queued behind it, so there is nothing to derive and
      // nothing is invented: the tile reads n/a and says why.
      requestsQueued: null,
    };
  }

  /**
   * SLOTS from the per-model endpoints — the path taken only when no log source
   * was discovered. Each loaded model gets its `/slots` and `/metrics` read
   * concurrently; a model with a busy slot is upgraded to `active` and given its
   * rate. A failure to read `/models` yields empty lists (an honest "nothing to
   * show", not the mock's invented models), and a per-model read that fails
   * drops only that model's slots and rate.
   */
  async #modelsFromPolling(parsed: ModelInfo[]): Promise<ModelsAndSlots> {
    const enriched = await Promise.all(
      parsed.map(async (model): Promise<EnrichedModel> => {
        // Only a resident model has slots to read; loading/downloading/unloaded
        // models have none yet, so we do not probe for them.
        if (model.status !== "resident") {
          return { model, slots: [], tps: 0, processing: 0, deferred: 0 };
        }

        const [slotsRaw, metricsText] = await Promise.all([
          this.#getJson(`/slots?model=${encodeURIComponent(model.id)}`),
          this.#getText(`/metrics?model=${encodeURIComponent(model.id)}`),
        ]);

        // A dropped per-model read leaves the model resident with no slots
        // rather than removing it from the list entirely.
        if (slotsRaw === undefined) {
          return { model, slots: [], tps: 0, processing: 0, deferred: 0 };
        }

        const slots = parseSlots(slotsRaw, model.id);
        const busy = slots.some((slot) => slot.state === "processing");
        const metrics = metricsText === undefined ? null : parseMetrics(metricsText);

        return {
          model: {
            ...model,
            status: busy ? "active" : "resident",
            parallel: slots.length,
            tokensPerSecond: busy ? (metrics?.tps ?? null) : null,
          },
          slots,
          // llama.cpp's rate gauge persists its last value after generation
          // ends, so a model only contributes to throughput while it is
          // actually processing — an idle model reads 0, not a stale average.
          tps: busy ? (metrics?.tps ?? 0) : 0,
          // Request gauges are live counts, taken as-is from every resident
          // model and summed for the band's requests tile.
          processing: metrics?.requestsProcessing ?? 0,
          deferred: metrics?.requestsDeferred ?? 0,
        };
      }),
    );

    return {
      models: enriched.map((entry) => entry.model),
      slots: enriched.flatMap((entry) => entry.slots),
      throughputTps: enriched.reduce((sum, entry) => sum + entry.tps, 0),
      requestsInFlight: enriched.reduce((sum, entry) => sum + entry.processing, 0),
      requestsQueued: enriched.reduce((sum, entry) => sum + entry.deferred, 0),
    };
  }

  /**
   * One guarded `/props` read, shared by CONFIG and SERVICE so the server is hit
   * once per snapshot. `status` is 0 when the server could not be reached at all
   * (refused, timeout, an aborted close) — distinct from an HTTP error it did
   * answer with. `body` is the parsed props only on a 2xx.
   */
  async #readProps(): Promise<PropsRead> {
    const controller = new AbortController();
    this.#inFlight.add(controller);
    try {
      // A dead server must not stall the metrics poll, so the read is bounded
      // by a timeout as well as by close().
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
      const response = await this.#fetch(`${this.#connection.baseUrl}/props`, {
        headers: this.#authHeaders(),
        signal,
      });
      const body = response.ok ? await response.json() : null;
      return { status: response.status, body };
    } catch {
      return { status: 0, body: null };
    } finally {
      this.#inFlight.delete(controller);
    }
  }

  /**
   * The live CONFIG rows, or a degraded block that always keeps the address in
   * view. Never throws: every failure mode maps to an honest status row.
   */
  #configFromProps(read: PropsRead): ConfigEntry[] {
    const address = listenAddress(this.#connection.baseUrl);
    if (read.status === 401) {
      return [
        { key: "status", value: "API key required — run /login llama.cpp" },
        { key: "address", value: address },
      ];
    }
    if (read.status === 0) {
      // Refused, timed out, or an aborted close — we could not reach it.
      return [
        { key: "status", value: "llama.cpp not reachable" },
        { key: "address", value: address },
      ];
    }
    if (read.body === null) {
      return [
        { key: "status", value: `llama.cpp error (HTTP ${read.status})` },
        { key: "address", value: address },
      ];
    }
    return parseRouterConfig(read.body, this.#connection.baseUrl);
  }

  /**
   * The real SERVICE panel. The service is started or it is stopped, and the
   * honest test for that is whether a process holds the port — not whether it
   * answered an HTTP request just now.
   *
   * A 2xx to `/props` proves it is started. A failure does not prove the
   * opposite: a server still loading a model, or briefly wedged, refuses
   * connections while very much running. So a failed read falls through to the
   * process probe, and only a port with nothing on it reads stopped. Reporting
   * "stopped" for a server that is up would put a Start button in front of an
   * operator whose service is already running.
   *
   * pid and uptime have no HTTP source and come from the same probe.
   */
  async #serviceFromProps(read: PropsRead): Promise<ServiceInfo> {
    const { host, port } = splitHostPort(this.#connection.baseUrl);
    const answered = read.status >= 200 && read.status < 300;
    // What the operator may do is config, not a reading: it is the same list
    // whether the server answers or not, so a stopped service can still be
    // started.
    const controls = [...(this.#control?.actions ?? [])];
    if (!answered) {
      // Nothing answered — ask the OS whether anything is listening before
      // calling it stopped.
      const holding = this.#probeService === null ? null : await this.#safeProbe(host, port);
      return {
        running: holding !== null,
        startedAt: holding?.startedAt ?? null,
        pid: holding?.pid ?? null,
        host,
        port,
        build: "",
        controls,
      };
    }
    const build =
      isRecord(read.body) && typeof read.body.build_info === "string" ? read.body.build_info : "";
    const process = this.#probeService === null ? null : await this.#safeProbe(host, port);
    return {
      running: true,
      startedAt: process?.startedAt ?? null,
      pid: process?.pid ?? null,
      host,
      port,
      build,
      controls,
    };
  }

  /** The injected probe, guarded: a probe that throws yields no pid or uptime. */
  async #safeProbe(host: string, port: number): Promise<ServiceProcess | null> {
    if (this.#probeService === null) return null;
    try {
      return await this.#probeService(host, port);
    } catch {
      return null;
    }
  }
}

/** The outcome of one `/props` read: `status` 0 means the server was unreachable. */
interface PropsRead {
  status: number;
  body: unknown | null;
}

/** The MODELS, SLOTS and band figures one snapshot resolved to. */
interface ModelsAndSlots {
  models: ModelInfo[];
  slots: SlotInfo[];
  /**
   * The aggregate rate llama.cpp's `/metrics` gauges reported — the POLLING path
   * only. The event path answers `null` here: it measures throughput from the
   * tokens the log says were generated, over the wall clock they took, and that
   * accounting spans snapshots rather than living inside one (see
   * {@link LlamaSource.snapshot}).
   */
  throughputTps: number | null;
  requestsInFlight: number | null;
  requestsQueued: number | null;
}

/** One closed throughput sample: what was generated in it, and how long it ran. */
interface ThroughputSample {
  tokens: number;
  spanMs: number;
}

/** The throughput figures one snapshot reports: the tile, the strip, the span. */
interface ThroughputReading {
  tps: number | null;
  history: number[];
  windowSeconds: number | null;
}

/** No window has been measured — the tile dashes and the strip is empty. */
function noThroughput(): ThroughputReading {
  return { tps: null, history: [], windowSeconds: null };
}

/**
 * The tile and the strip for a run of closed samples.
 *
 * The tile is the whole window's tokens over the whole window's wall clock —
 * literally the throughput of the span the strip is showing — and each bar is
 * its own sample's tokens over its own sample's span. A sample is never assumed
 * to be nominal length: the snapshot clock is the browser's, so a sample closes
 * on the first snapshot past the cadence and is a little longer than it, and
 * dividing by the nominal figure would report a rate the server never reached.
 */
function readThroughput(samples: readonly ThroughputSample[]): ThroughputReading {
  if (samples.length === 0) return noThroughput();
  let tokens = 0;
  let spanMs = 0;
  const history: number[] = [];
  for (const sample of samples) {
    tokens += sample.tokens;
    spanMs += sample.spanMs;
    history.push(sample.tokens / (sample.spanMs / 1000));
  }
  return { tps: tokens / (spanMs / 1000), history, windowSeconds: spanMs / 1000 };
}

/** Shared empty result for a model whose child port we could not resolve. */
const EMPTY_ACTIVITY: ReadonlyMap<number, SlotActivityState> = new Map();

/**
 * How many lanes to draw for a model whose `--parallel` is not stated: as many
 * as the log has actually mentioned. Drawing none would hide a model that is
 * visibly working; drawing a guess would invent lanes that may not exist.
 */
function highestSlot(tracked: ReadonlyMap<number, SlotActivityState>): number {
  let highest = -1;
  for (const id of tracked.keys()) highest = Math.max(highest, id);
  return highest + 1;
}

/** One model after its live `/slots` and `/metrics` reads, before aggregation. */
interface EnrichedModel {
  model: ModelInfo;
  slots: SlotInfo[];
  /** This model's throughput contribution (0 unless a slot is processing). */
  tps: number;
  /** Requests this model's instance is processing. */
  processing: number;
  /** Requests this model's instance has deferred. */
  deferred: number;
}

/** Splits the connection's base URL into a host and a numeric port. */
function splitHostPort(baseUrl: string): { host: string; port: number } {
  try {
    const url = new URL(baseUrl);
    const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return { host: url.hostname, port };
  } catch {
    return { host: baseUrl, port: 0 };
  }
}

/** True for a non-null object we can read string-keyed fields off. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The reading if it is a real value, else the given fallback (`NaN` for a no-reading gauge). */
function finiteOr(value: number | null, fallback: number): number {
  return value === null ? fallback : value;
}

/**
 * The HOST sensors when the collector has no fresh sample: every figure is a
 * non-reading, so Phase 1's gauges dash/hatch rather than plot a fabricated 0.
 */
const UNAVAILABLE_METRICS: HostMetrics = {
  vramUsedGB: Number.NaN,
  vramTotalGB: Number.NaN,
  ramUsedGB: Number.NaN,
  ramTotalGB: Number.NaN,
  gpuUtil: Number.NaN,
  cpuUtil: Number.NaN,
  gpuTempC: null,
  cpuTempC: null,
};
