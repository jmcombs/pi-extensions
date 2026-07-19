/**
 * Smoke test — verifies the extension's default factory loads and registers
 * the resources it claims to register.
 *
 * This is a meaningful test, not coverage theater. It exercises:
 *   - The default export is a function (Pi requires this).
 *   - Calling the factory with a minimal real-shape `ExtensionAPI` does not
 *     throw and produces the expected command names + event registration.
 *
 * It does NOT mock external APIs or touch the network. The factory only
 * registers commands and an event handler; the proxy is contacted lazily
 * inside those handlers, which the stub records but never invokes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

// Mock the heavy collaborators so the `context` hook can be exercised with no
// network. The pure-helper and registration tests in this file don't touch
// these, so file-level mocks are safe.
vi.mock("./compress.js", () => ({
  compressMessages: vi.fn(async (messages: unknown) => ({ messages, tokensSaved: 0 })),
}));
vi.mock("./client.js", () => ({
  isHealthy: vi.fn(async () => true),
  getClient: vi.fn(async () => ({ retrieve: vi.fn() })),
  resolveConfig: vi.fn(async () => ({ baseUrl: "http://127.0.0.1:8787", apiKey: undefined })),
}));
vi.mock("./autoretrieve.js", () => ({
  augmentWithAutoRetrieve: vi.fn(async (messages: unknown) => ({
    messages,
    injectedLines: 0,
    injectedMarkers: 0,
  })),
}));
vi.mock("./status.js", async () => {
  const actual = await vi.importActual<typeof import("./status.js")>("./status.js");
  return { ...actual, getProxyStatus: vi.fn(async () => ({ reachable: false as const })) };
});

import { augmentWithAutoRetrieve } from "./autoretrieve.js";
import factory, {
  accumulateSavings,
  buildSimulationMessages,
  extractDetailedStats,
  extractSimulation,
  formatSimulationReport,
  formatStatsReport,
  retrieveExecute,
  type StatsReportState,
} from "./index.js";
import {
  applyCompressedText,
  isPiFormat,
  type PiMessage,
  piToOpenAI,
  rewriteRetrieveMarker,
} from "./pi-format.js";
import { formatStatusLine, normalizeProxyStats, type StatusDisplayState } from "./status.js";

interface RegistrationLog {
  tools: string[];
  commands: string[];
  shortcuts: string[];
  flags: string[];
  events: string[];
}

// biome-ignore lint/suspicious/noExplicitAny: handler signatures vary per event
type Handler = (...args: any[]) => unknown;

/**
 * Builds a minimal ExtensionAPI stub that records what the factory registers.
 * Only the surface used by this extension is implemented; other methods
 * throw if called so missing coverage is loud. `flags` configures `getFlag`
 * return values; `handlers` captures registered event handlers so they can be
 * invoked directly.
 */
function createApiStub(flags: Record<string, unknown> = {}): {
  api: ExtensionAPI;
  log: RegistrationLog;
  handlers: Record<string, Handler>;
} {
  const log: RegistrationLog = {
    tools: [],
    commands: [],
    shortcuts: [],
    flags: [],
    events: [],
  };
  const handlers: Record<string, Handler> = {};

  const notImplemented = (method: string) => () => {
    throw new Error(`ExtensionAPI.${method} not implemented in test stub`);
  };

  const api = {
    on: ((event: string, handler: Handler) => {
      log.events.push(event);
      handlers[event] = handler;
    }) as unknown as ExtensionAPI["on"],
    getFlag: ((name: string) => flags[name]) as unknown as ExtensionAPI["getFlag"],
    registerTool: ((tool: { name: string }) => {
      log.tools.push(tool.name);
    }) as unknown as ExtensionAPI["registerTool"],
    registerCommand: ((name: string) => {
      log.commands.push(name);
    }) as unknown as ExtensionAPI["registerCommand"],
    registerShortcut: ((shortcut: string) => {
      log.shortcuts.push(shortcut);
    }) as unknown as ExtensionAPI["registerShortcut"],
    registerFlag: ((name: string) => {
      log.flags.push(name);
    }) as unknown as ExtensionAPI["registerFlag"],
    registerMessageRenderer: notImplemented("registerMessageRenderer"),
    sendMessage: notImplemented("sendMessage"),
    sendUserMessage: notImplemented("sendUserMessage"),
    appendEntry: notImplemented("appendEntry"),
    setSessionName: notImplemented("setSessionName"),
    getSessionName: notImplemented("getSessionName"),
    setLabel: notImplemented("setLabel"),
    exec: notImplemented("exec"),
    getActiveTools: notImplemented("getActiveTools"),
    getAllTools: notImplemented("getAllTools"),
    setActiveTools: notImplemented("setActiveTools"),
    getCommands: notImplemented("getCommands"),
    setModel: notImplemented("setModel"),
  } as unknown as ExtensionAPI;

  return { api, log, handlers };
}

