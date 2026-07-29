/**
 * These boot the real server on an ephemeral port and talk to it over HTTP.
 * Nothing is mocked: the data source is the simulated one with its tickers
 * unscheduled, so every assertion is about what the server actually returned.
 */

import { rm, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createMockSource, type MockStewardDataSource } from "../core/mock-source.js";
import type { StewardDataSource } from "../core/source.js";
import type { LogLine, Snapshot } from "../core/types.js";
import { assertTypeStripping } from "./assets.js";
import { createStewardServer, type StewardServer } from "./index.js";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const started: StewardServer[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => server.stop()));
});

/** A simulation that only moves when a test moves it. */
function idleSource(seedLines: number): MockStewardDataSource {
  return createMockSource({
    random: () => 0.5,
    now: () => 1_760_000_000_000,
    logIntervalMs: 0,
    metricsIntervalMs: 0,
    throughputIntervalMs: 0,
    seedLines,
  });
}

/** Boots a server whose simulation only moves when a test moves it. */
async function boot(
  seedLines = 12,
): Promise<{ url: string; source: MockStewardDataSource; server: StewardServer }> {
  const source = idleSource(seedLines);
  const server = createStewardServer({ port: 0, source });
  started.push(server);
  const url = await server.start();
  return { url, source, server };
}

/** A source that fails the way an unexpected filesystem error would. */
function failingSource(detail: string): StewardDataSource {
  return {
    name: "failing",
    snapshot: () => Promise.reject(new Error(detail)),
    recentLogs: () => [],
    subscribeLogs: () => () => undefined,
    setService: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
    close: () => undefined,
  };
}

/**
 * A source that records HOW the stream route opened it. The two-call pattern
 * (`recentLogs` then `subscribeLogs`) is only safe while nothing can run
 * between the calls; this pins the route to the atomic one so a later `await`
 * cannot silently start dropping lines.
 */
