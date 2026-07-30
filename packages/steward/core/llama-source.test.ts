/**
 * The live source's contract is: overlay CONFIG, MODELS and SLOTS, delegate the
 * rest, and never throw or hang; and perform load/unload for real, surfacing a
 * failure rather than swallowing it. These tests inject a path-aware fetch (they
 * do not stand up a server) to exercise our own orchestration and error
 * handling, and pair it with a real mock fallback to prove every other panel
 * still comes through untouched. Parser correctness lives in the `llama-models`,
 * `llama-slots`, and `llama-config` suites, against the captured real fixtures.
 */

import { describe, expect, it } from "vitest";
import type { HostMetricsProvider, HostReading, HostSample } from "./host-metrics.js";
import {
  type FetchLike,
  type HostMetricsOverlay,
  LlamaSource,
  type LogTailer,
  type ServiceController,
  type ServiceControlResult,
} from "./llama-source.js";
import { parseLogLine } from "./log-parse.js";
import { createMockSource, type MockSourceOptions } from "./mock-source.js";
import { SLOT_STALE_MS } from "./slot-activity.js";
import type { StewardDataSource } from "./source.js";
import {
  type LogLine,
  type LogStreamStatus,
  type MemoryTopology,
  type ServiceAction,
  THROUGHPUT_HISTORY_SIZE,
  THROUGHPUT_SAMPLE_SECONDS,
} from "./types.js";

const CONNECTION = { baseUrl: "http://127.0.0.1:8080", apiKey: "" };
const KEYED = { baseUrl: "http://127.0.0.1:8080", apiKey: "sk-abc" };
const LISTEN_ROW = { key: "address", value: "127.0.0.1:8080" };

const ROUTER_PROPS = {
  role: "router",
  build_info: "b9960-a935fbffe",
  max_instances: 4,
  models_autoload: false,
};

const LOADED_MODEL = {
  id: "M1",
  status: { value: "loaded", args: [] },
  architecture: { output_modalities: ["text"] },
  meta: { ftype: "Q4_0", size: 423_018_496, n_ctx: 40960 },
};
const UNLOADED_MODEL = {
  id: "M2",
  status: { value: "unloaded", args: [] },
  architecture: { output_modalities: ["text"] },
};
const MODELS_BODY = { object: "list", data: [LOADED_MODEL, UNLOADED_MODEL] };

const IDLE_SLOTS = [
  { id: 0, n_ctx: 40960, is_processing: false },
  { id: 1, n_ctx: 40960, is_processing: false },
];
const BUSY_SLOTS = [
  { id: 0, n_ctx: 40960, is_processing: true, n_prompt_tokens: 27, next_token: [{ n_decoded: 5 }] },
  { id: 1, n_ctx: 40960, is_processing: false },
];
const METRICS_TEXT = "llamacpp:predicted_tokens_seconds 63.42\n";

/** xorshift32 — deterministic, matching the mock source's own test harness. */
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

/** A pinned mock with every ticker unscheduled, so snapshots are deterministic. */
function createFallback(overrides: MockSourceOptions = {}): StewardDataSource {
  return createMockSource({
    random: seededRandom(20260726),
    now: () => FIXED_NOW,
    logIntervalMs: 0,
    metricsIntervalMs: 0,
    throughputIntervalMs: 0,
    ...overrides,
  });
}

type Response = Awaited<ReturnType<FetchLike>>;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function textResponse(status: number, text: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(text),
  };
}

interface Handlers {
  props?: () => Promise<Response>;
  models?: () => Promise<Response>;
  slots?: (url: string) => Promise<Response>;
  metrics?: (url: string) => Promise<Response>;
  post?: (
    url: string,
    body: unknown,
    headers: Record<string, string> | undefined,
  ) => Promise<Response>;
}

/** A fetch that dispatches by path, so each endpoint can be scripted apart. */
function routerFetch(handlers: Handlers): FetchLike {
  return (url, init) => {
    if (url.includes("/models/load") || url.includes("/models/unload")) {
      const body: unknown = init?.body === undefined ? undefined : JSON.parse(init.body);
      return (handlers.post ?? (() => Promise.resolve(jsonResponse(200, { success: true }))))(
        url,
        body,
        init?.headers,
      );
    }
    if (url.includes("/props")) {
      return (handlers.props ?? (() => Promise.resolve(jsonResponse(200, ROUTER_PROPS))))();
    }
    if (url.includes("/slots")) {
      return (handlers.slots ?? (() => Promise.resolve(jsonResponse(200, IDLE_SLOTS))))(url);
    }
    if (url.includes("/metrics")) {
      return (handlers.metrics ?? (() => Promise.resolve(textResponse(200, METRICS_TEXT))))(url);
    }
    if (url.includes("/models")) {
      return (handlers.models ?? (() => Promise.resolve(jsonResponse(200, MODELS_BODY))))();
    }
    return Promise.reject(new Error(`unrouted ${url}`));
  };
}

const refused: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"));