/** Fetch a registered handler, failing loudly (and narrowing the type) if absent. */
function requireHandler(handlers: Record<string, Handler>, event: string): Handler {
  const handler = handlers[event];
  if (!handler) throw new Error(`handler for "${event}" was not registered`);
  return handler;
}

/** Minimal ExtensionContext for invoking the `context` hook (no UI). */
function createCtxStub() {
  return {
    hasUI: false,
    model: { id: "test-model" },
    ui: {},
  } as unknown as Parameters<Handler>[1];
}

describe("@jmcombs/pi-headroom", () => {
  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers its status + setup commands and a session_start handler", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.commands).toContain("headroom-status");
    expect(log.commands).toContain("headroom_setup");
    expect(log.events).toContain("session_start");
  });

  it("registers the context hook and the disable flag (Phase 2)", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.events).toContain("context");
    expect(log.flags).toContain("headroom-no-compress");
  });

  it("registers the auto-retrieve disable flag (Phase 6)", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.flags).toContain("headroom-no-autoretrieve");
  });

  describe("context hook auto-retrieve wiring (Phase 6)", () => {
    const baseMessages = [{ role: "user", content: "hi" }];

    it("runs auto-retrieve after compression when the flag is unset", async () => {
      vi.mocked(augmentWithAutoRetrieve).mockClear();
      const { api, handlers } = createApiStub({
        "headroom-no-compress": false,
        "headroom-no-autoretrieve": false,
      });
      factory(api);
      const context = requireHandler(handlers, "context");

      const result = (await context({ messages: baseMessages }, createCtxStub())) as {
        messages: unknown;
      };

      expect(augmentWithAutoRetrieve).toHaveBeenCalledTimes(1);
      // maxMarkers is threaded through from AUTORETRIEVE_MAX_MARKERS.
      const call = vi.mocked(augmentWithAutoRetrieve).mock.calls[0];
      expect(call?.[2]).toEqual({ maxMarkers: 3 });
      expect(result.messages).toBe(baseMessages);
    });

    it("bypasses auto-retrieve when --headroom-no-autoretrieve is set", async () => {
      vi.mocked(augmentWithAutoRetrieve).mockClear();
      const { api, handlers } = createApiStub({
        "headroom-no-compress": false,
        "headroom-no-autoretrieve": true,
      });
      factory(api);
      const context = requireHandler(handlers, "context");

      const result = (await context({ messages: baseMessages }, createCtxStub())) as {
        messages: unknown;
      };

      expect(augmentWithAutoRetrieve).not.toHaveBeenCalled();
      expect(result.messages).toBe(baseMessages);
    });

    it("does not run auto-retrieve when compression is disabled (passthrough)", async () => {
      vi.mocked(augmentWithAutoRetrieve).mockClear();
      const { api, handlers } = createApiStub({
        "headroom-no-compress": true,
        "headroom-no-autoretrieve": false,
      });
      factory(api);
      const context = requireHandler(handlers, "context");

      const result = await context({ messages: baseMessages }, createCtxStub());

      // Compression off → the hook returns nothing (leaves messages untouched)
      // and never reaches auto-retrieve.
      expect(augmentWithAutoRetrieve).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });

  it("registers the headroom-stats and headroom-simulate commands (Phase 5)", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.commands).toContain("headroom-stats");
    expect(log.commands).toContain("headroom-simulate");
  });

  it("registers the headroom_retrieve tool (Phase 3, always enabled — LD2)", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.tools).toContain("headroom_retrieve");
  });

  it("wires the status display via session_start + context (Phase 4 refresh points)", () => {
    const { api, log } = createApiStub();
    factory(api);

    // The persistent display is rendered/refreshed from the session_start and
    // context handlers (the proxy snapshot is primed on session_start; the live
    // session figure is refreshed on each compression pass).
    expect(log.events).toContain("session_start");
    expect(log.events).toContain("context");
  });
});

