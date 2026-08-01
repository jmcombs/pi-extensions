/**
 * The collector's process lifecycle, exercised against REAL child processes (the
 * `producer.mjs` fixture) rather than a mock — the hazards it guards against
 * (respawn storms, orphaned process groups) only exist for real processes. Every
 * wait is a poll on a condition, not a fixed sleep, and every test closes the
 * collector so no producer outlives it.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMetricsProvider } from "../core/host-metrics.js";
import { createHostCollector, createLineSplitter } from "./host-collector.js";

const PRODUCER = fileURLToPath(
  new URL("./__fixtures__/host-collector/producer.mjs", import.meta.url),
);

/** The argv that runs the fixture in a given mode. */
function producerCommand(mode: string, arg?: string): string[] {
  const command = [process.execPath, PRODUCER, mode];
  if (arg !== undefined) command.push(arg);
  return command;
}

/** True while `pid` names a live process. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Bytes in `path` (one is appended per producer start), or 0 when it is absent. */
function startCount(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

/** Resolves once `predicate` holds, polling until it does or the deadline passes. */
function waitFor(predicate: () => boolean, timeout = 4000, interval = 10): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const tick = () => {
      let ok = false;
      try {
        ok = predicate();
      } catch {
        ok = false;
      }
      if (ok) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitFor timed out"));
      setTimeout(tick, interval);
    };
    tick();
  });
}

/** Samples `read` across a window, returning every value seen — for stability checks. */
function observe<T>(read: () => T, forMs = 250, interval = 20): Promise<T[]> {
  return new Promise((resolve) => {
    const values: T[] = [];
    const deadline = Date.now() + forMs;
    const tick = () => {
      values.push(read());
      if (Date.now() >= deadline) return resolve(values);
      setTimeout(tick, interval);
    };
    tick();
  });
}

let dir = "";
let collectors: HostMetricsProvider[] = [];

/** Tracks the collector so it is always closed, even if an assertion throws. */
function track(collector: HostMetricsProvider): HostMetricsProvider {
  collectors.push(collector);
  return collector;
}

beforeEach(() => {
  dir = mkdtemp();
  collectors = [];
});

afterEach(() => {
  for (const collector of collectors) collector.close();
  rmSync(dir, { recursive: true, force: true });
});

function mkdtemp(): string {
  return mkdtempSync(`${tmpdir()}/steward-collector-`);
}