describe("LlamaSource — snapshot overlay", () => {
  it("names itself llama.cpp", () => {
    const source = new LlamaSource({ connection: CONNECTION, fallback: createFallback() });
    try {
      expect(source.name).toBe("llama.cpp");
    } finally {
      source.close();
    }
  });

  it("overlays config, models and slots and leaves the other panels to the fallback", async () => {
    const fallback = createFallback();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback,
      fetch: routerFetch({}),
    });
    try {
      const reference = await fallback.snapshot();
      const snapshot = await source.snapshot();

      expect(snapshot.config[0]).toEqual({ key: "mode", value: "routed" });
      expect(snapshot.models.map((m) => m.id)).toEqual(["M1", "M2"]);
      expect(snapshot.models[0]).toMatchObject({
        status: "resident",
        parallel: 2,
        ctx: 40960,
        tokensPerSecond: null,
      });
      expect(snapshot.models[0]?.sizeGB).toBeCloseTo(0.423, 3);
      expect(snapshot.models[1]).toMatchObject({ id: "M2", status: "unloaded" });
      expect(snapshot.slots).toHaveLength(2);
      expect(snapshot.slots.every((slot) => slot.modelId === "M1")).toBe(true);

      // SERVICE is live too: reachable server reads running, build from /props,
      // host/port from the connection; pid/uptime are n/a with no probe injected.
      expect(snapshot.service).toEqual({
        running: true,
        startedAt: null,
        pid: null,
        host: "127.0.0.1",
        port: 8080,
        build: "b9960-a935fbffe",
        // No controller injected: the machine has declared no consented
        // commands, so the block offers none.
        controls: [],
      });

      // Throughput and requests are live: the idle default slots mean no model
      // is processing, so throughput reads 0, and the request gauges (absent
      // from the metrics body) read 0 — not the mock's invented figures.
      expect(snapshot.throughputTps).toBe(0);
      expect(snapshot.throughputHistory).toEqual([0]);
      expect(snapshot.requestsInFlight).toBe(0);
      expect(snapshot.requestsQueued).toBe(0);

      // Drift is the live source's own answer, never the fallback's: with no
      // recorded argv there is nothing to re-check, and that is reported as
      // "unknown" rather than borrowed from the simulation.
      expect(snapshot.drift).toEqual({
        launch: {
          status: "unknown",
          added: [],
          removed: [],
          program: null,
          reason: "no launch command was recorded for this machine",
        },
        consent: { hostCollector: false, controls: [] },
      });

      // Everything else must be exactly the fallback's.
      const { config: _c, models: _m, slots: _s, service: _sv, ...liveRest } = snapshot;
      const { config: _c2, models: _m2, slots: _s2, service: _sv2, ...mockRest } = reference;
      const strip = ({
        throughputTps: _t,
        throughputHistory: _h,
        requestsInFlight: _i,
        requestsQueued: _q,
        drift: _d,
        ...rest
      }: typeof liveRest) => rest;
      expect(strip(liveRest)).toEqual(strip(mockRest));
    } finally {
      source.close();
    }
  });

  it("aggregates live throughput and request gauges from a processing model", async () => {
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({
        slots: () => Promise.resolve(jsonResponse(200, BUSY_SLOTS)),
        metrics: () =>
          Promise.resolve(
            textResponse(
              200,
              "llamacpp:predicted_tokens_seconds 63.42\nllamacpp:requests_processing 1\nllamacpp:requests_deferred 3\n",
            ),
          ),
      }),
    });
    try {
      const snapshot = await source.snapshot();
      // predicted_tokens_seconds, counted because a slot is busy.
      expect(snapshot.throughputTps).toBeCloseTo(63.42, 2);
      expect(snapshot.throughputHistory).toEqual([snapshot.throughputTps]);
      // The real in-flight and queued gauges, taken as-is.
      expect(snapshot.requestsInFlight).toBe(1);
      expect(snapshot.requestsQueued).toBe(3);
    } finally {
      source.close();
    }
  });

  it("reports a live pid and uptime from the injected process probe", async () => {
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
      probeService: (host, port) => {
        expect(host).toBe("127.0.0.1");
        expect(port).toBe(8080);
        return Promise.resolve({ pid: 4242, startedAt: FIXED_NOW - 60_000 });
      },
    });
    try {
      const snapshot = await source.snapshot();
      expect(snapshot.service.running).toBe(true);
      expect(snapshot.service.pid).toBe(4242);
      expect(snapshot.service.startedAt).toBe(FIXED_NOW - 60_000);
    } finally {
      source.close();
    }
  });

  it("survives a probe that throws, degrading pid and uptime to n/a", async () => {
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
      probeService: () => Promise.reject(new Error("lsof missing")),
    });
    try {
      const snapshot = await source.snapshot();
      expect(snapshot.service.running).toBe(true);
      expect(snapshot.service.pid).toBeNull();
      expect(snapshot.service.startedAt).toBeNull();
    } finally {
      source.close();
    }
  });

  it("upgrades a model to active with a rate when one of its slots is processing", async () => {
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({ slots: () => Promise.resolve(jsonResponse(200, BUSY_SLOTS)) }),
    });
    try {
      const snapshot = await source.snapshot();
      expect(snapshot.models[0]).toMatchObject({ status: "active", tokensPerSecond: 63.42 });
      const processing = snapshot.slots.filter((slot) => slot.state === "processing");
      expect(processing).toHaveLength(1);
      expect(processing[0]).toMatchObject({ promptTokens: 27, decoded: 5, ctxTotal: 40960 });
    } finally {
      source.close();
    }
  });

  it("degrades models and slots to empty when /models fails, but keeps config", async () => {
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({ models: () => Promise.resolve(jsonResponse(503, { error: "x" })) }),
    });
    try {
      const snapshot = await source.snapshot();
      expect(snapshot.models).toEqual([]);
      expect(snapshot.slots).toEqual([]);
      // Config is read independently, so it survives a models outage.
      expect(snapshot.config[0]).toEqual({ key: "mode", value: "routed" });
    } finally {
      source.close();
    }
  });

  it("drops only the affected group when a per-model /slots read fails", async () => {
    const twoLoaded = {
      object: "list",
      data: [LOADED_MODEL, { ...LOADED_MODEL, id: "M3" }],
    };
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({
        models: () => Promise.resolve(jsonResponse(200, twoLoaded)),
        slots: (url) =>
          url.includes("M3")
            ? Promise.reject(new Error("reset"))
            : Promise.resolve(jsonResponse(200, IDLE_SLOTS)),
      }),
    });
    try {
      const snapshot = await source.snapshot();
      // Both models still appear; only M3's slots are gone.
      expect(snapshot.models.map((m) => m.id)).toEqual(["M1", "M3"]);
      expect(new Set(snapshot.slots.map((s) => s.modelId))).toEqual(new Set(["M1"]));
      expect(snapshot.models[1]).toMatchObject({ id: "M3", status: "resident" });
    } finally {
      source.close();
    }
  });

  it("degrades every live panel but keeps the fallback when the server is down", async () => {
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: refused,
    });
    try {
      const snapshot = await source.snapshot();
      expect(snapshot.config).toEqual([
        { key: "status", value: "llama.cpp not reachable" },
        LISTEN_ROW,
      ]);
      expect(snapshot.models).toEqual([]);
      expect(snapshot.slots).toEqual([]);
      // Throughput is live: a dead server generates nothing, so it reads 0 and
      // seeds the history with a real 0 rather than the mock's 42-sample series.
      expect(snapshot.throughputTps).toBe(0);
      expect(snapshot.throughputHistory).toEqual([0]);
      // The host band and requests still animate from the mock (not migrated),
      // and the static topology rides through from the fallback via `...base`.
      expect(snapshot.metrics.vramTotalGB).toBeGreaterThan(0);
      expect(snapshot.memoryTopology).toBe("discrete");
      // SERVICE is live now: an unreachable server reads stopped, with no
      // fabricated uptime or pid — not the mock's standing "running".
      expect(snapshot.service.running).toBe(false);
      expect(snapshot.service.startedAt).toBeNull();
      expect(snapshot.service.pid).toBeNull();
    } finally {
      source.close();
    }
  });

  it("shows the login overlay on a 401 to /props", async () => {
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({
        props: () => Promise.resolve(jsonResponse(401, { error: "unauthorized" })),
      }),
    });
    try {
      expect((await source.snapshot()).config).toEqual([
        { key: "status", value: "API key required — run /login llama.cpp" },
        LISTEN_ROW,
      ]);
    } finally {
      source.close();
    }
  });

  it("aborts an in-flight read and closes the fallback on close()", async () => {
    let fallbackClosed = false;
    const inner = createFallback();
    const fallback: StewardDataSource = {
      ...inner,
      close() {
        fallbackClosed = true;
        inner.close();
      },
    };

    let signal: AbortSignal | undefined;
    const hanging: FetchLike = (_input, init) => {
      signal = init?.signal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };

    const source = new LlamaSource({ connection: CONNECTION, fallback, fetch: hanging });
    const pending = source.snapshot();
    await Promise.resolve();
    await Promise.resolve();

    source.close();
    const snapshot = await pending;

    expect(signal?.aborted).toBe(true);
    expect(fallbackClosed).toBe(true);
    expect(snapshot.models).toEqual([]);
    expect(snapshot.config).toEqual([
      { key: "status", value: "llama.cpp not reachable" },
      LISTEN_ROW,
    ]);
  });
});

