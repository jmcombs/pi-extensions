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
import { type FetchLike, LlamaSource } from "./llama-source.js";
import { createMockSource, type MockSourceOptions } from "./mock-source.js";
import type { StewardDataSource } from "./source.js";

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
      });

      // Throughput and requests are live: the idle default slots mean no model
      // is processing, so throughput reads 0, and the request gauges (absent
      // from the metrics body) read 0 — not the mock's invented figures.
      expect(snapshot.throughputTps).toBe(0);
      expect(snapshot.throughputHistory).toEqual([0]);
      expect(snapshot.requestsInFlight).toBe(0);
      expect(snapshot.requestsQueued).toBe(0);

      // Everything else must be exactly the fallback's.
      const { config: _c, models: _m, slots: _s, service: _sv, ...liveRest } = snapshot;
      const { config: _c2, models: _m2, slots: _s2, service: _sv2, ...mockRest } = reference;
      const strip = ({
        throughputTps: _t,
        throughputHistory: _h,
        requestsInFlight: _i,
        requestsQueued: _q,
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