describe("createHostCollector", () => {
  it("keeps the latest validated reading, stamped with an arrival time", async () => {
    const collector = track(createHostCollector(producerCommand("emit"), 50));
    await waitFor(() => collector.latest() !== null);

    const sample = collector.latest();
    expect(sample?.reading.gpuUtil).toBeCloseTo(0.31, 2);
    expect(sample?.reading.ramTotalGB).toBe(128);
    expect(sample?.receivedAt).toBeGreaterThan(0);
  });

  it("skips malformed and foreign lines, keeping only the valid reading", async () => {
    const collector = track(createHostCollector(producerCommand("noise"), 50));
    await waitFor(() => collector.latest() !== null);
    // The junk and foreign-schema lines never become a sample.
    expect(collector.latest()?.reading.ramTotalGB).toBe(128);
  });

  it("stays warming (null) while the producer emits nothing", async () => {
    const counter = `${dir}/silent`;
    const collector = track(
      createHostCollector(producerCommand("silent", counter), 50, { minBackoffMs: 10 }),
    );
    // Wait until the producer has actually started, then confirm no sample lands.
    await waitFor(() => startCount(counter) >= 1);
    const seen = await observe(() => collector.latest());
    expect(seen.every((s) => s === null)).toBe(true);
  });

  it("drops an oversized newline-less flood and resyncs to the next valid line", async () => {
    // The producer writes a 256 KB blob with no newline (far over the 64 KB cap),
    // then a normal line. A reader that buffered the blob whole would be the very
    // memory hazard this guards against; here it is discarded and the line after
    // it still parses into latest().
    const collector = track(createHostCollector(producerCommand("flood"), 50));
    await waitFor(() => collector.latest() !== null);
    expect(collector.latest()?.reading.ramTotalGB).toBe(128);
  });

  it("escalates to SIGKILL for a producer that ignores SIGTERM", async () => {
    const pidFile = `${dir}/stubborn.pid`;
    const collector = track(
      createHostCollector(producerCommand("stubborn", pidFile), 50, { killEscalationMs: 100 }),
    );
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(isAlive(pid)).toBe(true);

    collector.close();

    // SIGTERM is trapped and ignored, so only the escalated SIGKILL reaps it.
    await waitFor(() => !isAlive(pid));
    expect(isAlive(pid)).toBe(false);
  });

  it("respawns after the producer exits", async () => {
    const counter = `${dir}/once`;
    const collector = track(
      createHostCollector(producerCommand("once", counter), 50, {
        minBackoffMs: 5,
        maxBackoffMs: 20,
        maxRespawns: 20,
      }),
    );
    // Each start appends a byte; three starts proves it respawned, not just ran once.
    await waitFor(() => startCount(counter) >= 3);
    // And a sample from one of those healthy starts is retained.
    expect(collector.latest()).not.toBeNull();
  });

  it("gives up after the respawn cap, without fork-bombing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const counter = `${dir}/crash`;
      const maxRespawns = 3;
      track(
        createHostCollector(producerCommand("crash", counter), 50, {
          minBackoffMs: 5,
          maxBackoffMs: 20,
          maxRespawns,
        }),
      );
      // One initial start plus `maxRespawns` retries, then it must stop.
      await waitFor(() => startCount(counter) >= maxRespawns + 1);
      const counts = await observe(() => startCount(counter));
      expect(Math.max(...counts)).toBe(maxRespawns + 1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("gave up"));
    } finally {
      warn.mockRestore();
    }
  });

  it("kills the whole process group on close, orphaning nothing", async () => {
    const pidFile = `${dir}/grandchild.pid`;
    const collector = track(createHostCollector(producerCommand("group", pidFile), 50));
    // The producer writes its same-group grandchild's pid once it is up.
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(isAlive(grandchild)).toBe(true);

    collector.close();

    // A plain child.kill() would orphan the grandchild; the group kill reaps it.
    await waitFor(() => !isAlive(grandchild));
    expect(isAlive(grandchild)).toBe(false);
  });

  it("close() is idempotent and safe before any sample", () => {
    const collector = createHostCollector(producerCommand("emit"), 50);
    expect(() => {
      collector.close();
      collector.close();
    }).not.toThrow();
  });
});

describe("createLineSplitter", () => {
  /** Collects every line the splitter emits, for assertion. */
  function collect(): { splitter: ReturnType<typeof createLineSplitter>; lines: string[] } {
    const lines: string[] = [];
    return { splitter: createLineSplitter(64, (line) => lines.push(line)), lines };
  }

  it("emits complete lines and reassembles ones split across chunks", () => {
    const { splitter, lines } = collect();
    splitter.push('{"a":1}\n{"b":2}');
    expect(lines).toEqual(['{"a":1}']);
    splitter.push('{"c":3}\n');
    // The partial line spanning two chunks is joined before it is emitted.
    expect(lines).toEqual(['{"a":1}', '{"b":2}{"c":3}']);
  });

  it("strips a trailing CR so CRLF producers parse", () => {
    const { splitter, lines } = collect();
    splitter.push("hello\r\nworld\r\n");
    expect(lines).toEqual(["hello", "world"]);
  });

  it("never emits a line, nor buffers, past the cap — an unterminated flood is discarded", () => {
    const emitted: string[] = [];
    const splitter = createLineSplitter(64, (line) => emitted.push(line));
    // Two 10 KB chunks with no newline between them: nothing is ever emitted, and
    // (by construction) nothing beyond the 64-byte cap is retained internally.
    splitter.push("x".repeat(10_000));
    splitter.push("x".repeat(10_000));
    expect(emitted).toEqual([]);
    // The newline ends the over-cap run; the next line resyncs and is delivered.
    splitter.push('\n{"ok":true}\n');
    expect(emitted).toEqual(['{"ok":true}']);
  });

  it("drops a single completed line that exceeds the cap, keeping the next", () => {
    const emitted: string[] = [];
    const splitter = createLineSplitter(8, (line) => emitted.push(line));
    splitter.push("waytoolongline\nok\n");
    expect(emitted).toEqual(["ok"]);
  });
});
