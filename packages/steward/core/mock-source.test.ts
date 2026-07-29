/**
 * The simulation is only useful if it is honest about state: a stopped service
 * emits nothing and reports nothing, an unloaded model stops being attributed
 * work, and the buffer never grows without bound. Every test here pins the
 * clock and the randomness, so a failure is a real behavior change.
 *
 * The log assertions carry a second burden. The mock is what the dev dashboard
 * shows, so a mock that misrepresents llama.cpp teaches the whole UI the wrong
 * lesson — these tests hold it to the measured corpus: the level mix, the
 * proportion of lines about no model at all, the classes the console filters on,
 * and the fact that a load and an unload are loud events rather than silent
 * state changes.
 */

import { describe, expect, it } from "vitest";
import { parseLogLine } from "./log-parse.js";
import { createMockSource, type MockSourceOptions } from "./mock-source.js";
import type { LogLine } from "./types.js";
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
        // The simulated machine has all three commands declared and consented,
        // so the dev dashboard exercises the control row it stands in for.
        controls: ["start", "stop", "restart"],
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
      // The mock stands in for a discrete VRAM+RAM machine (its current layout).
      expect(snapshot.memoryTopology).toBe("discrete");
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

      expect(lines).toHaveLength(200);
      // The only lines about the model that is NOT resident are the five that
      // unloaded it — a real unload names the instance on its way out. Nothing
      // after that attributes work to it.
      const gone = lines.filter((line) => line.modelId === "nomic-embed-text-v1.5-f16");
      expect(gone).toHaveLength(5);
      expect(gone.at(-1)?.message).toContain("exited with status 0");
      const last = gone.at(-1);
      const after = last === undefined ? [] : lines.slice(lines.indexOf(last) + 1);
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((line) => line.modelId !== "nomic-embed-text-v1.5-f16")).toBe(true);
      expect(lines.every((line) => line.ts === FIXED_NOW)).toBe(true);
      expect(lines.map((line) => line.seq)).toEqual(lines.map((_line, index) => 618 + index));
      expect(source.recentLogs(3)).toEqual(lines.slice(-3));
      expect(source.recentLogs(0)).toEqual([]);
    } finally {
      source.close();
    }
  });

  it("opens on a story: a boot, a load per resident model, a request, a disconnect", () => {
    const source = createSource();
    try {
      const lines = source.recentLogs(1000);
      const messages = lines.map((line) => line.message);

      // The banner a real router writes within 81 ms of starting, every time.
      expect(messages[0]).toContain("common_params_print_info: verbosity = 3");
      expect(messages.some((m) => m.includes("starting server in router mode"))).toBe(true);
      expect(lines.filter((line) => line.level === "WARN")[0]?.message).toContain(
        "router mode is experimental",
      );

      // One spawn per resident model, and the child's own boot lines with it.
      expect(messages.filter((m) => m.includes("spawning server instance with name=")).length).toBe(
        3,
      );
      expect(messages.some((m) => m === "srv  llama_server: model loaded")).toBe(true);

      // A completed request, including the timing group llama.cpp really emits.
      expect(messages.some((m) => m.includes("prompt eval time ="))).toBe(true);
      expect(messages.some((m) => m.includes("graphs reused ="))).toBe(true);
      expect(messages.some((m) => m.includes("stop processing: n_tokens ="))).toBe(true);

      // A live generation-rate line and a model lifecycle exit, both on the
      // FIRST paint: the console builder should not have to wait on a dice roll
      // to see either.
      const rate = lines.find((line) => line.kind === "rate");
      expect(rate?.message).toContain("n_decoded =");
      expect(rate?.message).toContain("t/s");
      expect(messages.some((m) => m.includes("exited with status 0"))).toBe(true);
      expect(messages.some((m) => m.includes("unload: stopping model instance name="))).toBe(true);

      // The one ERROR shape a real router produces from a routine client
      // disconnect — router-wide, with the matching child WARN attributed.
      const error = lines.find((line) => line.level === "ERROR");
      expect(error?.message).toBe(
        "srv    operator(): http client error: Connection handling canceled",
      );
      expect(error?.modelId).toBeNull();
      expect(error?.origin).toBe("router");
      expect(lines.some((line) => line.message.includes("stop: cancel task"))).toBe(true);
    } finally {
      source.close();
    }
  });

  it("tags every line with the class and the writer the console filters on", () => {
    const source = createSource();
    try {
      const lines = source.recentLogs(1000);
      expect(lines.every((line) => line.kind !== undefined && line.origin !== undefined)).toBe(
        true,
      );

      const kinds = new Set(lines.map((line) => line.kind));
      // proxy (Steward's own polling), args (the launch block) and event are all
      // in the opening scrollback; `rate` only exists while something generates.
      expect(kinds.has("proxy")).toBe(true);
      expect(kinds.has("args")).toBe(true);
      expect(kinds.has("event")).toBe(true);

      // The args block is one contiguous run per load, under its own header, and
      // it is never attributed to a model: it is the router's command line.
      const argsRun = lines.filter((line) => line.kind === "args");
      expect(argsRun.length).toBe(3 * 31);
      expect(argsRun.every((line) => line.modelId === null && line.origin === "router")).toBe(true);
      const firstArg = lines.findIndex((line) => line.kind === "args");
      expect(lines[firstArg - 1]?.message).toContain("spawning server instance with args:");
      expect(lines.slice(firstArg, firstArg + 31).every((line) => line.kind === "args")).toBe(true);
      expect(lines[firstArg + 31]?.kind).toBe("event");

      // Every proxy line names its model; that is what makes it attributable.
      expect(
        lines
          .filter((line) => line.kind === "proxy")
          .every((line) => line.origin === "router" && line.modelId !== null),
      ).toBe(true);
    } finally {
      source.close();
    }
  });

  it("keeps a quarter of the console about no model at all, as a real log is", () => {
    const source = createSource();
    try {
      // The console's own default view: proxy lines hidden, the args block
      // folded. What is left is what an operator actually reads.
      const shown = source
        .recentLogs(1000)
        .filter((line) => line.kind !== "proxy" && line.kind !== "args");
      const unattributed = shown.filter((line) => line.modelId === null);

      // Measured on a real corpus: 26.1% of the filtered stream is router-wide —
      // the banner, the catalogue, the args header. The mock used to attribute
      // 100% of its lines, leaving the `router` column completely unexercised.
      const share = unattributed.length / shown.length;
      expect(share).toBeGreaterThan(0.1);
      expect(share).toBeLessThan(0.45);
      expect(unattributed.every((line) => line.origin === "router")).toBe(true);
    } finally {
      source.close();
    }
  });

  it("emits the level mix a real router emits, not a demo's", () => {
    const source = createSource();
    try {
      const counts = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
      let total = 0;
      // Count everything written, not just what the ring buffer retained.
      const unsubscribe = source.subscribeLogs((line: LogLine) => {
        counts[line.level] += 1;
        total += 1;
      });
      for (let i = 0; i < 3000; i += 1) source.tickLogs();
      unsubscribe();

      // Reality over 15,842 lines and 16 boots: INFO 98.95%, WARN 0.63%,
      // ERROR 0.00%, DEBUG 0.00% (`D` needs a verbosity nothing runs at). The
      // old mock claimed 10% WARN and 4% ERROR.
      expect(total).toBeGreaterThan(1000);
      expect(counts.INFO / total).toBeGreaterThan(0.97);
      expect(counts.WARN / total).toBeLessThan(0.02);
      expect(counts.ERROR / total).toBeLessThan(0.01);
      expect(counts.DEBUG).toBe(0);
      // Steward's own polling is most of a real log, and the console's default
      // view depends on that being true here too.
      expect(source.recentLogs(500).filter((line) => line.kind === "proxy").length).toBeGreaterThan(
        300,
      );
    } finally {
      source.close();
    }
  });

  it("writes lines the real parser reads back the same way", () => {
    // The mock is the console's stand-in for llama.cpp, so its grammar has to
    // survive the parser that reads llama.cpp — otherwise the dev dashboard
    // exercises a shape production never sees.
    const source = createSource();
    try {
      let previous = null as ReturnType<typeof parseLogLine> | null;
      for (const line of source.recentLogs(1000)) {
        // IPC records carry neither an elapsed stamp nor a level, exactly as
        // they arrive; everything else carries both.
        const ipc = line.message.startsWith("cmd_child_to_router:");
        const letter = { INFO: "I", WARN: "W", ERROR: "E", DEBUG: "D" }[line.level];
        const port = line.origin === "child" ? "[53691] " : "";
        // The FILE's own line: the frame the mock keeps in its own field is
        // written back in front of the message, exactly as llama.cpp wrote it.
        const body = `${line.frame?.raw ?? ""}${line.message}`;
        const raw = ipc ? `${port}${body}` : `${port}0.00.715.177 ${letter} ${body}`;

        const parsed = parseLogLine(raw, previous);
        previous = parsed;

        expect(parsed.message).toBe(line.message);
        expect(parsed.frame).toEqual(line.frame ?? null);
        expect(parsed.family).toBe(line.family);
        expect(parsed.origin).toBe(line.origin);
        expect(parsed.level).toBe(ipc ? "INFO" : line.level);
        expect(parsed.kind).toBe(line.kind);
        // Attribution the parser can reach on its own: a line that names a model
        // must name the one the mock attributed it to.
        if (parsed.modelName !== null) expect(parsed.modelName).toBe(line.modelId);
      }
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

      // The unload itself is loud — five lines naming the instance that went
      // away, which is what a real router writes. What must stop is the traffic
      // after it.
      const sinceUnload = source.recentLogs(500).filter((line) => line.seq > lastSeeded);
      expect(sinceUnload[0]?.message).toContain(
        "unload: stopping model instance name=qwen3.6-moe-a3b-instruct-q4_k_m",
      );
      const afterUnload = sinceUnload.slice(5);
      expect(afterUnload.length).toBeGreaterThan(0);
      expect(afterUnload.every((line) => line.modelId !== "qwen3.6-moe-a3b-instruct-q4_k_m")).toBe(
        true,
      );

      await source.setModel("nomic-embed-text-v1.5-f16", "load");
      const loadedSnapshot = await source.snapshot();
      expect(loadedSnapshot.models[3]?.status).not.toBe("unloaded");
    } finally {
      source.close();
    }
  });

  it("writes the load and unload bursts a real router writes", async () => {
    const source = createSource();
    try {
      const before = source.recentLogs(1000).at(-1)?.seq ?? 0;
      await source.setModel("nomic-embed-text-v1.5-f16", "load");
      const load = source.recentLogs(1000).filter((line) => line.seq > before);

      // 46 lines, 31 of them the args block — the measured shape of a load.
      expect(load).toHaveLength(46);
      expect(load.filter((line) => line.kind === "args")).toHaveLength(31);
      expect(load[0]?.message).toContain(
        "spawning server instance with name=nomic-embed-text-v1.5-f16 on port ",
      );
      expect(load[0]?.modelId).toBe("nomic-embed-text-v1.5-f16");
      expect(load[1]?.message).toContain("spawning server instance with args:");
      expect(load[1]?.modelId).toBeNull();
      // The child's own boot, including the comp-less tokenizer warnings that a
      // naive `<component> <fn>:` parser gets wrong.
      expect(load.some((line) => line.level === "WARN" && line.message.startsWith("load: "))).toBe(
        true,
      );
      expect(load.at(-1)?.message).toContain('"state":"ready"');

      const middle = source.recentLogs(1000).at(-1)?.seq ?? 0;
      await source.setModel("nomic-embed-text-v1.5-f16", "unload");
      const unload = source.recentLogs(1000).filter((line) => line.seq > middle);

      expect(unload).toHaveLength(5);
      expect(unload.at(-1)?.message).toContain(
        "instance name=nomic-embed-text-v1.5-f16 exited with status 0",
      );
      // A failed exit is reported at INFO too — the status number is the signal,
      // never the level.
      expect(unload.every((line) => line.level === "INFO")).toBe(true);
    } finally {
      source.close();
    }
  });

  it("says nothing about a load or unload while the service is stopped", async () => {
    const source = createSource();
    try {
      await source.setService("stop");
      const before = source.recentLogs(1000).length;
      await source.setModel("nomic-embed-text-v1.5-f16", "load");
      await source.setModel("qwen3.6-moe-coder-fim-q4_k_m", "unload");
      expect(source.recentLogs(1000)).toHaveLength(before);
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

  it("opens a console in one step, like the real tailer does", () => {
    const source = createSource();
    try {
      const seen: number[] = [];
      const { backlog, unsubscribe } = source.attachLogs((line) => seen.push(line.seq), 5);

      // Same contract as the file tailer: the backlog is a snapshot taken as the
      // listener is registered, so nothing can fall between the two.
      expect(backlog).toEqual(source.recentLogs(5));
      expect(seen).toEqual([]);

      source.tickLogs();
      const newest = backlog.at(-1)?.seq ?? 0;
      expect(seen.every((seq) => seq > newest)).toBe(true);

      unsubscribe();
      const delivered = seen.length;
      source.tickLogs();
      expect(seen).toHaveLength(delivered);
      expect(source.attachLogs(() => undefined, 0).backlog).toEqual([]);
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

describe("the shapes the console's new columns need to be seen working", () => {
  /**
   * None of the task column, the badges or the trace is proven by code that
   * compiles — each is proven by the simulation producing the shape it is for.
   * These are the five §8.9 cases, each with the console feature it unblocks.
   */
  function seeded() {
    const source = createSource();
    try {
      return source.recentLogs(1000);
    } finally {
      source.close();
    }
  }

  it("frames its slot lines the way llama.cpp's shared macro does", () => {
    const framed = seeded().filter((line) => line.frame !== undefined);
    expect(framed.length).toBeGreaterThan(10);
    for (const line of framed) {
      expect(line.frame?.raw).toMatch(/^slot\s+\S+: id\s+-?\d+ \| task -?\d+ \| $/);
      // Half the trace key. A framed line with no port is untraceable.
      expect(typeof line.port).toBe("number");
    }
  });

  it("writes SPARSE, NON-MONOTONIC task ids, so 'not a request number' is testable", () => {
    const tasks = seeded()
      .filter((line) => line.frame !== undefined && line.frame.task >= 0)
      .map((line) => line.frame?.task ?? 0);
    // Sparse: consecutive requests are hundreds of ids apart, because every
    // internal task bumps the same counter.
    expect(Math.max(...tasks)).toBeGreaterThan(tasks.length);
    // And at least one DECREASE in file order: ids are allocated at enqueue and
    // slots granted at dequeue, so a deferred task logs later with a lower id.
    const decreases = tasks.filter((task, i) => i > 0 && task < (tasks[i - 1] ?? 0));
    expect(decreases.length).toBeGreaterThan(0);
  });

  it("collides task ids across two ports, which is why the key is (port, task)", () => {
    const ports = new Map<number, Set<number>>();
    for (const line of seeded()) {
      if (line.frame === undefined || line.port === undefined) continue;
      const seen = ports.get(line.frame.task) ?? new Set<number>();
      seen.add(line.port);
      ports.set(line.frame.task, seen);
    }
    const collisions = [...ports].filter(([, seen]) => seen.size > 1);
    expect(collisions.length).toBeGreaterThan(0);
  });

  it("writes exactly one `truncated = 1`, and long stretches without one", () => {
    const lines = seeded();
    const lost = lines.filter((line) => line.contextLost === true);
    expect(lost.length).toBe(1);
    expect(lost[0]?.message).toContain("truncated = 1");
    // The banner it drives is the exception, not the rule.
    expect(lines.filter((line) => line.message.includes("truncated = 0")).length).toBeGreaterThan(
      2,
    );
  });

  it("uses a second slot id, so the slot badge's reveal path runs", () => {
    const slots = new Set(
      seeded()
        .filter((line) => line.frame !== undefined)
        .map((line) => line.frame?.slot),
    );
    expect(slots.size).toBeGreaterThan(1);
  });

  it("reports a cache hit, so the one translating badge has something to translate", () => {
    const cached = seeded().filter((line) => line.cacheHit !== undefined);
    expect(cached.length).toBeGreaterThan(0);
    for (const line of cached) {
      expect(line.cacheHit).toBeGreaterThanOrEqual(0);
      expect(line.cacheHit).toBeLessThanOrEqual(1);
    }
  });

  it("writes a shape no rule matches, so `other` is never zero", () => {
    // `other` is the drift alarm, and an alarm that has never been seen to fire
    // has never been seen to work.
    const other = seeded().filter((line) => line.family === "other");
    expect(other.length).toBeGreaterThan(0);
    expect(other.some((line) => line.message.includes("frobnicate"))).toBe(true);
  });

  it("classifies every line into a family, none of them by a function name", () => {
    const families = new Set(seeded().map((line) => line.family));
    expect(families).toEqual(new Set(["requests", "models", "startup", "other"]));
  });
});