function attachRecordingSource(): StewardDataSource & {
  calls: string[];
  emit(message: string): void;
} {
  const listeners = new Set<(line: LogLine) => void>();
  let seq = 1;
  const line = (message: string): LogLine => ({
    seq: seq++,
    ts: 1_760_000_000_000,
    level: "INFO",
    modelId: null,
    message,
    kind: "event",
    origin: "router",
  });
  const backlog = [line("srv  buffered before the client connected")];
  const source = {
    name: "recording",
    calls: [] as string[],
    snapshot: () => Promise.reject(new Error("not used")),
    recentLogs: (): LogLine[] => {
      source.calls.push("recentLogs");
      return backlog;
    },
    subscribeLogs: (listener: (line: LogLine) => void) => {
      source.calls.push("subscribeLogs");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attachLogs: (listener: (line: LogLine) => void, limit: number) => {
      source.calls.push("attachLogs");
      listeners.add(listener);
      return {
        backlog: backlog.slice(-limit),
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
    emit: (message: string): void => {
      const next = line(message);
      for (const listener of listeners) listener(next);
    },
    setService: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
    close: () => undefined,
  };
  return source;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSnapshot(url: string): Promise<Snapshot> {
  const response = await fetch(`${url}/api/snapshot`);
  expect(response.status).toBe(200);
  return (await response.json()) as Snapshot;
}

describe("the Steward server", () => {
  it("binds loopback on a free port and reports where it landed", async () => {
    const source = createMockSource({ logIntervalMs: 0, metricsIntervalMs: 0, seedLines: 0 });
    const server = createStewardServer({ port: 0, source });
    started.push(server);

    expect(server.url).toBeNull();
    expect(server.port).toBeNull();

    const url = await server.start();
    expect(server.port).toBeGreaterThan(0);
    expect(url).toBe(`http://127.0.0.1:${server.port}`);
    // Starting twice hands back the same URL rather than binding again.
    expect(await server.start()).toBe(url);

    await server.stop();
    await server.stop();
    await expect(fetch(url)).rejects.toThrow();
  });

  it("is spent once stopped, and says so rather than binding a second socket", async () => {
    const { url, server } = await boot(0);

    await server.stop();
    expect(server.url).toBeNull();
    expect(server.port).toBeNull();

    // The source it was serving is closed; a start that quietly re-bound would
    // put a live socket in front of a dead simulation.
    await expect(server.start()).rejects.toThrow(/spent/);
    expect(server.url).toBeNull();
    await expect(fetch(url)).rejects.toThrow();
  });

  it("releases everything a failed start created, so nothing is left ticking", async () => {
    const { server: holder } = await boot(0);
    const port = holder.port;
    if (port === null) throw new Error("the holding server reported no port");

    // A running simulation, so a leaked ticker shows up as a log that is still
    // growing after the start that owned it gave up.
    const source = createMockSource({
      logIntervalMs: 1,
      metricsIntervalMs: 1,
      throughputIntervalMs: 1,
      seedLines: 1,
    });
    const blocked = createStewardServer({ port, source });

    await expect(blocked.start()).rejects.toThrow(/EADDRINUSE/);

    const settled = source.recentLogs(10_000).length;
    await delay(40);
    expect(source.recentLogs(10_000)).toHaveLength(settled);

    // The instance is spent, not merely idle: retrying on it would serve a
    // source it has already closed.
    await expect(blocked.start()).rejects.toThrow(/spent/);
    await expect(blocked.stop()).resolves.toBeUndefined();
  });

  it("stops a server whose start has not finished yet", async () => {
    const source = idleSource(0);
    const server = createStewardServer({ port: 0, source });
    started.push(server);

    // Both commands are in flight at once, which is what a session shutdown
    // arriving on the heels of a `/steward` looks like.
    const starting = server.start();
    const stopping = server.stop();

    const url = await starting;
    await stopping;

    expect(server.url).toBeNull();
    await expect(fetch(url)).rejects.toThrow();
    expect(() => source.tickLogs()).not.toThrow();
  });

  it("answers an unexpected failure generically and keeps the detail server-side", async () => {
    const detail = "EACCES: permission denied, open '/Users/someone/private/ui/main.ts'";
    const server = createStewardServer({ port: 0, source: failingSource(detail) });
    started.push(server);
    const url = await server.start();

    const logged: string[] = [];
    const original = console.error;
    console.error = (message: unknown) => {
      logged.push(String(message));
    };

    let body: string;
    let status: number;
    try {
      const response = await fetch(`${url}/api/snapshot`);
      status = response.status;
      body = await response.text();
    } finally {
      console.error = original;
    }

    expect(status).toBe(500);
    expect(body).toBe("Internal error\n");
    // The operator still gets the whole story, on the terminal they ran the
    // command from.
    expect(logged.some((entry) => entry.includes(detail))).toBe(true);
  });

  it("serves a snapshot the client can repaint from", async () => {
    const { url } = await boot();
    const response = await fetch(`${url}/api/snapshot`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");

    // The cast is the contract the route promises; the key set below is what
    // proves the server kept it.
    const snapshot = (await response.json()) as Snapshot;
    expect(Object.keys(snapshot).sort()).toEqual([
      "config",
      "drift",
      "memoryTopology",
      "metrics",
      "models",
      "now",
      "requestsInFlight",
      "requestsQueued",
      "service",
      "slots",
      "throughputHistory",
      "throughputTps",
    ]);
    expect(snapshot.service.running).toBe(true);
    expect(snapshot.models).toHaveLength(4);
    expect(snapshot.slots).toHaveLength(4);
    expect(snapshot.throughputHistory).toHaveLength(42);
  });

  it("strips the types off a browser module and serves runnable JavaScript", async () => {
    const { url } = await boot(0);
    const response = await fetch(`${url}/core/types.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.text();
    expect(body).toContain("export const THROUGHPUT_HISTORY_SIZE");
    // The annotations and the type-only declarations are gone…
    expect(body).not.toContain("export interface Snapshot");
    expect(body).not.toContain(": number");
    // …and what is left actually runs.
    const module = await import(`data:text/javascript,${encodeURIComponent(body)}`);
    expect(module.THROUGHPUT_HISTORY_SIZE).toBe(42);
  });

  it("serves the mark verbatim", async () => {
    const { url } = await boot(0);
    const response = await fetch(`${url}/favicon.svg`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(await response.text()).toContain("currentColor");
  });

  it("404s for a module that is not there, without leaking the path", async () => {
    const { url } = await boot(0);
    const response = await fetch(`${url}/core/definitely-not-a-module.js`);

    expect(response.status).toBe(404);
    // Every refusal is the same three words, whatever the reason for it.
    expect(await response.text()).toBe("Not found\n");
  });

  it("refuses to serve anything outside the directory a route points at", async () => {
    const { url } = await boot(0);

    // Percent-encoded so the client cannot normalise the traversal away.
    const escaped = await fetch(`${url}/ui/%2e%2e%2fpackage.json`);
    expect(escaped.status).toBe(404);
    expect(await escaped.text()).toBe("Not found\n");

    const crossRoute = await fetch(`${url}/ui/%2e%2e%2fcore%2ftypes.js`);
    expect(crossRoute.status).toBe(404);
    expect(await crossRoute.text()).toBe("Not found\n");

    // The file the traversal was reaching for is real and servable — through
    // its own route. The refusals above are refusals, not missing files.
    const direct = await fetch(`${url}/core/types.js`);
    expect(direct.status).toBe(200);
    expect(await direct.text()).toContain("THROUGHPUT_HISTORY_SIZE");

    const absolute = await fetch(`${url}/core/%2ftmp%2fpasswd.js`);
    expect(absolute.status).toBe(404);

    const nullByte = await fetch(`${url}/core/types%00.js`);
    expect(nullByte.status).toBe(404);
  });

  it("refuses a symlink inside the tree that points out of it", async () => {
    const { url } = await boot(0);
    // `.css` is served verbatim, so a leak would arrive intact rather than
    // failing in the type stripper for unrelated reasons.
    const link = path.join(PACKAGE_ROOT, "core", "escaped-asset.css");
    await symlink(path.join(PACKAGE_ROOT, "package.json"), link);

    try {
      const response = await fetch(`${url}/core/escaped-asset.css`);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found\n");
    } finally {
      await rm(link, { force: true });
    }
  });

  it("does not serve its own test sources", async () => {
    const { url } = await boot(0);

    expect((await fetch(`${url}/core/state.test.js`)).status).toBe(404);
    expect((await fetch(`${url}/core/format.test.js`)).status).toBe(404);
    expect((await fetch(`${url}/core/state.test.ts`)).status).toBe(404);
    expect((await fetch(`${url}/ui/main.test.js`)).status).toBe(404);

    // The module those tests sit beside is served, so the 404s above are the
    // route refusing, not the files being absent.
    expect((await fetch(`${url}/core/state.js`)).status).toBe(200);
  });

  it("refuses to serve modules on a runtime that cannot strip types", () => {
    expect(() => assertTypeStripping({})).toThrow(/Node >= 22\.13/);
    expect(() => assertTypeStripping({ stripTypeScriptTypes: "not callable" })).toThrow(
      /stripTypeScriptTypes/,
    );
    // This runtime can, which is why every other test in this file works.
    expect(() => assertTypeStripping()).not.toThrow();
  });

  it("404s for an unknown path and for the wrong method", async () => {
    const { url } = await boot(0);

    expect((await fetch(`${url}/nope`)).status).toBe(404);
    expect((await fetch(`${url}/api/snapshot`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${url}/api/service/start`)).status).toBe(404);
  });

  it("applies service actions to the next snapshot", async () => {
    const { url } = await boot(0);

    const stop = await fetch(`${url}/api/service/stop`, { method: "POST" });
    expect(stop.status).toBe(204);

    const stopped = await fetchSnapshot(url);
    expect(stopped.service.running).toBe(false);
    expect(stopped.throughputTps).toBe(0);

    expect((await fetch(`${url}/api/service/restart`, { method: "POST" })).status).toBe(204);
    const restarted = await fetchSnapshot(url);
    expect(restarted.service.running).toBe(true);

    expect((await fetch(`${url}/api/service/frobnicate`, { method: "POST" })).status).toBe(400);
  });

  it("hands back the reason a control command was refused", async () => {
    // A control command that fails is the operator's business, not a crash: the
    // reason has to reach the page, or the dashboard can only say "something
    // went wrong" about a permission problem it was told about.
    const source = idleSource(0);
    source.setService = () => Promise.reject(new Error("launchctl: permission denied"));
    const server = createStewardServer({ port: 0, source });
    started.push(server);
    const url = await server.start();

    const response = await fetch(`${url}/api/service/restart`, { method: "POST" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "launchctl: permission denied" });
  });

  it("applies model actions, and 404s for a model it does not know", async () => {
    const { url } = await boot(0);
    const id = "qwen3.6-moe-a3b-instruct-q4_k_m";

    expect((await fetch(`${url}/api/models/${id}/unload`, { method: "POST" })).status).toBe(204);
    const after = await fetchSnapshot(url);
    expect(after.models[0]?.status).toBe("unloaded");

    expect((await fetch(`${url}/api/models/${id}/load`, { method: "POST" })).status).toBe(204);
    expect((await fetch(`${url}/api/models/ghost/load`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${url}/api/models/${id}/vaporise`, { method: "POST" })).status).toBe(400);
  });

  it("replays the backlog on connect and then streams live lines", async () => {
    const { url, source } = await boot(3);
    const controller = new AbortController();
    const response = await fetch(`${url}/api/logs/stream`, { signal: controller.signal });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    if (response.body === null) throw new Error("the log stream had no body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    // SSE framing is `data: …\n\n`, and chunk boundaries are the network's
    // business — so read until a whole event is in hand.
    const nextEvent = async (): Promise<LogLine> => {
      while (!buffered.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the log stream ended early");
        buffered += decoder.decode(value, { stream: true });
      }
      const boundary = buffered.indexOf("\n\n");
      const event = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      expect(event.startsWith("data: ")).toBe(true);
      return JSON.parse(event.slice("data: ".length));
    };

    const first = await nextEvent();
    expect(first.seq).toBe(618);
    expect(first.message.length).toBeGreaterThan(0);
    expect((await nextEvent()).seq).toBe(619);
    expect((await nextEvent()).seq).toBe(620);

    source.tickLogs();
    expect((await nextEvent()).seq).toBe(621);

    // Dropping the client must release the subscription, or a reloading
    // browser would leave a listener writing to a dead socket.
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await delay(50);
    expect(() => source.tickLogs()).not.toThrow();
  });

  it("opens the log stream atomically, not as a backlog read plus a subscribe", async () => {
    const source = attachRecordingSource();
    const server = createStewardServer({ port: 0, source });
    started.push(server);
    const url = await server.start();

    const controller = new AbortController();
    const response = await fetch(`${url}/api/logs/stream`, { signal: controller.signal });
    if (response.body === null) throw new Error("the log stream had no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const nextEvent = async (): Promise<LogLine> => {
      let buffered = "";
      while (!buffered.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the log stream ended early");
        buffered += decoder.decode(value, { stream: true });
      }
      return JSON.parse(buffered.slice("data: ".length, buffered.indexOf("\n\n")));
    };

    expect((await nextEvent()).message).toBe("srv  buffered before the client connected");
    source.emit("srv  live line");
    expect((await nextEvent()).message).toBe("srv  live line");
    // The route took the backlog and the subscription in one step. Anything
    // arriving in the gap between two separate calls would be in neither.
    expect(source.calls).toEqual(["attachLogs"]);

    controller.abort();
    await reader.cancel().catch(() => undefined);
  });

  it("keeps writing safely to a client that vanished mid-stream", async () => {
    const { url, source } = await boot(3);
    const controller = new AbortController();
    const response = await fetch(`${url}/api/logs/stream`, { signal: controller.signal });
    if (response.body === null) throw new Error("the log stream had no body");

    const reader = response.body.getReader();
    await reader.read();

    // Abort, then keep the source talking. A write that lands after the socket
    // ends must be absorbed, not raised asynchronously where nothing can catch
    // it — the test fails on an unhandled error either way.
    controller.abort();
    for (let i = 0; i < 200; i += 1) source.tickLogs();
    await delay(30);
    for (let i = 0; i < 200; i += 1) source.tickLogs();
    await delay(30);

    await reader.cancel().catch(() => undefined);
  });

  it("stops while a log stream is attached instead of hanging on it", async () => {
    const { url, server } = await boot(3);
    const controller = new AbortController();
    const response = await fetch(`${url}/api/logs/stream`, { signal: controller.signal });
    if (response.body === null) throw new Error("the log stream had no body");

    const reader = response.body.getReader();
    await reader.read();

    // An SSE connection never ends on its own, so `close()` alone would wait
    // for it forever.
    await expect(server.stop()).resolves.toBeUndefined();
    await expect(fetch(`${url}/api/snapshot`)).rejects.toThrow();

    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});
