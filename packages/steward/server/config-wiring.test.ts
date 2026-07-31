/**
 * `steward.json` is written by a skill the operator runs WHILE the dashboard is
 * open, so every one of these exercises a transition rather than a starting
 * state: a config that appears, changes, loses its consent, becomes untrusted,
 * becomes unparseable, or is deleted.
 *
 * They drive a real {@link LlamaSource} through a real wiring over real temp
 * files — the config gate's ownership and permission checks only mean something
 * against a real file — while the four things the wiring would otherwise BUILD
 * (a collector process group, a file tailer, a control executor, a `ps` probe)
 * are stubs, so nothing is spawned, no log is followed, and the close counts are
 * observable. The maintainer's own `~/.config/steward/steward.json` is never
 * read: every wiring here is given an explicit path.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStubSource } from "../core/__fixtures__/stub-source.js";
import type { DriftProbe } from "../core/drift.js";
import type { HostMetricsProvider, HostSample } from "../core/host-metrics.js";
import {
  type LlamaLiveParts,
  LlamaSource,
  type LogTailer,
  type ServiceController,
} from "../core/llama-source.js";
import type { LogAttachment } from "../core/source.js";
import type { LogLine, LogStreamStatus, ServiceAction } from "../core/types.js";
import { type ConfigWiringOptions, createConfigWiring } from "./config-wiring.js";
import type { ServiceControlCommands } from "./service-control.js";
import { hashCommand, readStewardConfig } from "./steward-config.js";

const CONNECTION = { baseUrl: "http://127.0.0.1:8080", apiKey: "" };

const COLLECTOR = ["macmon", "pipe", "-s", "0", "-i", "1000"];
const OTHER_COLLECTOR = ["macmon", "pipe", "-s", "0", "-i", "2000"];
const LABEL = "gui/501/com.llamacpp.router";
const START = ["launchctl", "kickstart", LABEL];
const STOP = ["launchctl", "kill", "SIGTERM", LABEL];
const RESTART = ["launchctl", "kickstart", "-k", LABEL];
const LAUNCH_ARGV = ["/opt/homebrew/bin/llama-server", "--port", "8080", "--metrics"];
const LOG_PATH = "/tmp/steward-config-wiring-test.log";

/** A complete artifact: collector, control, launch record, log path, all consented. */
function fullConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memoryTopology: "unified",
    hostCollector: { command: COLLECTOR, intervalMs: 1000 },
    control: { start: START, stop: STOP, restart: RESTART },
    llama: { launchArgv: LAUNCH_ARGV, mechanism: "launchd", label: LABEL },
    log: { path: LOG_PATH },
    consent: {
      [hashCommand(COLLECTOR)]: true,
      [hashCommand(START)]: true,
      [hashCommand(STOP)]: true,
      [hashCommand(RESTART)]: true,
    },
    ...overrides,
  };
}

/** A stub collector that reports no sample and counts its closes. */
function fakeProvider(): HostMetricsProvider & { closes: number } {
  return {
    closes: 0,
    latest(): HostSample | null {
      return null;
    },
    close(): void {
      this.closes += 1;
    },
  };
}

/** A stub tailer that follows nothing and counts its closes. */
function fakeTailer(path: string): LogTailer & { path: string; closes: number } {
  const state = {
    path,
    closes: 0,
    recent(): LogLine[] {
      return [];
    },
    subscribe(): () => void {
      return () => undefined;
    },
    attach(): LogAttachment {
      return { backlog: [], unsubscribe: () => undefined };
    },
    setPorts(): void {
      // The source refreshes attribution every snapshot; nothing to record here.
    },
    status(): LogStreamStatus {
      return { source: "ok", path, detail: null };
    },
    close(): void {
      state.closes += 1;
    },
  };
  return state;
}

