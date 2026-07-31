/**
 * These boot the real server on an ephemeral port and talk to it over HTTP.
 * Nothing is mocked: the data source is the simulated one with its tickers
 * unscheduled, so every assertion is about what the server actually returned.
 */

import { readFileSync } from "node:fs";
import { readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createStubSource, type StubSource } from "../core/__fixtures__/stub-source.js";
import type { StewardDataSource } from "../core/source.js";
import type { LogLine, LogStreamStatus, Snapshot } from "../core/types.js";
import { assertTypeStripping } from "./assets.js";
import { createStewardServer, type StewardServer } from "./index.js";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const started: StewardServer[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => server.stop()));
});

/** A simulation that only moves when a test moves it. */
function idleSource(seedLines: number): StubSource {
  return createStubSource({
    now: () => 1_760_000_000_000,
    seedLines,
  });
}

/** Boots a server whose simulation only moves when a test moves it. */
async function boot(
  seedLines = 12,
): Promise<{ url: string; source: StubSource; server: StewardServer }> {
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
  logStatus?: () => LogStreamStatus;
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
    const source = createStubSource({ seedLines: 0 });
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
    const source = createStubSource({
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
      "throughputWindowSeconds",
    ]);
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

    expect((await fetch(`${url}/api/service/restart`, { method: "POST" })).status).toBe(204);

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
    const firstSeq = first.seq;
    expect(first.message.length).toBeGreaterThan(0);
    expect((await nextEvent()).seq).toBe(firstSeq + 1);
    expect((await nextEvent()).seq).toBe(firstSeq + 2);

    source.tickLogs();
    expect((await nextEvent()).seq).toBe(firstSeq + 3);

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

  it("sends the source's health on its own event, before the first line", async () => {
    const source = attachRecordingSource();
    // A source that is streaming perfectly and has no file to read: the console
    // has to be able to tell that apart from a quiet router, and no LINE can
    // carry it — the absence of lines is the whole point.
    source.logStatus = () => ({
      source: "unavailable",
      path: null,
      detail: "no llama-server log file was discovered",
    });
    const server = createStewardServer({ port: 0, source });
    started.push(server);
    const url = await server.start();

    const controller = new AbortController();
    const response = await fetch(`${url}/api/logs/stream`, { signal: controller.signal });
    if (response.body === null) throw new Error("the log stream had no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffered = "";
    while (buffered.split("\n\n").length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
    }
    const frames = buffered.split("\n\n");
    expect(frames[0]).toBe(
      'event: source\ndata: {"source":"unavailable","path":null,"detail":"no llama-server log file was discovered"}',
    );
    // The lines keep flowing behind an unavailable source, which is exactly the
    // combination the console must render honestly.
    expect(frames[1]).toContain("buffered before the client connected");

    controller.abort();
    await reader.cancel().catch(() => undefined);
  });

  it("omits the source frame entirely for a source that cannot report on itself", async () => {
    const source = attachRecordingSource();
    const server = createStewardServer({ port: 0, source });
    started.push(server);
    const url = await server.start();

    const controller = new AbortController();
    const response = await fetch(`${url}/api/logs/stream`, { signal: controller.signal });
    if (response.body === null) throw new Error("the log stream had no body");
    const reader = response.body.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).not.toContain("event: source");

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

describe("the shipped stylesheet", () => {
  it("never carries a warn tone as text colour", async () => {
    // `--warning` is Catppuccin amber, which inverts per theme: ~15:1 on Mocha
    // and ~1.9:1 on Latte's console ground. A warn NOTICE is exactly the
    // surface whose job is telling the operator the console is not showing the
    // truth, so its words stay at full contrast and the tone rides the glyph,
    // the tinted ground and the amber rule instead.
    const css = await readFile(path.join(PACKAGE_ROOT, "ui", "steward.css"), "utf8");
    const warnRules = [...css.matchAll(/\[data-tone="warn"\][^{]*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(warnRules.length).toBeGreaterThan(0);
    for (const body of warnRules) {
      const color = /(?:^|[;\s])color:\s*([^;]+)/.exec(body ?? "");
      if (color !== null) expect(color[1]?.trim()).not.toBe("var(--warning)");
    }
  });

  it("defines the on-amber foreground as a fixed near-black in both themes", () => {
    // The WARN badge's text. `--latte-crust` would have inverted with the theme
    // and failed in Latte; this token is deliberately theme-independent.
    const css = readFileSync(path.join(PACKAGE_ROOT, "ui", "steward.css"), "utf8");
    const declared = [...css.matchAll(/--on-warning:\s*([^;]+);/g)].map((m) => m[1]?.trim());
    expect(declared).toHaveLength(2);
    expect(new Set(declared)).toEqual(new Set(["#11111b"]));
  });
});

/** WCAG relative luminance of an `#rrggbb` colour. */
function luminance(hex: string): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** The stylesheet with its comments stripped, so a rule regex cannot match one. */
function stylesheet(): string {
  return readFileSync(path.join(PACKAGE_ROOT, "ui", "steward.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
}

/**
 * The body of the rule whose selector is exactly `selector`.
 *
 * Anchored on the start of a selector list so that asking for
 * `.service__status-dot` cannot return the `[data-state="down"] …` rule that
 * merely ends with it — which is precisely the confusion these guards exist to
 * rule out.
 */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match?.[1] === undefined) throw new Error(`no rule for ${selector}`);
  return match[1];
}

describe("the console's own text contrast", () => {
  it("clears AA for every token the console paints text with, in BOTH themes", () => {
    // Latte is the trap: the same alias resolves to a light value there and a
    // pastel in Mocha, so a token that reads beautifully in the dark theme can
    // sit at 3.7:1 in the light one. Every console string is 11.5–12px, which
    // is small text — 4.5:1, no large-text exemption.
    const themes = [
      {
        name: "latte",
        primary: "#4c4f69",
        secondary: "#5c5f77",
        chrome: "#dce0e8",
        page: "#eff1f5",
      },
      {
        name: "mocha",
        primary: "#cdd6f4",
        secondary: "#bac2de",
        chrome: "#11111b",
        page: "#1e1e2e",
      },
    ];
    for (const theme of themes) {
      for (const fg of [theme.primary, theme.secondary]) {
        for (const bg of [theme.chrome, theme.page]) {
          expect(contrast(fg, bg), `${theme.name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("clears AA for the WARN badge's fixed on-amber foreground in both themes", () => {
    expect(contrast("#11111b", "#df8e1d")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#11111b", "#f9e2af")).toBeGreaterThanOrEqual(4.5);
  });

  it("never paints console text with the tertiary token, which fails in Latte", () => {
    const css = readFileSync(path.join(PACKAGE_ROOT, "ui", "steward.css"), "utf8");
    // `log-badge` is in the alternation because the trailing annotations are
    // console text too, and a guard that does not scan a surface is not
    // guarding it — the gap, not the colour, is what this line fixes.
    const consoleRules = [
      ...css.matchAll(/(\.(?:console|log-row|log-badge|chip)[^{]*)\{([^}]*)\}/g),
    ];
    const offenders = consoleRules
      .filter(([, , body]) => /(?:^|[;\s])color:\s*var\(--text-tertiary\)/.test(body ?? ""))
      .map(([, selector]) => selector?.trim());
    expect(offenders).toEqual([]);
  });

  it("paints every column header cell with a token that clears AA in Latte", () => {
    // The header reuses the ROW's cell classes so its grid can never drift from
    // the columns it labels — and therefore inherits their per-cell colours.
    // `--text-subtle` (time) is 1.97:1 and `--text-muted` (model) 2.42:1 on the
    // chrome ground in Latte, at 10.5px. Every cell has to be pinned back.
    const css = readFileSync(path.join(PACKAGE_ROOT, "ui", "steward.css"), "utf8");
    // The one block that pins them, and every cell the header renders.
    const pinned = [...css.matchAll(/((?:\.console__head\s+\.log-row__[a-z]+,?\s*)+)\{([^}]*)\}/g)]
      .filter(([, , body]) => /(?:^|[;\s])color:\s*var\(--text-secondary\)/.test(body ?? ""))
      .map(([, selector]) => selector ?? "")
      .join(" ");
    for (const cell of ["ts", "level", "model", "task", "msg"]) {
      expect(pinned, `header cell ${cell} is not pinned to a legible token`).toContain(
        `.console__head .log-row__${cell}`,
      );
    }
  });

  it("gives the column headers no sort affordance of any kind", () => {
    // A header on a grid of aligned cells reads as a table, and a table's
    // affordance is `sortable` — the one thing this data must never do. File
    // order is the only valid order: task ids are allocated at enqueue and
    // logged at dequeue, so a deferred task logs LATER with a LOWER id.
    //
    // The header carries `.log-row__task` for the grid's sake, so any pointer
    // cursor or hover state on that class leaks onto a column label.
    const css = readFileSync(path.join(PACKAGE_ROOT, "ui", "steward.css"), "utf8");
    for (const [selector, body] of css.matchAll(/(?<!button)(\.log-row__task[^{]*)\{([^}]*)\}/g)) {
      expect(body ?? "", `${selector?.trim()} must not offer a pointer`).not.toMatch(
        /cursor:\s*pointer/,
      );
      expect(selector ?? "", `${selector?.trim()} must not style a bare hover`).not.toMatch(
        /:hover/,
      );
    }
    // The affordances live on the BUTTON, which is the only thing that acts.
    expect(/button\.log-row__task[^{]*\{[^}]*cursor:\s*pointer/.test(css)).toBe(true);
    expect(/button\.log-row__task:hover/.test(css)).toBe(true);
  });
});

describe("the service status chip", () => {
  it("gives its three states three FORMS, not three hues", () => {
    // The house rule: severity in form, never hue alone. Stripping every colour
    // reference out of the three dot rules must still leave three different
    // shapes — a filled disc, an open ring and a dotted one.
    const css = stylesheet();
    const shape = (selector: string): string =>
      ruleBody(css, selector)
        .replace(/var\(--[^)]*\)/g, "COLOUR")
        .replace(/\s+/g, " ")
        .trim();

    const disc = shape(".service__status-dot");
    const ring = shape('.service__status[data-state="down"] .service__status-dot');
    const dotted = shape('.service__status[data-state="unknown"] .service__status-dot');

    expect(disc).toContain("background: COLOUR");
    expect(disc).not.toContain("border:");
    expect(ring).toContain("background: transparent");
    expect(ring).toContain("border: 2px solid");
    expect(dotted).toContain("background: transparent");
    expect(dotted).toContain("border: 2px dotted");
    expect(new Set([disc, ring, dotted]).size).toBe(3);
  });

  it("paints the state WORD with a token that clears AA on the rail, in both themes", () => {
    // The chip is 11.5px — small text, no large-text exemption — and it sits on
    // `--surface-panel`. Latte's `--success` is 2.75:1 there and `--error`
    // 4.47:1, so the state's hue rides the dot and the word takes a text token.
    const body = ruleBody(stylesheet(), ".service__status");
    const colour = /(?:^|[;\s])color:\s*([^;]+)/.exec(body)?.[1]?.trim();
    expect(colour).toBe("var(--text-secondary)");
    for (const forbidden of ["--success", "--error", "--text-muted", "--text-subtle"]) {
      expect(body, `the chip must not paint its word with ${forbidden}`).not.toMatch(
        new RegExp(`color:\\s*var\\(${forbidden}`),
      );
    }
    // `--text-secondary` on `--surface-panel`: Latte, then Mocha.
    expect(contrast("#5c5f77", "#e6e9ef")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#bac2de", "#181825")).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the 36px status row out of the stylesheet as well as the markup", () => {
    // The row and its 13px margin are the 49px this change reclaims; a rule left
    // behind is how a deleted element quietly comes back.
    expect(stylesheet()).not.toContain(".service__status-row");
  });
});