describe("LlamaSource — setModel", () => {
  it("POSTs the load body with the bearer and resolves on success", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> | undefined }[] = [];
    const source = new LlamaSource({
      connection: KEYED,
      fallback: createFallback(),
      fetch: routerFetch({
        post: (url, body, headers) => {
          calls.push({ url, body, headers });
          return Promise.resolve(jsonResponse(200, { success: true }));
        },
      }),
    });
    try {
      await expect(source.setModel("M1", "load")).resolves.toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toContain("/models/load");
      expect(calls[0]?.body).toEqual({ model: "M1" });
      expect(calls[0]?.headers?.Authorization).toBe("Bearer sk-abc");
    } finally {
      source.close();
    }
  });

  it("POSTs to the unload path", async () => {
    const urls: string[] = [];
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({
        post: (target) => {
          urls.push(target);
          return Promise.resolve(jsonResponse(200, { success: true }));
        },
      }),
    });
    try {
      await source.setModel("M1", "unload");
      expect(urls[0]).toContain("/models/unload");
    } finally {
      source.close();
    }
  });

  it("sends no bearer header when the connection is keyless", async () => {
    const headerSets: (Record<string, string> | undefined)[] = [];
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({
        post: (_url, _body, sent) => {
          headerSets.push(sent);
          return Promise.resolve(jsonResponse(200, { success: true }));
        },
      }),
    });
    try {
      await source.setModel("M1", "load");
      expect(headerSets[0]?.Authorization).toBeUndefined();
    } finally {
      source.close();
    }
  });

  it("rejects with a readable message on a 404", async () => {
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({
        post: () => Promise.resolve(jsonResponse(404, { error: { code: 404 } })),
      }),
    });
    try {
      await expect(source.setModel("bogus", "load")).rejects.toThrow("load failed: HTTP 404");
    } finally {
      source.close();
    }
  });

  it("rejects when a 200 does not confirm success", async () => {
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({ post: () => Promise.resolve(jsonResponse(200, { success: false })) }),
    });
    try {
      await expect(source.setModel("M1", "load")).rejects.toThrow(/did not confirm/);
    } finally {
      source.close();
    }
  });
});

describe("LlamaSource — setService", () => {
  /** A controller that records what it was asked to run and answers to script. */
  function fakeController(
    result: ServiceControlResult,
    actions: ServiceAction[] = ["start", "stop", "restart"],
  ): { control: ServiceController; ran: ServiceAction[] } {
    const ran: ServiceAction[] = [];
    return {
      ran,
      control: {
        actions,
        run: (action) => {
          ran.push(action);
          return Promise.resolve(result);
        },
      },
    };
  }

  it("runs the declared command and reports the actions on the snapshot", async () => {
    const { control, ran } = fakeController({ ok: true, detail: null }, ["restart"]);
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
      control,
    });
    try {
      await expect(source.setService("restart")).resolves.toBeUndefined();
      expect(ran).toEqual(["restart"]);
      // The dashboard offers exactly what the controller can run.
      expect((await source.snapshot()).service.controls).toEqual(["restart"]);
    } finally {
      source.close();
    }
  });

  it("offers the same actions while the server is unreachable", async () => {
    const { control } = fakeController({ ok: true, detail: null }, ["start", "restart"]);
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: refused,
      control,
    });
    try {
      const snapshot = await source.snapshot();
      // A stopped service is exactly when Start matters most: availability is
      // config, not a reading.
      expect(snapshot.service.running).toBe(false);
      expect(snapshot.service.controls).toEqual(["start", "restart"]);
    } finally {
      source.close();
    }
  });

  it("rejects with the command's readable detail when it fails", async () => {
    const { control, ran } = fakeController({
      ok: false,
      detail: "launchctl: permission denied",
    });
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
      control,
    });
    try {
      await expect(source.setService("stop")).rejects.toThrow("launchctl: permission denied");
      expect(ran).toEqual(["stop"]);
    } finally {
      source.close();
    }
  });

  it("rejects readably even when the failure carries no detail", async () => {
    const { control } = fakeController({ ok: false, detail: null });
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
      control,
    });
    try {
      await expect(source.setService("start")).rejects.toThrow(/start/);
    } finally {
      source.close();
    }
  });

  it("delegates to the fallback, unchanged, when no controller is configured", async () => {
    const fallback = createFallback();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback,
      // The mock's own service state is what moves; the live /props read is
      // scripted as unreachable so nothing else confuses the assertion.
      fetch: refused,
    });
    try {
      await source.setService("stop");
      expect((await fallback.snapshot()).service.running).toBe(false);
      await source.setService("start");
      expect((await fallback.snapshot()).service.running).toBe(true);
      // …and with no controller there is nothing to offer.
      expect((await source.snapshot()).service.controls).toEqual([]);
    } finally {
      source.close();
    }
  });
});

describe("LlamaSource — host overlay", () => {
  /** A unified-memory reading: no VRAM figures, the rest real. */
  const UNIFIED_READING: HostReading = {
    ts: FIXED_NOW,
    gpuUtil: 0.42,
    gpuTempC: 55,
    cpuUtil: 0.2,
    cpuTempC: 44,
    ramUsedGB: 70,
    ramTotalGB: 128,
    vramUsedGB: null,
    vramTotalGB: null,
  };

  /** A fake collector plus a topology and staleness horizon, and a close counter. */
  function hostOverlay(
    sample: HostSample | null,
    opts: { topology?: MemoryTopology; staleMs?: number } = {},
  ): { overlay: HostMetricsOverlay; closes: () => number } {
    let closeCount = 0;
    const provider: HostMetricsProvider = {
      latest: () => sample,
      close: () => {
        closeCount += 1;
      },
    };
    return {
      overlay: { provider, topology: opts.topology ?? "unified", staleMs: opts.staleMs ?? 4500 },
      closes: () => closeCount,
    };
  }

  it("overlays real metrics and the config topology from a fresh sample", async () => {
    const { overlay } = hostOverlay({ reading: UNIFIED_READING, receivedAt: FIXED_NOW - 100 });
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
      host: overlay,
    });
    try {
      const snapshot = await source.snapshot();
      expect(snapshot.memoryTopology).toBe("unified");
      expect(snapshot.metrics.ramUsedGB).toBe(70);
      expect(snapshot.metrics.gpuUtil).toBeCloseTo(0.42, 5);
      expect(snapshot.metrics.gpuTempC).toBe(55);
      // Unified omits VRAM, so those figures are no-readings, never a synth 0.
      expect(Number.isNaN(snapshot.metrics.vramUsedGB)).toBe(true);
      expect(Number.isNaN(snapshot.metrics.vramTotalGB)).toBe(true);
    } finally {
      source.close();
    }
  });

  it("passes VRAM through for a discrete reading", async () => {
    const discrete: HostReading = { ...UNIFIED_READING, vramUsedGB: 9.1, vramTotalGB: 24 };
    const { overlay } = hostOverlay(
      { reading: discrete, receivedAt: FIXED_NOW - 100 },
      { topology: "discrete" },
    );
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
      host: overlay,
    });
    try {
      const snapshot = await source.snapshot();
      expect(snapshot.memoryTopology).toBe("discrete");
      expect(snapshot.metrics.vramUsedGB).toBe(9.1);
      expect(snapshot.metrics.vramTotalGB).toBe(24);
    } finally {
      source.close();
    }
  });

  it("nulls the readings of a stale sample but keeps the topology", async () => {
    const { overlay } = hostOverlay(
      { reading: UNIFIED_READING, receivedAt: FIXED_NOW - 10_000 },
      { staleMs: 4500 },
    );
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
      host: overlay,
    });
    try {
      const snapshot = await source.snapshot();
      // Topology is static config — it survives; the held-stale numbers do not.
      expect(snapshot.memoryTopology).toBe("unified");
      expect(Number.isNaN(snapshot.metrics.ramUsedGB)).toBe(true);
      expect(Number.isNaN(snapshot.metrics.gpuUtil)).toBe(true);
      expect(snapshot.metrics.gpuTempC).toBeNull();
      expect(snapshot.metrics.cpuTempC).toBeNull();
    } finally {
      source.close();
    }
  });

  it("nulls the readings while warming (no sample yet) but keeps the topology", async () => {
    const { overlay } = hostOverlay(null);
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
      host: overlay,
    });
    try {
      const snapshot = await source.snapshot();
      expect(snapshot.memoryTopology).toBe("unified");
      expect(Number.isNaN(snapshot.metrics.gpuUtil)).toBe(true);
      expect(snapshot.metrics.gpuTempC).toBeNull();
    } finally {
      source.close();
    }
  });

  it("leaves the fallback host band untouched when no collector is configured", async () => {
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
    });
    try {
      const snapshot = await source.snapshot();
      // The mock's discrete VRAM+RAM band, unchanged — the same behaviour as before.
      expect(snapshot.memoryTopology).toBe("discrete");
      expect(snapshot.metrics.vramTotalGB).toBeGreaterThan(0);
    } finally {
      source.close();
    }
  });

  it("closes the collector on close()", async () => {
    const { overlay, closes } = hostOverlay({
      reading: UNIFIED_READING,
      receivedAt: FIXED_NOW - 100,
    });
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
      host: overlay,
    });
    await source.snapshot();
    source.close();
    expect(closes()).toBe(1);
  });
});