describe("accumulateSavings", () => {
  it("adds positive deltas to the running total", () => {
    expect(accumulateSavings(0, 100)).toBe(100);
    expect(accumulateSavings(100, 250)).toBe(350);
  });

  it("ignores zero, negative, and non-finite deltas (passthrough/fallback)", () => {
    expect(accumulateSavings(500, 0)).toBe(500);
    expect(accumulateSavings(500, -42)).toBe(500);
    expect(accumulateSavings(500, Number.NaN)).toBe(500);
    expect(accumulateSavings(500, Number.POSITIVE_INFINITY)).toBe(500);
  });
});

// A realistic 4-message Pi conversation: user → assistant+toolCall → toolResult → user.
function samplePiConversation(): PiMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "run the tests" }], timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Running the suite." },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "npm test" } },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3-5-haiku",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: "a very long and verbose test log ".repeat(20) }],
      isError: false,
      timestamp: 3,
    },
    { role: "user", content: [{ type: "text", text: "thanks" }], timestamp: 4 },
  ] as unknown as PiMessage[];
}

describe("isPiFormat", () => {
  it("detects Pi shape via role:toolResult", () => {
    expect(isPiFormat(samplePiConversation())).toBe(true);
  });

  it("detects Pi shape via toolCall/thinking content parts", () => {
    const onlyAssistant: PiMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "x", name: "bash", arguments: {} }],
      },
    ] as unknown as PiMessage[];
    expect(isPiFormat(onlyAssistant)).toBe(true);
  });

  it("returns false for plain OpenAI-shaped messages", () => {
    const openAI = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ] as unknown as PiMessage[];
    expect(isPiFormat(openAI)).toBe(false);
  });
});

describe("rewriteRetrieveMarker", () => {
  it("rewrites the CCR marker into a directive that names the tool and keeps the hash", () => {
    const before = "[220 lines compressed to 0. Retrieve more: hash=1b55ac35e8690d5a78a3afa1]";
    const after = rewriteRetrieveMarker(before);
    expect(after).toContain("headroom_retrieve tool");
    expect(after).toContain("hash=1b55ac35e8690d5a78a3afa1");
    expect(after).toContain("a query");
    expect(after).not.toContain("Retrieve more");
  });

  it("leaves text without a marker unchanged (idempotent)", () => {
    expect(rewriteRetrieveMarker("just a normal log line")).toBe("just a normal log line");
  });
});