/** A stub controller that offers the actions it was given and runs nothing. */
function fakeController(commands: ServiceControlCommands): ServiceController {
  const actions = (["start", "stop", "restart"] as ServiceAction[]).filter(
    (action) => commands[action] !== undefined,
  );
  return {
    actions,
    run: () => Promise.resolve({ ok: true, detail: null }),
  };
}

/** Everything the wiring built, in the order it built it. */
interface Built {
  collectors: (HostMetricsProvider & { closes: number })[];
  tailers: (LogTailer & { path: string; closes: number })[];
  controllers: ServiceControlCommands[];
  probes: string[][];
  reads: string[];
  warnings: string[];
}

describe("createConfigWiring", () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "steward-wiring-"));
    path = join(directory, "steward.json");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function write(config: unknown): void {
    writeFileSync(path, JSON.stringify(config, null, 2));
  }

  /**
   * A wiring whose four builders are stubs and whose watcher is a hand-driven
   * `fire()` — so a test says exactly when the filesystem spoke, and the code
   * under test still decides whether that was worth a read.
   */
  function harness(overrides: ConfigWiringOptions = {}, uid?: () => number) {
    const built: Built = {
      collectors: [],
      tailers: [],
      controllers: [],
      probes: [],
      reads: [],
      warnings: [],
    };
    let listener: ((filename: string | null, lost: boolean) => void) | null = null;
    let watched: string | null = null;
    let closedWatches = 0;

    const wiring = createConfigWiring({
      path,
      read: (target) => {
        built.reads.push(target);
        const warn = (message: string) => built.warnings.push(message);
        // The uid the reader believes it is running as is the only half of the
        // ownership check a test can move without root.
        const current = uid?.();
        return current === undefined
          ? readStewardConfig({ path: target, warn })
          : readStewardConfig({ path: target, uid: current, warn });
      },
      createCollector: () => {
        const provider = fakeProvider();
        built.collectors.push(provider);
        return provider;
      },
      createTailer: (target) => {
        const tailer = fakeTailer(target);
        built.tailers.push(tailer);
        return tailer;
      },
      createController: (commands) => {
        built.controllers.push(commands);
        return fakeController(commands);
      },
      createProbe: (launchArgv) => {
        built.probes.push([...launchArgv]);
        const probe: DriftProbe = () =>
          Promise.resolve({
            status: "clean",
            added: [],
            removed: [],
            program: null,
            reason: null,
          });
        return probe;
      },
      // The log path comes from the artifact alone here: the real resolver also
      // consults `STEWARD_LOG_FILE` and a conventional `/tmp` path, and this
      // machine may well have both.
      resolveLog: (config) => config?.path ?? null,
      watch: (target, onEvent) => {
        watched = target;
        listener = onEvent;
        return {
          close: () => {
            closedWatches += 1;
            listener = null;
          },
        };
      },
      // Events are applied at once, so a test's assertions follow its writes.
      settle: (run) => {
        run();
        return () => undefined;
      },
      warn: (message) => built.warnings.push(message),
      ...overrides,
    });

    return {
      wiring,
      built,
      watched: () => watched,
      closedWatches: () => closedWatches,
      /** One filesystem event, as the platform would deliver it. */
      fire: (filename: string | null = "steward.json") => listener?.(filename, false),
      /** The watch itself ending — the OS dropped it and it will send nothing more. */
      loseWatch: () => listener?.(null, true),
    };
  }

  /** A live source wired to `wiring`, exactly as the extension builds it. */
  function sourceFor(wiring: ReturnType<typeof harness>["wiring"]): LlamaSource {
    return new LlamaSource({
      connection: CONNECTION,
      fallback: createStubSource({}),
      // No server is stood up: the live reads degrade, which is not what these
      // are about.
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
      ...wiring.parts,
      rewire: wiring.rewire,
    });
  }

  it("wires up a config that appears after the dashboard is already open", async () => {
    const h = harness();
    const source = sourceFor(h.wiring);
    try {
      // Cold start on a machine that has never run /initialize-steward: no
      // collector, no console, no buttons, and drift reports itself unavailable
      // rather than clean.
      expect(h.built.collectors).toHaveLength(0);
      expect(h.built.tailers).toHaveLength(0);
      expect(h.built.controllers).toHaveLength(0);
      const before = await source.snapshot();
      expect(before.service.controls).toEqual([]);
      expect(before.drift.launch.status).toBe("unknown");
      expect(before.drift.consent).toEqual({ hostCollector: false, controls: [] });

      write(fullConfig());
      h.fire();

      // Everything the artifact declares, in place — without a restart.
      expect(h.built.collectors).toHaveLength(1);
      expect(h.built.tailers).toHaveLength(1);
      expect(h.built.probes).toEqual([LAUNCH_ARGV]);
      const after = await source.snapshot();
      expect(after.memoryTopology).toBe("unified");
      expect(after.service.controls).toEqual(["start", "stop", "restart"]);
      // There is a baseline to check against now, so the reason the check cannot
      // be made has moved from "nothing was recorded" to "there is no process" —
      // and it is still `unknown`, never a fabricated all-clear.
      expect(after.drift.launch.status).toBe("unknown");
      expect(after.drift.launch.reason).toBe("the service is not running");
      expect(source.logStatus()).toEqual({ source: "ok", path: LOG_PATH, detail: null });
      // The collector has produced nothing yet, and a warming collector reads
      // n/a — never a zero.
      expect(Number.isNaN(after.metrics.gpuUtil)).toBe(true);
      expect(after.metrics.cpuTempC).toBeNull();
    } finally {
      source.close();
    }
  });

  it("tears everything down when the config is deleted, and says nothing it cannot", async () => {
    write(fullConfig());
    const h = harness();
    const source = sourceFor(h.wiring);
    try {
      expect(h.built.collectors).toHaveLength(1);
      expect((await source.snapshot()).service.controls).toHaveLength(3);

      rmSync(path);
      h.fire();

      // The collector is stopped, not orphaned, and the console goes back to
      // reporting that it is looking at nothing.
      expect(h.built.collectors[0]?.closes).toBe(1);
      expect(h.built.tailers[0]?.closes).toBe(1);
      const after = await source.snapshot();
      expect(after.service.controls).toEqual([]);
      // No held-over verdicts: without a recorded argv there is nothing to check,
      // and without an artifact there is nothing declared to be unapproved.
      expect(after.drift.launch.status).toBe("unknown");
      expect(after.drift.launch.reason).toBe("no launch command was recorded for this machine");
      expect(after.drift.consent).toEqual({ hostCollector: false, controls: [] });
      expect(source.logStatus().source).toBe("unavailable");
      // And nothing was rebuilt on the way down.
      expect(h.built.collectors).toHaveLength(1);
    } finally {
      source.close();
    }
  });

  it("stops the old collector and starts the new one when the command changes", async () => {
    write(fullConfig());
    const h = harness();
    const source = sourceFor(h.wiring);
    try {
      const first = h.built.collectors[0];
      expect(first).toBeDefined();

      write(
        fullConfig({
          hostCollector: { command: OTHER_COLLECTOR, intervalMs: 1000 },
          consent: {
            [hashCommand(OTHER_COLLECTOR)]: true,
            [hashCommand(START)]: true,
            [hashCommand(STOP)]: true,
            [hashCommand(RESTART)]: true,
          },
        }),
      );
      h.fire();

      expect(h.built.collectors).toHaveLength(2);
      // The old child is not left running next to the new one: a collector is a
      // detached process group, and a leaked one is a leaked process.
      expect(first?.closes).toBe(1);
      expect(h.built.collectors[1]?.closes).toBe(0);
    } finally {
      source.close();
    }
    expect(h.built.collectors[1]?.closes).toBe(1);
  });

  it("respawns for a changed cadence, since the child was started with it", () => {
    write(fullConfig());
    const h = harness();
    const source = sourceFor(h.wiring);
    try {
      write(fullConfig({ hostCollector: { command: COLLECTOR, intervalMs: 2000 } }));
      h.fire();
      expect(h.built.collectors).toHaveLength(2);
      expect(h.built.collectors[0]?.closes).toBe(1);
    } finally {
      source.close();
    }
  });

  it("leaves the running collector alone when a rewrite does not change it", async () => {
    write(fullConfig());
    const h = harness();
    const source = sourceFor(h.wiring);
    try {
      const provider = h.built.collectors[0];
      const tailer = h.built.tailers[0];

      // A rewrite that changes the topology and the control commands, and leaves
      // the collector byte-identical. Respawning it here would drop the metrics
      // stream and re-run the collector's warmup for nothing.
      write(
        fullConfig({
          memoryTopology: "discrete",
          control: { start: START, stop: STOP, restart: ["launchctl", "kickstart", "-kp", LABEL] },
          consent: {
            [hashCommand(COLLECTOR)]: true,
            [hashCommand(START)]: true,
            [hashCommand(STOP)]: true,
          },
        }),
      );
      h.fire();

      expect(h.built.collectors).toHaveLength(1);
      expect(provider?.closes).toBe(0);
      // The tail is keyed on its path, so it is untouched too — and with it the
      // slot occupancy that was folded out of it.
      expect(h.built.tailers).toHaveLength(1);
      expect(tailer?.closes).toBe(0);
      // The parts around the child still moved: this is a swap, not a skip.
      const after = await source.snapshot();
      expect(after.service.controls).toEqual(["start", "stop"]);
      expect(after.drift.consent).toEqual({ hostCollector: false, controls: ["restart"] });
    } finally {
      source.close();
    }
  });

  it("swaps the log tail when the recorded path moves", () => {
    write(fullConfig());
    const h = harness();
    const source = sourceFor(h.wiring);
    try {
      const first = h.built.tailers[0];
      write(fullConfig({ log: { path: "/tmp/steward-config-wiring-other.log" } }));
      h.fire();

      expect(h.built.tailers).toHaveLength(2);
      expect(first?.closes).toBe(1);
      expect(source.logStatus().path).toBe("/tmp/steward-config-wiring-other.log");
      // The collector had nothing to do with the log path.
      expect(h.built.collectors).toHaveLength(1);
      expect(h.built.collectors[0]?.closes).toBe(0);
    } finally {
      source.close();
    }
  });

  it("stops using a command whose consent hash is missing after a rewrite", async () => {
    write(fullConfig());
    const h = harness();
    const source = sourceFor(h.wiring);
    try {
      expect(h.built.collectors).toHaveLength(1);

      // The operator edited the commands by hand, so neither argv matches a hash
      // in the consent map any more. Consent is bound to the exact command: the
      // old approval does not carry over to the new one.
      write(
        fullConfig({
          hostCollector: { command: OTHER_COLLECTOR, intervalMs: 1000 },
          control: { start: START, stop: STOP, restart: ["launchctl", "kickstart", "-kp", LABEL] },
        }),
      );
      h.fire();

      // The collector is stopped rather than left running under the old consent,
      // and no new one is spawned for the unapproved command.
      expect(h.built.collectors).toHaveLength(1);
      expect(h.built.collectors[0]?.closes).toBe(1);
      const after = await source.snapshot();
      expect(after.service.controls).toEqual(["start", "stop"]);
      // And the gate says so out loud, so an inert panel cannot be mistaken for
      // an unconfigured one.
      expect(after.drift.consent).toEqual({ hostCollector: true, controls: ["restart"] });
      // With no collector left there is no live band to overlay: the HOST panel
      // goes back to the simulation rather than holding the last real reading.
    } finally {
      source.close();
    }
  });

  it("refuses a config that becomes world-writable mid-session", async () => {
    write(fullConfig());
    const h = harness();
    const source = sourceFor(h.wiring);
    try {
      expect(h.built.collectors).toHaveLength(1);

      // A `chmod o+w` changes neither the size nor the mtime — the identity
      // tuple carries the mode and the owner precisely so this is still seen.
      chmodSync(path, 0o666);
      h.fire();

      expect(h.built.collectors[0]?.closes).toBe(1);
      expect(h.built.tailers[0]?.closes).toBe(1);
      expect(h.built.warnings.some((message) => message.includes("world-writable"))).toBe(true);
      const after = await source.snapshot();
      expect(after.service.controls).toEqual([]);
    } finally {
      source.close();
    }
  });

  it("refuses a config that becomes owned by another user mid-session", async () => {
    write(fullConfig());
    let uid = process.getuid?.() ?? 0;
    const h = harness({}, () => uid);
    const source = sourceFor(h.wiring);
    try {
      // The first read is of a file we own, so it is trusted...
      expect(h.built.collectors).toHaveLength(1);

      // ...and then the file is replaced by one this process does not own,
      // which is the case the gate exists for: another user planting a command.
      uid += 1;
      write(fullConfig());
      h.fire();

      expect(h.built.collectors[0]?.closes).toBe(1);
      expect(h.built.collectors).toHaveLength(1);
      expect(h.built.warnings.some((message) => message.includes("not owned"))).toBe(true);
      expect((await source.snapshot()).service.controls).toEqual([]);
    } finally {
      source.close();
    }
  });

  it("degrades rather than throwing when the config becomes malformed", async () => {
    write(fullConfig());
    const h = harness();
    const source = sourceFor(h.wiring);
    try {
      writeFileSync(path, '{ "memoryTopology": "unified", ');
      expect(() => h.fire()).not.toThrow();

      expect(h.built.collectors[0]?.closes).toBe(1);
      expect(h.built.warnings.some((message) => message.includes("not valid JSON"))).toBe(true);
      const after = await source.snapshot();
      expect(after.service.controls).toEqual([]);
      expect(after.drift.consent).toEqual({ hostCollector: false, controls: [] });

      // And it heals: the next good write wires everything back up.
      write(fullConfig());
      h.fire();
      expect(h.built.collectors).toHaveLength(2);
      expect((await source.snapshot()).service.controls).toHaveLength(3);
    } finally {
      source.close();
    }
  });

  it("degrades when a valid config loses the collector block entirely", async () => {
    write(fullConfig());
    const h = harness();
    const source = sourceFor(h.wiring);
    try {
      // `hostCollector` is required, so this fails validation as a whole — the
      // same honest teardown as a deletion, with a warning that names the field.
      write({ memoryTopology: "unified", consent: {} });
      h.fire();

      expect(h.built.collectors[0]?.closes).toBe(1);
      expect(h.built.warnings.some((message) => message.includes("hostCollector"))).toBe(true);
      expect((await source.snapshot()).service.controls).toEqual([]);
    } finally {
      source.close();
    }
  });

  it("never re-reads a file that has not changed, however often it is prodded", async () => {
    write(fullConfig());
    const h = harness();
    const source = sourceFor(h.wiring);
    try {
      // One read to build the source, and no other path may take another: the
      // config is read on a filesystem event, never on the snapshot clock.
      expect(h.built.reads).toHaveLength(1);
      await source.snapshot();
      await source.snapshot();
      await source.snapshot();
      expect(h.built.reads).toHaveLength(1);

      // A watcher is chatty — a single save is several events, and a watch that
      // had to climb to an ancestor directory sees traffic that is not ours.
      // Each of these costs one `stat` and stops there.
      for (let i = 0; i < 8; i += 1) h.fire();
      h.fire(null);
      h.fire("some-other-file.json");
      expect(h.built.reads).toHaveLength(1);
      expect(h.built.collectors).toHaveLength(1);
      expect(h.built.collectors[0]?.closes).toBe(0);

      // A real change is still noticed straight away.
      write(fullConfig({ memoryTopology: "discrete" }));
      h.fire();
      expect(h.built.reads).toHaveLength(2);
      expect((await source.snapshot()).memoryTopology).toBe("discrete");
    } finally {
      source.close();
    }
  });

  it("ignores events for other files in the config's own directory", () => {
    write(fullConfig());
    const h = harness();
    const source = sourceFor(h.wiring);
    try {
      writeFileSync(path, JSON.stringify(fullConfig({ memoryTopology: "discrete" })));
      // The write really did change the file, but this event is about a sibling,
      // so it is not our news to act on.
      h.fire("something-else.json");
      expect(h.built.reads).toHaveLength(1);
    } finally {
      source.close();
    }
  });

  it("watches the nearest existing ancestor when the config directory is missing", () => {
    const nested = join(directory, "nested", "steward");
    const h = harness({ path: join(nested, "steward.json") });
    const source = sourceFor(h.wiring);
    try {
      // Nothing to watch inside a directory that does not exist yet, so the
      // watch sits on the deepest ancestor that does.
      expect(h.watched()).toBe(directory);
      mkdirSync(nested, { recursive: true });
      h.fire("nested");
      // The watch has moved down to the config's own directory, which is where
      // the file will actually appear.
      expect(h.watched()).toBe(nested);
      expect(h.closedWatches()).toBe(1);
    } finally {
      source.close();
    }
  });

  it("stops watching when the source it feeds is closed", () => {
    write(fullConfig());
    const h = harness();
    const source = sourceFor(h.wiring);
    source.close();

    expect(h.closedWatches()).toBe(1);
    // Nothing may reach a spent source: a collector spawned for one could never
    // be closed by anybody.
    h.fire();
    expect(h.built.reads).toHaveLength(1);
    expect(h.built.collectors).toHaveLength(1);
    expect(h.built.collectors[0]?.closes).toBe(1);
  });

  it("closes a collector handed to a source that has already been closed", () => {
    // The watcher is stopped before anything else on close, so this is insurance
    // rather than a path — but what it protects is a process group.
    write(fullConfig());
    const h = harness();
    const source = sourceFor(h.wiring);
    source.close();

    const provider = fakeProvider();
    const tailer = fakeTailer("/tmp/steward-config-wiring-late.log");
    const parts: LlamaLiveParts = {
      host: { provider, topology: "unified", staleMs: 3000 },
      logTail: tailer,
    };
    source.reconfigure(parts);
    expect(provider.closes).toBe(1);
    expect(tailer.closes).toBe(1);

    // And again with the same parts: closed once, ever. A source must not lean
    // on the collector's own idempotence to avoid killing a process group twice.
    source.reconfigure(parts);
    expect(provider.closes).toBe(1);
    expect(tailer.closes).toBe(1);
  });

  it("replaces a watch the OS drops, rather than going quietly deaf", () => {
    write(fullConfig());
    const h = harness();
    const source = sourceFor(h.wiring);
    try {
      expect(h.built.collectors).toHaveLength(1);

      // A transient error (EMFILE, a network mount) ends the watch while its
      // directory is still perfectly there. The handle is spent; keeping it
      // would mean every later config change is missed without a word.
      h.loseWatch();
      expect(h.watched()).toBe(directory);

      // The replacement is live: a change after the loss is still noticed.
      write(fullConfig({ memoryTopology: "discrete" }));
      h.fire();
      expect(h.built.reads).toHaveLength(2);
    } finally {
      source.close();
    }
  });

  it("gives up watching, out loud, when the watch cannot stay up", () => {
    write(fullConfig());
    const h = harness();
    const source = sourceFor(h.wiring);
    try {
      // A watch that keeps dying is not worth re-arming forever — the same
      // reasoning as the collector's respawn cap. What it must not do is stop
      // silently, which is indistinguishable from a config that never changed.
      for (let i = 0; i < 5; i += 1) h.loseWatch();
      expect(h.built.warnings.some((message) => message.includes("gave up watching"))).toBe(true);

      // The config read at startup still stands — the dashboard is wired, it
      // just will not learn about later edits.
      expect(h.built.collectors).toHaveLength(1);
      expect(h.built.collectors[0]?.closes).toBe(0);
    } finally {
      source.close();
    }
  });

  it("warns and keeps serving the startup config when nothing can be watched", () => {
    write(fullConfig());
    const h = harness({
      watch: () => {
        throw new Error("EMFILE: too many open files");
      },
    });
    const source = sourceFor(h.wiring);
    try {
      // The dashboard still comes up fully wired; only later changes are missed,
      // and the operator is told why.
      expect(h.built.collectors).toHaveLength(1);
      expect(h.built.warnings.some((message) => message.includes("EMFILE"))).toBe(true);
    } finally {
      source.close();
    }
  });
});