describe("LlamaSource — drift", () => {
  const DRIFTED = {
    status: "drifted" as const,
    added: [],
    removed: ["--metrics"],
    program: null,
    reason: null,
  };

  it("carries the probe's verdict onto the snapshot", async () => {
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
      probeDrift: async () => DRIFTED,
    });
    try {
      const snapshot = await source.snapshot();
      expect(snapshot.drift.launch).toEqual(DRIFTED);
    } finally {
      source.close();
    }
  });

  it("checks the very process the SERVICE block reported, not a second lookup", async () => {
    // One pid resolution per snapshot: re-resolving it here would cost another
    // `lsof` AND let the two land on different processes across a restart, so
    // the notice could describe a process the SERVICE block is not showing.
    const seen: (number | null)[] = [];
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
      probeService: async () => ({ pid: 4821, startedAt: null }),
      probeDrift: async (pid) => {
        seen.push(pid);
        return DRIFTED;
      },
    });
    try {
      const snapshot = await source.snapshot();
      expect(snapshot.service.pid).toBe(4821);
      expect(seen).toEqual([4821]);
    } finally {
      source.close();
    }
  });

  it("hands the probe a null pid when the process could not be identified", async () => {
    // No service probe configured (or one that found nothing): the check is
    // unavailable, and the probe is the one that says so.
    const seen: (number | null)[] = [];
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
      probeDrift: async (pid) => {
        seen.push(pid);
        return { ...DRIFTED, status: "unknown" as const, reason: "no pid" };
      },
    });
    try {
      expect((await source.snapshot()).drift.launch.status).toBe("unknown");
      expect(seen).toEqual([null]);
    } finally {
      source.close();
    }
  });

  it("reports unknown — never clean — when no launch argv was recorded", async () => {
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
    });
    try {
      const snapshot = await source.snapshot();
      expect(snapshot.drift.launch.status).toBe("unknown");
      expect(snapshot.drift.launch.reason).toBe("no launch command was recorded for this machine");
    } finally {
      source.close();
    }
  });

  it("does not judge the flags of a service that is not running", async () => {
    // Nothing is listening, so there is no argv to read: a "clean" verdict here
    // would be an assertion about a process that does not exist.
    let probed = false;
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: refused,
      probeDrift: async () => {
        probed = true;
        return DRIFTED;
      },
    });
    try {
      const snapshot = await source.snapshot();
      expect(snapshot.service.running).toBe(false);
      expect(snapshot.drift.launch).toMatchObject({
        status: "unknown",
        reason: "the service is not running",
      });
      expect(probed).toBe(false);
    } finally {
      source.close();
    }
  });

  it("degrades to unknown when the probe rejects, rather than failing the snapshot", async () => {
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
      probeDrift: async () => {
        throw new Error("lsof exploded");
      },
    });
    try {
      const snapshot = await source.snapshot();
      expect(snapshot.drift.launch.status).toBe("unknown");
      // The rest of the snapshot is untouched: a failed drift check may never
      // be the reason a repaint loses its live panels.
      expect(snapshot.models.map((m) => m.id)).toEqual(["M1", "M2"]);
    } finally {
      source.close();
    }
  });

  it("reports declared-but-unapproved commands every snapshot, running or not", async () => {
    // Consent drift is config, not a reading — it does not depend on the server
    // being reachable, and a stopped service must still explain its dead buttons.
    const consentDrift = { hostCollector: true, controls: ["stop" as const] };
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: refused,
      consentDrift,
    });
    try {
      expect((await source.snapshot()).drift.consent).toEqual(consentDrift);
    } finally {
      source.close();
    }
  });
});

describe("LlamaSource — log console", () => {
  /** A tailer stub that records what the source asks of it. */
  function fakeTailer(): LogTailer & {
    ports: ReadonlyMap<number, string>[];
    closed: number;
    listeners: number;
    attached: number;
  } {
    const state = {
      ports: [] as ReadonlyMap<number, string>[],
      closed: 0,
      listeners: 0,
      attached: 0,
      recent(limit: number): LogLine[] {
        return [
          {
            seq: limit,
            ts: FIXED_NOW,
            level: "INFO" as const,
            modelId: null,
            message: "srv  llama_server: model loaded",
            kind: "event" as const,
            origin: "router" as const,
          },
        ];
      },
      subscribe(_listener: (line: LogLine) => void): () => void {
        state.listeners += 1;
        return () => {
          state.listeners -= 1;
        };
      },
      attach(listener: (line: LogLine) => void, limit: number) {
        state.attached += 1;
        return { backlog: state.recent(limit), unsubscribe: state.subscribe(listener) };
      },
      setPorts(ports: ReadonlyMap<number, string>): void {
        state.ports.push(ports);
      },
      status(): LogStreamStatus {
        return { source: "missing" as const, path: "/tmp/llama-router.log", detail: "gone" };
      },
      close(): void {
        state.closed += 1;
      },
    };
    return state;
  }

  it("serves real lines from the tailer instead of the fallback's simulated ones", () => {
    const logTail = fakeTailer();
    const fallback = createFallback();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback,
      fetch: routerFetch({}),
      logTail,
    });
    try {
      // The tailer's buffer, not the mock's — the console stops being a
      // simulation the moment a real log source exists.
      expect(source.recentLogs(7)).toEqual([
        {
          seq: 7,
          ts: FIXED_NOW,
          level: "INFO",
          modelId: null,
          message: "srv  llama_server: model loaded",
          kind: "event",
          origin: "router",
        },
      ]);
      // The source holds one subscription of its own — the slot-activity fold
      // that replaced the per-model polls — so the console's is the second.
      expect(logTail.listeners).toBe(1);
      const unsubscribe = source.subscribeLogs(() => undefined);
      expect(logTail.listeners).toBe(2);
      unsubscribe();
      expect(logTail.listeners).toBe(1);
      // And the source reports the log's own health, which "no lines" cannot.
      expect(source.logStatus()).toEqual({
        source: "missing",
        path: "/tmp/llama-router.log",
        detail: "gone",
      });
    } finally {
      source.close();
    }
    expect(logTail.closed).toBe(1);
  });

  it("opens the console in one step, so no line falls between backlog and stream", () => {
    const logTail = fakeTailer();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({}),
      logTail,
    });
    try {
      const { backlog, unsubscribe } = source.attachLogs(() => undefined, 3);
      // The tailer's own atomic path — not a `recent` followed by a `subscribe`,
      // which a poll landing in between would empty out of both. The source's
      // own slot-activity fold attaches the same way in the constructor, so this
      // is the second attach and the second listener.
      expect(logTail.attached).toBe(2);
      expect(backlog).toHaveLength(1);
      expect(logTail.listeners).toBe(2);
      unsubscribe();
      expect(logTail.listeners).toBe(1);
    } finally {
      source.close();
    }
  });

  it("opens the console atomically through the fallback too", () => {
    // The mock, unwrapped, so the test can move the simulation by hand.
    const fallback = createMockSource({
      random: seededRandom(20260726),
      now: () => FIXED_NOW,
      logIntervalMs: 0,
      metricsIntervalMs: 0,
      throughputIntervalMs: 0,
    });
    const source = new LlamaSource({ connection: CONNECTION, fallback, fetch: routerFetch({}) });
    try {
      const seen: number[] = [];
      const { backlog, unsubscribe } = source.attachLogs((line) => seen.push(line.seq), 4);
      expect(backlog).toEqual(fallback.recentLogs(4));

      fallback.tickLogs();
      expect(seen.length).toBeGreaterThan(0);
      // No repeat at the seam: everything delivered live is newer than the
      // backlog it was handed.
      const newest = backlog.at(-1)?.seq ?? 0;
      expect(seen.every((seq) => seq > newest)).toBe(true);

      unsubscribe();
      const delivered = seen.length;
      fallback.tickLogs();
      expect(seen).toHaveLength(delivered);
    } finally {
      source.close();
    }
  });

  it("keeps today's fallback behaviour exactly when no tailer is configured", () => {
    const fallback = createFallback();
    const source = new LlamaSource({ connection: CONNECTION, fallback, fetch: routerFetch({}) });
    try {
      expect(source.recentLogs(5)).toEqual(fallback.recentLogs(5));
      const seen: number[] = [];
      const unsubscribe = source.subscribeLogs((line) => seen.push(line.seq));
      // Delivered by the fallback, exactly as before.
      expect(typeof unsubscribe).toBe("function");
      unsubscribe();
      // With no log source there is nothing to watch, and saying so is not the
      // same as reporting a healthy but silent stream.
      expect(source.logStatus().source).toBe("unavailable");
      expect(source.logStatus().path).toBeNull();
    } finally {
      source.close();
    }
  });

  it("refreshes the tailer's port map from /models on every snapshot", async () => {
    const logTail = fakeTailer();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({
        models: () =>
          Promise.resolve(
            jsonResponse(200, {
              object: "list",
              data: [
                { id: "M1", status: { value: "loaded", args: ["--port", "53691"] } },
                // An unloaded preset carries `--port 0`, which is not a port.
                { id: "M2", status: { value: "unloaded", args: ["--port", "0"] } },
              ],
            }),
          ),
      }),
      logTail,
    });
    try {
      await source.snapshot();
      expect(logTail.ports).toHaveLength(1);
      expect([...(logTail.ports[0] ?? [])]).toEqual([[53691, "M1"]]);
    } finally {
      source.close();
    }
  });

  it("hands the tailer an empty map rather than a wrong one when /models fails", async () => {
    // The tailer keeps its last known mapping; what matters here is that the
    // source never invents ports from a failed read.
    const logTail = fakeTailer();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: refused,
      logTail,
    });
    try {
      await source.snapshot();
      expect([...(logTail.ports[0] ?? [])]).toEqual([]);
    } finally {
      source.close();
    }
  });
});