describe("applyCompressedText", () => {
  it("is count-preserving and swaps text in place while keeping Pi metadata + linkage", () => {
    const original = samplePiConversation();
    const openAI = piToOpenAI(original);
    expect(openAI).toHaveLength(original.length);

    // Simulate the proxy compressing the bulky toolResult (index 2) text.
    const compressed = openAI.map((m, i) => (i === 2 ? { ...m, content: "[compressed log]" } : m));

    const result = applyCompressedText(original, compressed);
    expect(result).not.toBeNull();
    const messages = result as PiMessage[];

    // Same length, roles preserved.
    expect(messages).toHaveLength(original.length);
    expect(messages.map((m) => (m as { role: string }).role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);

    // toolResult text swapped, strictly shorter, metadata + linkage intact.
    const toolResult = messages[2] as {
      toolCallId: string;
      toolName: string;
      isError: boolean;
      content: { type: string; text: string }[];
    };
    expect(toolResult.toolCallId).toBe("call_1");
    expect(toolResult.toolName).toBe("bash");
    expect(toolResult.isError).toBe(false);
    expect(toolResult.content[0]?.text).toBe("[compressed log]");
    const originalToolResult = original[2] as { content: { text: string }[] };
    expect(toolResult.content[0]?.text.length).toBeLessThan(
      originalToolResult.content[0]?.text.length ?? 0,
    );

    // assistant → toolCall id linkage preserved.
    const assistant = messages[1] as { content: { type: string; id?: string }[] };
    const toolCallPart = assistant.content.find((p) => p.type === "toolCall");
    expect(toolCallPart?.id).toBe("call_1");

    // Original messages untouched (copies, not mutation).
    expect(originalToolResult.content[0]?.text).not.toBe("[compressed log]");
  });

  it("returns null on a count-mismatched pair (caller passes through)", () => {
    const original = samplePiConversation();
    const tooFew = piToOpenAI(original).slice(0, 2);
    expect(applyCompressedText(original, tooFew)).toBeNull();
  });

  it("returns null on a per-index role mismatch", () => {
    const original = samplePiConversation();
    const openAI = piToOpenAI(original);
    // Corrupt the role at index 2 (expected "tool").
    const mismatched = openAI.map((m, i) =>
      i === 2 ? ({ role: "user", content: "x" } as (typeof openAI)[number]) : m,
    );
    expect(applyCompressedText(original, mismatched)).toBeNull();
  });
});

// ── headroom_retrieve: empty-query fallback to full retrieval (no network) ──

/**
 * A no-network stub of the proxy client's `retrieve`. `retrieve(hash, {query})`
 * resolves a RetrieveSearchResult; `retrieve(hash)` (no query) resolves the full
 * RetrieveResult. The query result is configurable so we can exercise both the
 * empty-match (fallback) and non-empty-match paths.
 */
/**
 * Stub whose no-query `retrieve(hash)` resolves `full` (the content-addressed
 * original). `retrieveExecute` now always calls retrieve without a query and
 * filters client-side, so we record the calls to assert that.
 */
function createRetrieveStub(opts: { full?: Record<string, unknown> | null }) {
  const calls: { hash: string; query?: string }[] = [];
  const client = {
    retrieve: async (hash: string, options?: { query?: string }) => {
      calls.push({ hash, query: options?.query });
      if (opts.full === null) return { hash, query: "", results: [], count: 0 };
      return opts.full;
    },
  } as unknown as NonNullable<Parameters<typeof retrieveExecute>[1]>["client"];
  return { client, calls };
}

const ORIGINAL_LOG = [
  "txn 145 ref=aa1 settled $10.00 latency=5ms",
  "txn 146 ref=bb2 settled $20.00 latency=6ms",
  "txn 147 ref=abc settled $30.00 latency=7ms",
  "txn 148 ref=dd4 settled $40.00 latency=8ms",
].join("\n");

const FULL_RESULT = {
  hash: "h123",
  originalContent: ORIGINAL_LOG,
  originalTokens: 1200,
  originalItemCount: 4,
  compressedItemCount: 1,
  toolName: "read_file",
  retrievalCount: 1,
};

describe("retrieveExecute (headroom_retrieve)", () => {
  it("client-side filters the original to the matching line for a query (no proxy search)", async () => {
    const { client, calls } = createRetrieveStub({ full: FULL_RESULT });

    const result = await retrieveExecute({ hash: "h123", query: "txn 147" }, { client });
    const text = result.content.map((c) => c.text).join("\n");

    // The model gets a short, focused result — the matching line — not a dump.
    expect(text).toContain("txn 147 ref=abc settled $30.00");
    expect(text).not.toContain("txn 145");
    expect(text).not.toContain("txn 148");
    expect(result.details.filteredClientSide).toBe(true);
    expect(result.details.matchCount).toBe(1);
    expect(result.details.query).toBe("txn 147");
    // Always a single no-query retrieve; filtering is client-side (no proxy search).
    expect(calls).toEqual([{ hash: "h123", query: undefined }]);
  });

  it("returns the full original (with a note) when a query matches no line", async () => {
    const { client } = createRetrieveStub({ full: FULL_RESULT });

    const result = await retrieveExecute({ hash: "h123", query: "zzznomatch" }, { client });
    const text = result.content.map((c) => c.text).join("\n");

    // Detail is never lost: full original returned, flagged as a fallback.
    expect(text).toContain("txn 147 ref=abc settled $30.00");
    expect(text).toContain("matched no lines");
    expect(result.details.fellBackToFull).toBe(true);
    expect(result.details.matchCount).toBe(0);
    expect(result.details.error).toBeUndefined();
  });

  it("returns the full original on a no-query retrieval", async () => {
    const { client, calls } = createRetrieveStub({ full: FULL_RESULT });

    const result = await retrieveExecute({ hash: "h123" }, { client });
    const text = result.content.map((c) => c.text).join("\n");

    expect(text).toBe(ORIGINAL_LOG);
    expect(result.details.filteredClientSide).toBeUndefined();
    expect(result.details.fellBackToFull).toBeUndefined();
    expect(result.details.originalTokens).toBe(1200);
    expect(calls).toEqual([{ hash: "h123", query: undefined }]);
  });

  it("returns a clear non-throwing message when no original content is available (LD3)", async () => {
    const { client } = createRetrieveStub({ full: null });

    const result = await retrieveExecute({ hash: "h123", query: "nope" }, { client });
    const text = result.content.map((c) => c.text).join("\n");

    expect(text).toContain("could not retrieve the original");
    expect(result.details.error).toBeUndefined();
  });

  it("returns a non-throwing error result when the client throws (LD3)", async () => {
    const client = {
      retrieve: async () => {
        throw new Error("connection refused");
      },
    } as unknown as NonNullable<Parameters<typeof retrieveExecute>[1]>["client"];

    const result = await retrieveExecute({ hash: "h123", query: "x" }, { client });
    const text = result.content.map((c) => c.text).join("\n");

    expect(text).toContain("Headroom retrieve failed");
    expect(result.details.error).toBe(true);
  });
});

// ── Phase 4: read-only status snapshot + display formatting (LD9) ───────

describe("normalizeProxyStats", () => {
  it("maps the live proxyStats() shape onto settings + lifetime savings (no network)", () => {
    // Stub mirrors the real (camelCased) proxyStats() runtime object verified
    // against the live proxy: mode under `summary`, tuning under `config`,
    // lifetime savings under `tokens`.
    const stub = {
      summary: { mode: "token" },
      config: {
        targetRatio: 0.5,
        protectRecent: 3,
        compressUserMessages: true,
        minTokensToCrush: 500,
      },
      tokens: { saved: 8800, savingsPercent: 42 },
    };

    expect(normalizeProxyStats(stub)).toEqual({
      mode: "token",
      targetRatio: 0.5,
      protectRecent: 3,
      compressUserMessages: true,
      proxyTokensSaved: 8800,
      proxyCompressionRatio: 42,
    });
  });

  it("tolerates a default proxy where tuning fields are null", () => {
    const stub = {
      summary: { mode: "token" },
      config: {
        targetRatio: null,
        protectRecent: null,
        compressUserMessages: false,
        minTokensToCrush: 500,
      },
      tokens: { saved: 0, savingsPercent: 0 },
    };

    expect(normalizeProxyStats(stub)).toEqual({
      mode: "token",
      targetRatio: undefined,
      protectRecent: undefined,
      compressUserMessages: false,
      proxyTokensSaved: 0,
      proxyCompressionRatio: 0,
    });
  });

  it("returns all-undefined fields for an empty/garbage object (never throws)", () => {
    expect(normalizeProxyStats(undefined)).toEqual({
      mode: undefined,
      targetRatio: undefined,
      protectRecent: undefined,
      compressUserMessages: undefined,
      proxyTokensSaved: undefined,
      proxyCompressionRatio: undefined,
    });
    expect(() => normalizeProxyStats({ unrelated: 1 })).not.toThrow();
  });
});

describe("formatStatusLine", () => {
  const reachable: StatusDisplayState = {
    enabled: true,
    reachable: true,
    version: "0.27.0",
    mode: "token",
    compressUserMessages: false,
    proxyTokensSaved: 1_200_000,
    proxyCompressionRatio: 42,
  };

  it("renders enabled + proxy version + mode + session and proxy lifetime savings", () => {
    const line = formatStatusLine(reachable, 8800);
    expect(line).toBe(
      "Headroom: on · proxy 0.27.0 · mode token · saved 8.8k this session · 1.2M lifetime",
    );
  });

  it("shows key tuning settings only when the proxy has them set", () => {
    const tuned: StatusDisplayState = {
      ...reachable,
      targetRatio: 0.5,
      protectRecent: 3,
      compressUserMessages: true,
    };
    const line = formatStatusLine(tuned, 0);
    expect(line).toContain("ratio 0.5");
    expect(line).toContain("protect 3");
    expect(line).toContain("user-msgs");
    // A default proxy (no tuning) keeps the line clean.
    expect(formatStatusLine(reachable, 0)).not.toContain("ratio");
  });

  it("reflects the disabled (off) state", () => {
    const line = formatStatusLine({ ...reachable, enabled: false }, 0);
    expect(line.startsWith("Headroom: off ·")).toBe(true);
  });

  it("renders an unreachable proxy without version/mode/lifetime, keeping the session figure", () => {
    const down: StatusDisplayState = { enabled: true, reachable: false };
    const line = formatStatusLine(down, 8800);
    expect(line).toBe("Headroom: on · proxy unreachable · saved 8.8k this session");
    expect(line).not.toContain("lifetime");
    expect(line).not.toContain("mode");
  });

  it("humanizes token counts (k/M) and treats non-finite session savings as 0", () => {
    expect(formatStatusLine(reachable, Number.NaN)).toContain("saved 0 this session");
    expect(formatStatusLine({ ...reachable, proxyTokensSaved: 950 }, 950)).toContain(
      "saved 950 this session",
    );
  });
});

// ── Phase 5: detailed stats + dry-run simulate (no network) ─────────────

describe("extractDetailedStats", () => {
  it("maps the live proxyStats() runtime onto DetailedStats (no network)", () => {
    // Stub mirrors the real (camelCased) proxyStats() runtime verified against
    // the live proxy v0.27.0: mode/requests under `summary`, lifetime savings
    // under `tokens`, tuning under `config`, per-strategy maps at top level.
    const stub = {
      summary: {
        mode: "token",
        apiRequests: 12,
        compression: { requestsCompressed: 6, avgCompressionPct: 41 },
      },
      tokens: { saved: 31200, savingsPercent: 29 },
      config: {
        targetRatio: null,
        protectRecent: null,
        compressUserMessages: false,
        minTokensToCrush: 500,
        maxItemsAfterCrush: 50,
      },
      tokensSavedByStrategy: { smartCrusher: 19297, search: 7532, kompress: 2978 },
      compressionsByStrategy: { smartCrusher: 7, search: 4, kompress: 4 },
    };

    expect(extractDetailedStats(stub)).toEqual({
      mode: "token",
      lifetimeTokensSaved: 31200,
      savingsPercent: 29,
      apiRequests: 12,
      requestsCompressed: 6,
      avgCompressionPct: 41,
      targetRatio: undefined,
      protectRecent: undefined,
      compressUserMessages: false,
      minTokensToCrush: 500,
      maxItemsAfterCrush: 50,
      tokensSavedByStrategy: { smartCrusher: 19297, search: 7532, kompress: 2978 },
      compressionsByStrategy: { smartCrusher: 7, search: 4, kompress: 4 },
    });
  });

  it("returns all-undefined fields for an empty/garbage object (never throws)", () => {
    expect(() => extractDetailedStats(undefined)).not.toThrow();
    const empty = extractDetailedStats({});
    expect(empty.mode).toBeUndefined();
    expect(empty.lifetimeTokensSaved).toBeUndefined();
    expect(empty.tokensSavedByStrategy).toBeUndefined();
  });
});

describe("formatStatsReport", () => {
  const reachable: StatsReportState = {
    reachable: true,
    version: "0.27.0",
    baseUrl: "http://127.0.0.1:8787",
    detail: {
      mode: "token",
      lifetimeTokensSaved: 31200,
      savingsPercent: 29,
      apiRequests: 12,
      requestsCompressed: 6,
      avgCompressionPct: 41,
      minTokensToCrush: 500,
      maxItemsAfterCrush: 50,
      tokensSavedByStrategy: { smartCrusher: 19297, search: 7532 },
      compressionsByStrategy: { smartCrusher: 7, search: 4 },
    },
  };

  it("renders a multi-line detailed report with session + lifetime + strategy breakdown", () => {
    const report = formatStatsReport(reachable, 8800);
    expect(report).toContain("Headroom stats — proxy 0.27.0 · mode token");
    expect(report).toContain("Session: saved 8.8k tokens this session");
    expect(report).toContain("Lifetime: saved 31.2k tokens (29% compression)");
    expect(report).toContain("Requests: 12 requests · 6 compressed · avg 41%");
    expect(report).toContain("min-crush 500");
    // Richest strategy first.
    expect(report).toContain("By strategy: smartCrusher 19.3k (7) · search 7.5k (4)");
  });

  it("shows a single unreachable report that keeps the session figure (LD3)", () => {
    const down: StatsReportState = {
      reachable: false,
      baseUrl: "http://127.0.0.1:8787",
    };
    const report = formatStatsReport(down, 8800);
    expect(report).toContain("proxy unreachable at http://127.0.0.1:8787");
    expect(report).toContain("Session: saved 8.8k tokens this session");
    expect(report).not.toContain("Lifetime");
  });

  it("treats non-finite session savings as 0", () => {
    expect(formatStatsReport(reachable, Number.NaN)).toContain("saved 0 tokens this session");
  });
});

describe("buildSimulationMessages", () => {
  it("wraps the blob as a stale read_file tool result with a trailing user turn (recency-aware)", () => {
    const messages = buildSimulationMessages("a heavy log blob");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    const tool = messages[2] as { role: string; content: unknown; tool_call_id?: string };
    expect(tool.content).toBe("a heavy log blob");
    expect(tool.tool_call_id).toBe("headroom_sim");
    const assistant = messages[1] as { tool_calls?: { function?: { name?: string } }[] };
    expect(assistant.tool_calls?.[0]?.function?.name).toBe("read_file");
  });
});

describe("extractSimulation", () => {
  it("maps the live simulate() runtime onto SimulationSummary (no network)", () => {
    // Stub mirrors the real dry-run runtime verified against the live proxy
    // v0.27.0 — the published SimulationResult type is stale.
    const stub = {
      messages: [],
      tokensBefore: 27322,
      tokensAfter: 7958,
      tokensSaved: 19364,
      compressionRatio: 0.28,
      transformsApplied: ["router:smartCrusher:0.28", "router:protected:userMessage"],
      transformsSummary: { "router:smartCrusher:0.28": 1, "router:protected:userMessage": 2 },
      ccrHashes: [],
    };
    expect(extractSimulation(stub)).toEqual({
      tokensBefore: 27322,
      tokensAfter: 7958,
      tokensSaved: 19364,
      compressionRatio: 0.28,
      transformsSummary: { "router:smartCrusher:0.28": 1, "router:protected:userMessage": 2 },
    });
  });

  it("never throws on an empty/garbage object", () => {
    expect(() => extractSimulation(undefined)).not.toThrow();
    expect(extractSimulation({}).tokensSaved).toBeUndefined();
  });
});

describe("formatSimulationReport", () => {
  it("renders projected savings + transforms with a percent", () => {
    const report = formatSimulationReport(
      {
        tokensBefore: 27322,
        tokensAfter: 7958,
        tokensSaved: 19364,
        compressionRatio: 0.28,
        transformsSummary: { "router:smartCrusher:0.28": 1, "router:protected:userMessage": 2 },
      },
      18360,
    );
    expect(report).toContain("dry-run, no LLM call");
    expect(report).toContain("18,360 chars in");
    expect(report).toContain("Projected: 27.3k → 8k tokens · saved 19.4k (71%)");
    // `router:` prefix stripped; richest transform first.
    expect(report).toContain("Transforms: protected:userMessage ×2 · smartCrusher:0.28 ×1");
  });

  it("is honest about a non-compressible blob (saved 0)", () => {
    const report = formatSimulationReport(
      { tokensBefore: 100, tokensAfter: 100, tokensSaved: 0 },
      400,
    );
    expect(report).toContain("saved 0 (0%) — this content would not compress");
  });
});
