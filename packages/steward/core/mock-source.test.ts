/**
 * The simulation is only useful if it is honest about state: a stopped service
 * emits nothing and reports nothing, an unloaded model stops being attributed
 * work, and the buffer never grows without bound. Every test here pins the
 * clock and the randomness, so a failure is a real behavior change.
 */

import { describe, expect, it } from "vitest";
import { createMockSource, type MockSourceOptions } from "./mock-source.js";
import { THROUGHPUT_HISTORY_SIZE, THROUGHPUT_SAMPLE_SECONDS } from "./types.js";

/** xorshift32 — deterministic, and varied enough to reach every log branch. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const FIXED_NOW = 1_760_000_000_000;

/** A source with every ticker unscheduled, so tests drive time themselves. */
function createSource(overrides: MockSourceOptions = {}) {
  return createMockSource({
    random: seededRandom(20260726),
    now: () => FIXED_NOW,
    logIntervalMs: 0,
    metricsIntervalMs: 0,
    throughputIntervalMs: 0,
    ...overrides,
  });
}

describe("createMockSource", () => {
  it("opens on the state the dashboard was designed against", async () => {
    const source = createSource();
    try {
      const snapshot = await source.snapshot();

      expect(source.name).toBe("mock");
      expect(snapshot.service).toEqual({
        running: true,
        startedAt: FIXED_NOW - 214 * 60 * 1000,
        pid: 4821,
        host: "127.0.0.1",
        port: 8080,
        build: "b6122",
      });
      expect(snapshot.models.map((model) => model.id)).toEqual([
        "qwen3.6-moe-a3b-instruct-q4_k_m",
        "qwen3.6-moe-30b-thinking-q5_k_m",
        "qwen3.6-moe-coder-fim-q4_k_m",
        "nomic-embed-text-v1.5-f16",
      ]);
      expect(snapshot.models[3]?.status).toBe("unloaded");
      expect(snapshot.models[3]?.tokensPerSecond).toBeNull();
      expect(snapshot.models[3]?.embedding).toBe(true);
      expect(snapshot.models[3]?.detail).toBe("embedding");
      expect(snapshot.models[3]?.gpuLayers).toBeNull();

      // Three models loaded (chat 2 + reason 1 + fim 1 slots); nomic unloaded.
      expect(snapshot.slots).toHaveLength(4);
      expect(snapshot.slots.every((slot) => typeof slot.modelId === "string")).toBe(true);
      expect(snapshot.slots[0]).toMatchObject({
        id: 0,
        modelId: "qwen3.6-moe-a3b-instruct-q4_k_m",
        promptTokens: 12408,
        ctxTotal: 65536,
        decoded: 268,
        state: "processing",
      });
      expect(snapshot.metrics.vramTotalGB).toBe(48);
      expect(snapshot.metrics.ramTotalGB).toBe(128);
      expect(snapshot.throughputHistory).toHaveLength(42);
      // In-flight requests are exactly the busy slots — the tile and the slots
      // panel never disagree.
      expect(snapshot.requestsInFlight).toBe(
        snapshot.slots.filter((slot) => slot.state === "processing").length,
      );
      // Per-model tuning (parallel, ctx-per-slot, gpu layers, flash-attn, KV
      // cache) lives on the model cards now; CONFIG keeps only router-wide facts.
      expect(snapshot.config.map((entry) => entry.key)).toEqual([
        "mode",
        "engine",
        "address",
        "max models",
        "autoload",
      ]);
    } finally {
      source.close();
    }
  });

  it("seeds scrollback, attributes it only to loaded models, and numbers it in order", () => {
    const source = createSource();
    try {
      const lines = source.recentLogs(1000);

      expect(lines).toHaveLength(60);
      expect(lines.every((line) => line.modelId !== "nomic-embed-text-v1.5-f16")).toBe(true);
      expect(lines.every((line) => line.ts === FIXED_NOW)).toBe(true);
      expect(lines.map((line) => line.seq)).toEqual(lines.map((_line, index) => 618 + index));
      expect(new Set(lines.map((line) => line.level))).toEqual(new Set(["INFO", "WARN", "ERROR"]));
      expect(source.recentLogs(3)).toEqual(lines.slice(-3));
      expect(source.recentLogs(0)).toEqual([]);
    } finally {
      source.close();
    }
  });

  it("replays identically for the same seed", () => {
    const first = createSource();
    const second = createSource();
    try {
      expect(second.recentLogs(1000)).toEqual(first.recentLogs(1000));
    } finally {
      first.close();
      second.close();
    }
  });

  it("caps the ring buffer at 500 lines", () => {
    const source = createSource();
    try {
      for (let i = 0; i < 400; i += 1) source.tickLogs();
      const lines = source.recentLogs(10_000);

      expect(lines).toHaveLength(500);
      const seqs = lines.map((line) => line.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
    } finally {
      source.close();
    }
  });

  it("appends nothing while the service is stopped, and resumes on start", async () => {
    const source = createSource();
    try {
      await source.setService("stop");
      const before = source.recentLogs(1000).length;
      for (let i = 0; i < 20; i += 1) source.tickLogs();
      expect(source.recentLogs(1000)).toHaveLength(before);

      await source.setService("start");
      source.tickLogs();
      expect(source.recentLogs(1000).length).toBeGreaterThan(before);
    } finally {
      source.close();
    }
  });

  it("reports a stopped service as producing nothing", async () => {
    const source = createSource();
    try {
      source.tickMetrics();
      source.tickThroughput();
      await source.setService("stop");
      source.tickMetrics();
      source.tickThroughput();
      const snapshot = await source.snapshot();

      expect(snapshot.service.running).toBe(false);
      expect(snapshot.service.startedAt).toBeNull();
      expect(snapshot.service.pid).toBeNull();
      expect(snapshot.throughputTps).toBe(0);
      expect(snapshot.requestsInFlight).toBe(0);
      expect(snapshot.requestsQueued).toBe(0);
      expect(snapshot.slots.every((slot) => slot.state === "idle")).toBe(true);
      expect(snapshot.models.every((model) => model.status !== "active")).toBe(true);
      expect(snapshot.throughputHistory.at(-1)).toBe(0);
    } finally {
      source.close();
    }
  });

  it("restarts the uptime clock on start and restart", async () => {
    let clock = FIXED_NOW;
    const source = createSource({ now: () => clock });
    try {
      clock += 60_000;
      await source.setService("restart");
      expect((await source.snapshot()).service.startedAt).toBe(clock);

      await source.setService("stop");
      clock += 60_000;
      await source.setService("start");
      expect((await source.snapshot()).service.startedAt).toBe(clock);
    } finally {
      source.close();
    }
  });

  it("stops attributing work to an unloaded model, and takes it back on load", async () => {
    const source = createSource();
    try {
      const lastSeeded = source.recentLogs(1)[0]?.seq ?? 0;
      await source.setModel("qwen3.6-moe-a3b-instruct-q4_k_m", "unload");
      for (let i = 0; i < 40; i += 1) source.tickLogs();

      const unloadedSnapshot = await source.snapshot();
      expect(unloadedSnapshot.models[0]?.status).toBe("unloaded");
      expect(unloadedSnapshot.models[0]?.tokensPerSecond).toBeNull();
      // The unloaded model's slot group goes with it — no slot names it anymore.
      expect(
        unloadedSnapshot.slots.every((slot) => slot.modelId !== "qwen3.6-moe-a3b-instruct-q4_k_m"),
      ).toBe(true);

      const sinceUnload = source.recentLogs(500).filter((line) => line.seq > lastSeeded);
      expect(sinceUnload.length).toBeGreaterThan(0);
      expect(sinceUnload.every((line) => line.modelId !== "qwen3.6-moe-a3b-instruct-q4_k_m")).toBe(
        true,
      );

      await source.setModel("nomic-embed-text-v1.5-f16", "load");
      const loadedSnapshot = await source.snapshot();
      expect(loadedSnapshot.models[3]?.status).not.toBe("unloaded");
    } finally {
      source.close();
    }
  });

  it("goes quiet when nothing is resident, rather than inventing slot traffic", async () => {
    const source = createSource();
    try {
      for (const model of (await source.snapshot()).models) {
        await source.setModel(model.id, "unload");
      }
      const before = source.recentLogs(1000).length;
      const seen: number[] = [];
      const unsubscribe = source.subscribeLogs((l) => seen.push(l.seq));

      for (let i = 0; i < 50; i += 1) source.tickLogs();

      expect(source.recentLogs(1000)).toHaveLength(before);
      expect(seen).toEqual([]);

      // One model back means one model to attribute lines to.
      unsubscribe();
      await source.setModel("qwen3.6-moe-coder-fim-q4_k_m", "load");
      source.tickLogs();
      const resumed = source.recentLogs(1000);
      expect(resumed.length).toBeGreaterThan(before);
      expect(resumed.at(-1)?.modelId).toBe("qwen3.6-moe-coder-fim-q4_k_m");
    } finally {
      source.close();
    }
  });

  it("rejects an unknown model", async () => {
    const source = createSource();
    try {
      await expect(source.setModel("not-a-model", "load")).rejects.toThrow(/not-a-model/);
    } finally {
      source.close();
    }
  });

  it("samples throughput on its own cadence, not the metrics tick", async () => {
    const source = createSource();
    try {
      const before = (await source.snapshot()).throughputHistory;
      for (let i = 0; i < 5; i += 1) source.tickMetrics();
      expect((await source.snapshot()).throughputHistory).toEqual(before);

      source.tickThroughput();
      const after = (await source.snapshot()).throughputHistory;
      expect(after).toHaveLength(before.length);
      expect(after.slice(0, -1)).toEqual(before.slice(1));
      expect(after.at(-1)).not.toEqual(before.at(-1));
    } finally {
      source.close();
    }
  });

  it("fills the whole window at the cadence the chart's axis claims", async () => {
    // 42 samples at one every THROUGHPUT_SAMPLE_SECONDS is the two minutes the
    // chart is labelled with; the source has to be the thing that makes it so.
    const source = createSource();
    try {
      for (let i = 0; i < THROUGHPUT_HISTORY_SIZE; i += 1) source.tickThroughput();
      const { throughputHistory } = await source.snapshot();

      expect(throughputHistory).toHaveLength(THROUGHPUT_HISTORY_SIZE);
      expect(THROUGHPUT_HISTORY_SIZE * THROUGHPUT_SAMPLE_SECONDS).toBe(126);
      expect(throughputHistory.every((sample) => sample > 0)).toBe(true);
    } finally {
      source.close();
    }
  });

  it("keeps sensors inside their physical range across a long run", async () => {
    const source = createSource();
    try {
      for (let i = 0; i < 200; i += 1) {
        source.tickMetrics();
        source.tickThroughput();
      }
      const snapshot = await source.snapshot();
      const { metrics } = snapshot;

      expect(metrics.gpuTempC).toBeGreaterThanOrEqual(35);
      expect(metrics.gpuTempC).toBeLessThanOrEqual(92);
      expect(metrics.cpuTempC).toBeGreaterThanOrEqual(35);
      expect(metrics.cpuTempC).toBeLessThanOrEqual(92);
      expect(metrics.vramUsedGB).toBeLessThanOrEqual(metrics.vramTotalGB);
      expect(metrics.ramUsedGB).toBeLessThanOrEqual(metrics.ramTotalGB);
      expect(metrics.gpuUtil).toBeGreaterThan(0);
      expect(metrics.gpuUtil).toBeLessThanOrEqual(1);
      expect(metrics.cpuUtil).toBeLessThanOrEqual(1);
      expect(snapshot.throughputHistory).toHaveLength(42);
      expect(snapshot.throughputTps).toBeGreaterThan(0);
    } finally {
      source.close();
    }
  });

  it("streams to subscribers until they unsubscribe", () => {
    const source = createSource();
    try {
      const seen: number[] = [];
      const unsubscribe = source.subscribeLogs((line) => seen.push(line.seq));

      source.tickLogs();
      expect(seen.length).toBeGreaterThan(0);
      const delivered = seen.length;

      unsubscribe();
      unsubscribe();
      source.tickLogs();
      expect(seen).toHaveLength(delivered);
    } finally {
      source.close();
    }
  });

  it("schedules its tickers only when asked, and releases them all on close", async () => {
    const source = createMockSource({
      random: seededRandom(7),
      logIntervalMs: 5,
      metricsIntervalMs: 5,
      throughputIntervalMs: 5,
      seedLines: 1,
    });
    const before = source.recentLogs(1000).length;
    const history = (await source.snapshot()).throughputHistory;

    await new Promise((resolve) => setTimeout(resolve, 40));
    const running = source.recentLogs(1000).length;
    expect(running).toBeGreaterThan(before);
    expect((await source.snapshot()).throughputHistory).not.toEqual(history);

    source.close();
    const settled = (await source.snapshot()).throughputHistory;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(source.recentLogs(1000)).toHaveLength(running);
    expect((await source.snapshot()).throughputHistory).toEqual(settled);
  });
});