/**
 * SLOTS from the log rather than from a timer.
 *
 * The old path asked `/slots?model=X` and `/metrics?model=X` for every loaded
 * model on the dashboard's 1.6 s repaint clock. Both are per-model, so the
 * router proxied each one to the child and wrote a `proxy_reques:` line for it —
 * 86.9% of a real corpus, and most of it Steward watching itself. It was also
 * sampled, so a request shorter than the interval was missed outright.
 *
 * These tests hold both halves of the fix: the counts are right, AND the polls
 * are gone. The second one is the part that silently regresses, so it is
 * asserted directly rather than inferred.
 */
describe("LlamaSource — slots from the log", () => {
  /** A loaded model whose launch args state its port, lanes and context. */
  const PORTED_MODEL = {
    id: "M1",
    status: {
      value: "loaded",
      args: ["--port", "53093", "--parallel", "2", "--ctx-size", "8192"],
    },
    architecture: { output_modalities: ["text"] },
    meta: { ftype: "Q4_0", size: 423_018_496, n_ctx: 4096 },
  };
  const PORTED_BODY = { object: "list", data: [PORTED_MODEL, UNLOADED_MODEL] };

  const SELECT =
    "[53093] 736.46.933.316 I slot get_availabl: id  0 | task -1 | selected slot by LCP similarity, sim_best = 0.865 (> 0.100 thold), f_keep = 0.388";
  const LAUNCH =
    "[53093] 736.46.935.806 I slot launch_slot_: id  0 | task 836989 | processing task, is_child = 0";
  const EVAL =
    "[53093] 736.47.702.201 I slot print_timing: id  0 | task 836989 |        eval time =     697.41 ms /    90 tokens (    7.75 ms per token,   129.05 tokens per second)";
  const RELEASE =
    "[53093] 736.47.702.218 I slot      release: id  0 | task 836989 | stop processing: n_tokens = 163, truncated = 0";
  /* A second short request, verbatim, so two of them can be told apart. */
  const LAUNCH_NEXT =
    "[53093] 0.10.212.424 I slot launch_slot_: id  0 | task 93 | processing task, is_child = 0";
  const EVAL_NEXT =
    "[53093] 0.11.163.297 I slot print_timing: id  0 | task 93 |        eval time =     877.77 ms /    90 tokens (    9.75 ms per token,   102.53 tokens per second)";
  const RELEASE_NEXT =
    "[53093] 0.11.163.334 I slot      release: id  0 | task 93 | stop processing: n_tokens = 165, truncated = 0";
  /* One request long enough for llama.cpp to report on while it runs. */
  const LONG_LAUNCH =
    "[53093] 713.55.050.803 I slot launch_slot_: id  0 | task 806583 | processing task, is_child = 0";
  const LONG_TG_1 =
    "[53093] 713.58.130.031 I slot print_timing: id  0 | task 806583 | n_decoded =    370, tg = 123.32 t/s, tg_3s = 123.32 t/s";
  const LONG_TG_2 =
    "[53093] 714.01.132.691 I slot print_timing: id  0 | task 806583 | n_decoded =    725, tg = 120.77 t/s, tg_3s = 118.23 t/s";
  const LONG_EVAL =
    "[53093] 714.02.634.554 I slot print_timing: id  0 | task 806583 |        eval time =    7504.81 ms /   900 tokens (    8.34 ms per token,   119.92 tokens per second)";
  const LONG_RELEASE =
    "[53093] 714.02.634.572 I slot      release: id  0 | task 806583 | stop processing: n_tokens = 977, truncated = 0";

  /** A tailer the test drives by hand, one real log line at a time. */
  function liveTailer(): LogTailer & {
    emit(raw: string, at?: number): void;
    setSource(source: LogStreamStatus["source"]): void;
  } {
    const listeners = new Set<(line: LogLine) => void>();
    let source: LogStreamStatus["source"] = "ok";
    let seq = 0;
    return {
      emit(raw: string, at: number = FIXED_NOW): void {
        seq += 1;
        const parsed = parseLogLine(raw);
        const emitted: LogLine = {
          seq,
          ts: at,
          level: parsed.level,
          modelId: parsed.modelName,
          message: parsed.message,
          kind: parsed.kind,
          origin: parsed.origin,
          family: parsed.family,
          ...(parsed.port === null ? {} : { port: parsed.port }),
          ...(parsed.frame === null ? {} : { frame: parsed.frame }),
        };
        for (const listener of listeners) listener(emitted);
      },
      setSource(next: LogStreamStatus["source"]): void {
        source = next;
      },
      recent: () => [],
      subscribe(listener: (line: LogLine) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      attach(listener: (line: LogLine) => void) {
        listeners.add(listener);
        return {
          backlog: [],
          unsubscribe: () => {
            listeners.delete(listener);
          },
        };
      },
      setPorts: () => undefined,
      status: (): LogStreamStatus => ({ source, path: "/tmp/llama-router.log", detail: null }),
      close: () => listeners.clear(),
    };
  }

  /** A fetch that records every URL it is asked for. */
  function recordingFetch(handlers: Handlers = {}): FetchLike & { urls: string[] } {
    const inner = routerFetch(handlers);
    const urls: string[] = [];
    const recorded = ((url, init) => {
      urls.push(url);
      return inner(url, init);
    }) as FetchLike & { urls: string[] };
    recorded.urls = urls;
    return recorded;
  }

  // Deliberately counts EVERY hit on the path, not just `?model=` ones: a
  // reintroduced bare `/slots` poll is the same noise by another spelling, and a
  // guard that only matched the per-model form would not have caught it.
  const hits = (urls: string[], path: string) =>
    urls.filter((url) => new URL(url).pathname === path).length;

  it("never polls /slots or /metrics on the snapshot clock", async () => {
    // THE REGRESSION GUARD. Five snapshots on the old path meant ten proxied
    // requests and ten log lines; here it is one `/slots` read for the child's
    // whole life and no `/metrics` at all.
    const fetch = recordingFetch({ models: () => Promise.resolve(jsonResponse(200, PORTED_BODY)) });
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch,
      logTail: liveTailer(),
    });
    try {
      for (let round = 0; round < 5; round += 1) await source.snapshot();
      expect(hits(fetch.urls, "/slots")).toBe(1);
      expect(hits(fetch.urls, "/metrics")).toBe(0);
    } finally {
      source.close();
    }
  });

  it("keeps polling when there is no log source, and only then", async () => {
    // The either/or, from the other side. A Steward with no log has no other way
    // to know anything, so the per-model reads are still the right answer there
    // — but they must never run alongside the event stream.
    const fetch = recordingFetch({ models: () => Promise.resolve(jsonResponse(200, PORTED_BODY)) });
    const source = new LlamaSource({ connection: CONNECTION, fallback: createFallback(), fetch });
    try {
      for (let round = 0; round < 3; round += 1) await source.snapshot();
      expect(hits(fetch.urls, "/slots")).toBe(3);
      expect(hits(fetch.urls, "/metrics")).toBe(3);
    } finally {
      source.close();
    }
  });

  it("catches a request that begins and ends inside one poll interval", async () => {
    const logTail = liveTailer();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({ models: () => Promise.resolve(jsonResponse(200, PORTED_BODY)) }),
      logTail,
    });
    try {
      // Seeded idle from the one-shot read.
      const before = await source.snapshot();
      expect(before.slots.map((slot) => slot.state)).toEqual(["idle", "idle"]);
      expect(before.requestsInFlight).toBe(0);
      // Occupancy is known from the first snapshot; throughput is not, because
      // no span of wall clock has been measured yet. A dash, never a 0.
      expect(before.throughputTps).toBeNull();

      logTail.emit(SELECT);
      logTail.emit(LAUNCH);
      const during = await source.snapshot();
      // The lane the request landed in is busy, and the model is `active` —
      // the state a 1.6 s sample of a 0.77 s request would have missed.
      expect(during.slots[0]?.state).toBe("processing");
      expect(during.slots[1]?.state).toBe("idle");
      expect(during.requestsInFlight).toBe(1);
      expect(during.models[0]?.status).toBe("active");

      logTail.emit(EVAL);
      logTail.emit(RELEASE);
      const after = await source.snapshot();
      expect(after.slots.map((slot) => slot.state)).toEqual(["idle", "idle"]);
      expect(after.requestsInFlight).toBe(0);
      expect(after.models[0]?.status).toBe("resident");
    } finally {
      source.close();
    }
  });

  it("counts a completed short request into the window it landed in", async () => {
    // THE REGRESSION. This request generates 90 tokens in 0.77 s and prints its
    // rate 17 microseconds before its release, so on the 1.6 s snapshot clock
    // the rate is never observable — and 90 tokens is under the 100 llama.cpp
    // needs before it prints a live one, which is 99.4% of a real corpus. Read
    // as a rate, this request is invisible and the tile reads 0 → dash → 0
    // forever. Read as tokens over wall clock, it is 90 tokens in a 3 s window.
    let clock = FIXED_NOW;
    const logTail = liveTailer();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback({ now: () => clock }),
      fetch: routerFetch({ models: () => Promise.resolve(jsonResponse(200, PORTED_BODY)) }),
      logTail,
    });
    try {
      // The first snapshot starts the accounting: nothing has been timed yet, so
      // the tile dashes rather than claiming a quiet server.
      const opening = await source.snapshot();
      expect(opening.throughputTps).toBeNull();
      expect(opening.throughputHistory).toEqual([]);
      expect(opening.throughputWindowSeconds).toBeNull();

      // The whole request — both edges — lands between two snapshots.
      logTail.emit(LAUNCH);
      logTail.emit(EVAL);
      logTail.emit(RELEASE);
      clock += THROUGHPUT_SAMPLE_SECONDS * 1000;

      const measured = await source.snapshot();
      expect(measured.throughputHistory).toEqual([30]);
      expect(measured.throughputTps).toBeCloseTo(30, 6);
      expect(measured.throughputWindowSeconds).toBeCloseTo(3, 6);
    } finally {
      source.close();
    }
  });

  it("still reports a long request while it is running", async () => {
    // The 1.4% of requests llama.cpp does report on: past 100 tokens and ~3 s it
    // prints a running readout, and those tokens are counted as they are
    // decoded rather than waiting for the request to end. The model's own card
    // still shows the live RATE, which is the question a single model can
    // answer — it is the box-wide tile that cannot.
    let clock = FIXED_NOW;
    const logTail = liveTailer();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback({ now: () => clock }),
      fetch: routerFetch({ models: () => Promise.resolve(jsonResponse(200, PORTED_BODY)) }),
      logTail,
    });
    try {
      await source.snapshot();
      logTail.emit(LONG_LAUNCH);

      // 370 tokens decoded and reported, while the request is still going.
      logTail.emit(LONG_TG_1);
      clock += THROUGHPUT_SAMPLE_SECONDS * 1000;
      const running = await source.snapshot();
      expect(running.throughputHistory).toEqual([370 / 3]);
      expect(running.models[0]?.status).toBe("active");
      expect(running.models[0]?.tokensPerSecond).toBeCloseTo(123.32, 2);

      // The next readout is cumulative; only the 355 it added are new.
      logTail.emit(LONG_TG_2);
      clock += THROUGHPUT_SAMPLE_SECONDS * 1000;
      expect((await source.snapshot()).throughputHistory).toEqual([370 / 3, 355 / 3]);

      // And the end of the request contributes only the 175 no readout covered.
      logTail.emit(LONG_EVAL);
      logTail.emit(LONG_RELEASE);
      clock += THROUGHPUT_SAMPLE_SECONDS * 1000;
      const done = await source.snapshot();
      expect(done.throughputHistory).toEqual([370 / 3, 355 / 3, 175 / 3]);
      // 900 tokens over the 9 s they took, and not one of them counted twice.
      expect(done.throughputTps).toBeCloseTo(100, 6);
      expect(done.throughputWindowSeconds).toBeCloseTo(9, 6);
    } finally {
      source.close();
    }
  });

  it("reads a genuinely idle window as 0, and advances the strip while it does", async () => {
    // Idle IS a measurement here: the window elapsed and the server generated
    // nothing in it. That is what makes the strip a picture of intermittent
    // traffic rather than a row of gaps — and the sample count is what proves it
    // is still advancing rather than frozen at whatever it last managed to read.
    let clock = FIXED_NOW;
    const logTail = liveTailer();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback({ now: () => clock }),
      fetch: routerFetch({ models: () => Promise.resolve(jsonResponse(200, PORTED_BODY)) }),
      logTail,
    });
    try {
      await source.snapshot();
      for (let tick = 0; tick < 3; tick += 1) {
        clock += THROUGHPUT_SAMPLE_SECONDS * 1000;
        await source.snapshot();
      }
      const quiet = await source.snapshot();
      expect(quiet.throughputHistory).toEqual([0, 0, 0]);
      expect(quiet.throughputTps).toBe(0);
      expect(quiet.throughputWindowSeconds).toBeCloseTo(9, 6);
    } finally {
      source.close();
    }
  });

  it("never carries one request's tokens into a later window", async () => {
    // The instinct behind the regression was right: a finished request's figure
    // must not sit on the tile through the idle gap after it. It does not — the
    // tokens go into the window they were reported in and the next window starts
    // empty. A held value would draw [30, 30, 30] here.
    let clock = FIXED_NOW;
    const logTail = liveTailer();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback({ now: () => clock }),
      fetch: routerFetch({ models: () => Promise.resolve(jsonResponse(200, PORTED_BODY)) }),
      logTail,
    });
    try {
      await source.snapshot();

      logTail.emit(LAUNCH);
      logTail.emit(EVAL);
      logTail.emit(RELEASE);
      clock += THROUGHPUT_SAMPLE_SECONDS * 1000;
      await source.snapshot();

      // A silent window, then another request: 90 tokens, once, in the window
      // they were generated in.
      clock += THROUGHPUT_SAMPLE_SECONDS * 1000;
      await source.snapshot();
      logTail.emit(LAUNCH_NEXT);
      logTail.emit(EVAL_NEXT);
      logTail.emit(RELEASE_NEXT);
      clock += THROUGHPUT_SAMPLE_SECONDS * 1000;
      const third = await source.snapshot();

      expect(third.throughputHistory).toEqual([30, 0, 30]);
      // 180 tokens over the 9 s the strip covers — the box's real duty cycle,
      // and nowhere near the 129 t/s either request generated at.
      expect(third.throughputTps).toBeCloseTo(20, 6);
    } finally {
      source.close();
    }
  });

  it("drops a window that has aged out of the span the strip claims to show", async () => {
    // Left alone, the last bars would sit there indefinitely under an axis that
    // says "the last two minutes" — the held-stale-value dishonesty this change
    // removed from the number, relocated into the chart. The tokens banked
    // across the gap go with them: they cover an unknown stretch of wall clock,
    // and piling them into the next bar would draw a spike that never happened.
    let clock = FIXED_NOW;
    const logTail = liveTailer();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback({ now: () => clock }),
      fetch: routerFetch({ models: () => Promise.resolve(jsonResponse(200, PORTED_BODY)) }),
      logTail,
    });
    try {
      await source.snapshot();
      clock += THROUGHPUT_SAMPLE_SECONDS * 1000;
      expect((await source.snapshot()).throughputHistory).toHaveLength(1);

      // Nobody asked for a snapshot for longer than the window itself — a closed
      // tab, a laptop asleep — and a request completed in the meantime.
      clock += THROUGHPUT_HISTORY_SIZE * THROUGHPUT_SAMPLE_SECONDS * 1000 + 1;
      logTail.emit(LAUNCH, clock);
      logTail.emit(EVAL, clock);
      logTail.emit(RELEASE, clock);
      const stale = await source.snapshot();
      // Empty is what "no span we can vouch for" looks like.
      expect(stale.throughputHistory).toEqual([]);
      expect(stale.throughputTps).toBeNull();
      expect(stale.throughputWindowSeconds).toBeNull();

      // And the strip refills from now, rather than resuming an old window.
      clock += THROUGHPUT_SAMPLE_SECONDS * 1000;
      expect((await source.snapshot()).throughputHistory).toEqual([0]);
    } finally {
      source.close();
    }
  });

  it("empties the strip when the log stream breaks under it", async () => {
    // A break means lines were lost, so the tokens generated across it were
    // never counted and any sample straddling it understates a span it claims to
    // measure. The window is not carried across; it starts again.
    let clock = FIXED_NOW;
    const logTail = liveTailer();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback({ now: () => clock }),
      fetch: routerFetch({ models: () => Promise.resolve(jsonResponse(200, PORTED_BODY)) }),
      logTail,
    });
    try {
      await source.snapshot();
      logTail.emit(LAUNCH);
      logTail.emit(EVAL);
      logTail.emit(RELEASE);
      clock += THROUGHPUT_SAMPLE_SECONDS * 1000;
      expect((await source.snapshot()).throughputHistory).toEqual([30]);

      logTail.setSource("missing");
      clock += THROUGHPUT_SAMPLE_SECONDS * 1000;
      const broken = await source.snapshot();
      expect(broken.throughputHistory).toEqual([]);
      expect(broken.throughputTps).toBeNull();
    } finally {
      source.close();
    }
  });

  it("samples the rate gauge instead when there is no log to count tokens", async () => {
    // The polling path, which cannot count tokens: `/metrics` prints its token
    // counter to five significant figures, so a 90-token request is as likely to
    // read 0 as 100. It samples llama.cpp's rate gauge exactly as it always did,
    // and reports NO window — which is how the tile knows not to claim one.
    let clock = FIXED_NOW;
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback({ now: () => clock }),
      fetch: routerFetch({
        models: () => Promise.resolve(jsonResponse(200, PORTED_BODY)),
        slots: () => Promise.resolve(jsonResponse(200, BUSY_SLOTS)),
      }),
    });
    try {
      const first = await source.snapshot();
      expect(first.throughputTps).toBeCloseTo(63.42, 2);
      expect(first.throughputHistory).toEqual([63.42]);
      expect(first.throughputWindowSeconds).toBeNull();

      // Sampling is paced by the clock, not by the call count, so a second
      // browser polling does not fill the strip twice as fast.
      expect((await source.snapshot()).throughputHistory).toHaveLength(1);
      clock += THROUGHPUT_SAMPLE_SECONDS * 1000;
      expect((await source.snapshot()).throughputHistory).toHaveLength(2);

      // And a history older than the window it claims is dropped rather than
      // shown, here exactly as on the event path.
      clock += THROUGHPUT_HISTORY_SIZE * THROUGHPUT_SAMPLE_SECONDS * 1000 + 1;
      expect((await source.snapshot()).throughputHistory).toEqual([63.42]);
    } finally {
      source.close();
    }
  });

  it("reports the queue as unavailable rather than inventing a zero", async () => {
    // `requests_deferred` has no log line at all. Honesty beats completeness:
    // the tile says n/a and the operator knows the difference between an empty
    // queue and a queue nobody can see.
    const logTail = liveTailer();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({ models: () => Promise.resolve(jsonResponse(200, PORTED_BODY)) }),
      logTail,
    });
    try {
      expect((await source.snapshot()).requestsQueued).toBeNull();
    } finally {
      source.close();
    }
  });

  it("decays a missed release to unknown and stops claiming a count", async () => {
    let clock = FIXED_NOW;
    const logTail = liveTailer();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback({ now: () => clock }),
      // The seed read fails throughout, so nothing but the log establishes
      // state — which is also what makes the lost release unrecoverable.
      fetch: routerFetch({
        models: () => Promise.resolve(jsonResponse(200, PORTED_BODY)),
        slots: () => Promise.resolve(jsonResponse(503, {})),
      }),
      logTail,
    });
    try {
      logTail.emit(LAUNCH);
      const busy = await source.snapshot();
      expect(busy.slots[0]?.state).toBe("processing");

      // Its release fell out of the buffer and never arrived.
      clock = FIXED_NOW + SLOT_STALE_MS + 1;
      const lost = await source.snapshot();
      expect(lost.slots[0]?.state).toBe("unknown");
      // A lower bound is not a count: with a lane unspoken for, the number of
      // requests in flight can only be guessed at, so it dashes.
      expect(lost.requestsInFlight).toBeNull();
      // Throughput is not a claim about lanes, so it does not dash with them. It
      // is the tokens the log reported over the wall clock it reported them in,
      // and a lane nobody has heard from has reported none — which is what this
      // window honestly measured. (It does dash when the STREAM breaks, because
      // then the window itself cannot be vouched for.)
      expect(lost.throughputTps).toBe(0);
    } finally {
      source.close();
    }
  });

  it("re-establishes occupancy after the log source drops and comes back", async () => {
    const fetch = recordingFetch({ models: () => Promise.resolve(jsonResponse(200, PORTED_BODY)) });
    const logTail = liveTailer();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch,
      logTail,
    });
    try {
      await source.snapshot();
      expect(hits(fetch.urls, "/slots")).toBe(1);

      // macOS unlinks a stale /tmp log daily; the tailer reports it and heals.
      // Lines were lost across the gap and there is no way to know which, so
      // nothing is carried over it.
      logTail.setSource("missing");
      await source.snapshot();
      expect(hits(fetch.urls, "/slots")).toBe(2);

      logTail.setSource("ok");
      await source.snapshot();
      expect(hits(fetch.urls, "/slots")).toBe(3);

      // And once settled again it goes quiet: a re-sync is an event, not a mode.
      await source.snapshot();
      await source.snapshot();
      expect(hits(fetch.urls, "/slots")).toBe(3);
      expect(hits(fetch.urls, "/metrics")).toBe(0);
    } finally {
      source.close();
    }
  });

  it("keeps one model's unresolvable lane out of another model's rate", async () => {
    // The flags that decide "unmeasured" and "uncertain" are per model. Declared
    // once for the whole loop they were dashboard-global, so a single model with
    // one lane nobody could establish dashed the rate and the request count for
    // every other model on the box — including ones fully understood.
    const SECOND = {
      id: "M3",
      // No `--port`, so no event can ever be attributed to it: permanently
      // unresolvable, which is the worst case for poisoning a neighbour.
      status: { value: "loaded", args: ["--parallel", "1", "--ctx-size", "4096"] },
      architecture: { output_modalities: ["text"] },
      meta: { ftype: "Q4_0", size: 1, n_ctx: 4096 },
    };
    let clock = FIXED_NOW;
    const logTail = liveTailer();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback({ now: () => clock }),
      fetch: routerFetch({
        models: () =>
          Promise.resolve(jsonResponse(200, { object: "list", data: [PORTED_MODEL, SECOND] })),
      }),
      logTail,
    });
    try {
      // Seed M1 from its one-shot read first, then let the log move it.
      await source.snapshot();
      logTail.emit(LAUNCH);
      logTail.emit(EVAL);
      const snapshot = await source.snapshot();

      const measured = snapshot.models.find((model) => model.id === "M1");
      const opaque = snapshot.models.find((model) => model.id === "M3");
      // M1 is fully established and generating at a measured rate; M3's opacity
      // says nothing whatsoever about it.
      expect(measured?.status).toBe("active");
      expect(measured?.tokensPerSecond).toBeCloseTo(129.05, 2);
      // And M3 claims nothing it cannot support.
      expect(opaque?.status).toBe("resident");
      expect(opaque?.tokensPerSecond).toBeNull();
      // In-flight requests still dash, which is correct — an unknown lane really
      // might be holding one — and that is now the ONLY thing M3 costs.
      expect(snapshot.requestsInFlight).toBeNull();

      // Throughput is not a claim about lanes: it is the tokens the log reported
      // over the wall clock it reported them in, and M1's 90 are just as
      // measured with an opaque model sitting beside it.
      logTail.emit(RELEASE);
      clock += THROUGHPUT_SAMPLE_SECONDS * 1000;
      const windowed = await source.snapshot();
      expect(windowed.throughputHistory).toEqual([30]);
      expect(windowed.throughputTps).toBeCloseTo(30, 6);
      expect(windowed.requestsInFlight).toBeNull();
    } finally {
      source.close();
    }
  });

  it("keeps slot state across a failed /models read instead of discarding it", async () => {
    // `/models` failing yields an empty port map, which is byte-identical to
    // "nothing is loaded" — but one is news and the other is the absence of it.
    // Retaining against the failure would drop every port record, so a single
    // 4 s timeout against a busy router would wipe all slot state and force a
    // fresh `/slots` read for every model on the next tick.
    let modelsOk = true;
    const fetch = recordingFetch({
      models: () =>
        modelsOk
          ? Promise.resolve(jsonResponse(200, PORTED_BODY))
          : Promise.reject(new Error("ETIMEDOUT")),
    });
    const logTail = liveTailer();
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch,
      logTail,
    });
    try {
      await source.snapshot();
      logTail.emit(LAUNCH);
      expect((await source.snapshot()).slots[0]?.state).toBe("processing");
      expect(hits(fetch.urls, "/slots")).toBe(1);

      // The router goes unreachable for a tick and comes back.
      modelsOk = false;
      await source.snapshot();
      modelsOk = true;
      const recovered = await source.snapshot();

      // The lane is still busy, remembered rather than re-read, and no extra
      // `/slots` was spent — a flapping `/models` must not reconstruct the poll.
      expect(recovered.slots[0]?.state).toBe("processing");
      expect(hits(fetch.urls, "/slots")).toBe(1);
    } finally {
      source.close();
    }
  });

  it("draws lanes from --parallel and their context from the launch args", async () => {
    // Structure is not occupancy: how many lanes a model has and how big each
    // one's context is come from `/v1/models`, which the router answers itself
    // and writes no line for.
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({ models: () => Promise.resolve(jsonResponse(200, PORTED_BODY)) }),
      logTail: liveTailer(),
    });
    try {
      const snapshot = await source.snapshot();
      expect(snapshot.slots).toHaveLength(2);
      expect(snapshot.slots.map((slot) => slot.ctxTotal)).toEqual([4096, 4096]);
      expect(snapshot.models[0]?.parallel).toBe(2);
    } finally {
      source.close();
    }
  });

  it("reports every lane unknown when no port can be joined to the model", async () => {
    // A loaded model whose args state no port cannot have a line attributed to
    // it, so nothing about its lanes is known — and nothing is guessed.
    const NO_PORT = {
      ...PORTED_MODEL,
      status: { value: "loaded", args: ["--parallel", "2", "--ctx-size", "8192"] },
    };
    const source = new LlamaSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: routerFetch({
        models: () => Promise.resolve(jsonResponse(200, { object: "list", data: [NO_PORT] })),
      }),
      logTail: liveTailer(),
    });
    try {
      const snapshot = await source.snapshot();
      expect(snapshot.slots.map((slot) => slot.state)).toEqual(["unknown", "unknown"]);
      expect(snapshot.requestsInFlight).toBeNull();
      expect(snapshot.throughputTps).toBeNull();
    } finally {
      source.close();
    }
  });
});
