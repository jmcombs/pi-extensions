/**
 * The live source's contract is: overlay CONFIG, delegate the rest, and never
 * throw or hang. These tests inject a fetch (they do not stand up a server) to
 * exercise our own error handling — the "not reachable", 401, and HTTP-error
 * overlays — and pair it with a real mock fallback to prove every other panel
 * still comes through untouched. The 200 path is fed the captured real router
 * `/props`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type FetchLike, LlamaConfigSource } from "./llama-source.js";
import { createMockSource, type MockSourceOptions } from "./mock-source.js";
import type { StewardDataSource } from "./source.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/llama/${name}`, import.meta.url), "utf8"));
}

const ROUTER_PROPS = fixture("props-router.json");
const AUTH_ERROR = fixture("props-401.json");

const CONNECTION = { baseUrl: "http://127.0.0.1:8080", apiKey: "" };
const LISTEN_ROW = { key: "listen", value: "127.0.0.1:8080" };

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

/** A fetch that resolves with a fixed status and JSON body. */
function respond(status: number, body: unknown): FetchLike {
  const ok = status >= 200 && status < 300;
  return () => Promise.resolve({ status, ok, json: () => Promise.resolve(body) });
}

/** A fetch that rejects, as the platform does on a refused connection. */
const refused: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"));

describe("LlamaConfigSource", () => {
  it("names itself llama.cpp", () => {
    const source = new LlamaConfigSource({ connection: CONNECTION, fallback: createFallback() });
    try {
      expect(source.name).toBe("llama.cpp");
    } finally {
      source.close();
    }
  });

  it("overlays the five live rows and leaves every other panel to the fallback", async () => {
    const fallback = createFallback();
    const source = new LlamaConfigSource({
      connection: CONNECTION,
      fallback,
      fetch: respond(200, ROUTER_PROPS),
    });
    try {
      const reference = await fallback.snapshot();
      const snapshot = await source.snapshot();

      expect(snapshot.config).toEqual([
        { key: "role", value: "router" },
        { key: "binary", value: "llama-server b9960-a935fbffe" },
        LISTEN_ROW,
        { key: "max models", value: "4" },
        { key: "autoload", value: "off" },
      ]);

      // Everything but config must be exactly what the fallback produced.
      const { config: _live, ...liveRest } = snapshot;
      const { config: _mock, ...mockRest } = reference;
      expect(liveRest).toEqual(mockRest);
    } finally {
      source.close();
    }
  });

  it("shows the not-reachable overlay when the server is down, without throwing", async () => {
    const fallback = createFallback();
    const source = new LlamaConfigSource({ connection: CONNECTION, fallback, fetch: refused });
    try {
      const snapshot = await source.snapshot();
      expect(snapshot.config).toEqual([
        { key: "status", value: "llama.cpp not reachable" },
        LISTEN_ROW,
      ]);
      // The rest of the dashboard keeps coming through.
      expect(snapshot.models).toHaveLength(4);
      expect(snapshot.slots).toHaveLength(4);
    } finally {
      source.close();
    }
  });

  it("shows the login overlay on a 401", async () => {
    const source = new LlamaConfigSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: respond(401, AUTH_ERROR),
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

  it("shows an HTTP-error overlay on any other non-2xx", async () => {
    const source = new LlamaConfigSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: respond(503, { error: "unavailable" }),
    });
    try {
      expect((await source.snapshot()).config).toEqual([
        { key: "status", value: "llama.cpp error (HTTP 503)" },
        LISTEN_ROW,
      ]);
    } finally {
      source.close();
    }
  });

  it("sends the bearer header only when a key is set", async () => {
    let headers: Record<string, string> | undefined;
    const capture: FetchLike = (_input, init) => {
      headers = init?.headers;
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(ROUTER_PROPS) });
    };

    const keyed = new LlamaConfigSource({
      connection: { baseUrl: "http://127.0.0.1:8080", apiKey: "sk-abc" },
      fallback: createFallback(),
      fetch: capture,
    });
    try {
      await keyed.snapshot();
      expect(headers?.Authorization).toBe("Bearer sk-abc");
    } finally {
      keyed.close();
    }

    const keyless = new LlamaConfigSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: capture,
    });
    try {
      await keyless.snapshot();
      expect(headers?.Authorization).toBeUndefined();
    } finally {
      keyless.close();
    }
  });

  it("renders single-model rows when the server is not a router", async () => {
    const single = { model_path: "/models/x.gguf", build_info: "b9960-a935fbffe" };
    const source = new LlamaConfigSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: respond(200, single),
    });
    try {
      expect((await source.snapshot()).config).toEqual([
        { key: "role", value: "single-model" },
        { key: "binary", value: "llama-server b9960-a935fbffe" },
        LISTEN_ROW,
      ]);
    } finally {
      source.close();
    }
  });

  it("degrades a partial /props to em dashes, never undefined", async () => {
    const source = new LlamaConfigSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: respond(200, { role: "router" }),
    });
    try {
      const { config } = await source.snapshot();
      expect(config).toEqual([
        { key: "role", value: "router" },
        { key: "binary", value: "—" },
        LISTEN_ROW,
        { key: "max models", value: "—" },
        { key: "autoload", value: "—" },
      ]);
    } finally {
      source.close();
    }
  });

  it("degrades when the server drops between two polls, with no leftover state", async () => {
    let call = 0;
    const flaky: FetchLike = () => {
      call += 1;
      return call === 1
        ? Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(ROUTER_PROPS) })
        : Promise.reject(new Error("connection reset"));
    };
    const source = new LlamaConfigSource({
      connection: CONNECTION,
      fallback: createFallback(),
      fetch: flaky,
    });
    try {
      expect((await source.snapshot()).config[0]).toEqual({ key: "role", value: "router" });
      expect((await source.snapshot()).config).toEqual([
        { key: "status", value: "llama.cpp not reachable" },
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

    const source = new LlamaConfigSource({ connection: CONNECTION, fallback, fetch: hanging });
    const pending = source.snapshot();
    // Let snapshot() get past the fallback read and issue the fetch.
    await Promise.resolve();
    await Promise.resolve();

    source.close();
    const snapshot = await pending;

    expect(signal?.aborted).toBe(true);
    expect(fallbackClosed).toBe(true);
    expect(snapshot.config).toEqual([
      { key: "status", value: "llama.cpp not reachable" },
      LISTEN_ROW,
    ]);
  });
});