describe("createConfigWiring — against the real filesystem", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "steward-wiring-live-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /**
   * Resolves once `predicate` holds, re-running `poke` on a slow cadence until
   * it does.
   *
   * The re-poke is not impatience: a `fs.watch` does not begin delivering the
   * instant it is created (on macOS the FSEvents stream starts on another
   * thread), so a filesystem change made microseconds later can land in the gap.
   * Real use never sees that — the dashboard arms its watch when it starts and
   * the operator runs the skill a good deal later — but a test that writes the
   * file in the same tick would be flaky about it. Writing again is what a
   * second save looks like, and the wiring must notice one of them.
   */
  function waitFor(predicate: () => boolean, poke: () => void, timeout = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      let lastPoke = Date.now();
      const tick = () => {
        if (predicate()) return resolve();
        if (Date.now() > deadline) return reject(new Error("waitFor timed out"));
        if (Date.now() - lastPoke > 300) {
          lastPoke = Date.now();
          poke();
        }
        setTimeout(tick, 10);
      };
      tick();
    });
  }

  // Given a generous deadline on purpose: this is the one test here that waits
  // on the OS rather than on a callback it triggered itself, and a loaded
  // machine can take its time delivering a filesystem event.
  it("notices a config written into a directory that did not exist", {
    timeout: 20_000,
  }, async () => {
    const nested = join(directory, ".config", "steward");
    const path = join(nested, "steward.json");
    const collectors: (HostMetricsProvider & { closes: number })[] = [];
    const applied: LlamaLiveParts[] = [];

    const wiring = createConfigWiring({
      path,
      createCollector: () => {
        const provider = fakeProvider();
        collectors.push(provider);
        return provider;
      },
      createTailer: (target) => fakeTailer(target),
      createController: (commands) => fakeController(commands),
      resolveLog: (config) => config?.path ?? null,
    });
    const stop = wiring.rewire((parts) => applied.push(parts));
    try {
      // Nothing exists yet — not the file, and not the two directories above it.
      expect(collectors).toHaveLength(0);
      const save = () => {
        mkdirSync(nested, { recursive: true });
        writeFileSync(path, JSON.stringify(fullConfig()));
        // The ancestor is stirred too. The event that CREATED the config
        // directory is the one a just-started watch is most likely to miss, and
        // it is the only event that directory would otherwise ever see — so a
        // retry has to give it something new to report.
        writeFileSync(join(directory, "poke.tmp"), String(Date.now()));
      };
      save();

      // No timer inside the wiring drives this: a real `fs.watch`, on a
      // directory that had to be created first, is what wakes it up.
      await waitFor(() => collectors.length === 1, save);
      expect(applied.at(-1)?.host?.provider).toBe(collectors[0]);
      expect(applied.at(-1)?.control?.actions).toEqual(["start", "stop", "restart"]);
      // Every re-save is a new mtime and so a real re-read, and not one of them
      // touched the collector: it was spawned once and left alone.
      expect(collectors).toHaveLength(1);
    } finally {
      stop();
      for (const provider of collectors) provider.close();
    }
  });
});
