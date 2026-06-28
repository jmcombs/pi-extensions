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
import { describe, expect, it } from "vitest";
import factory, { accumulateSavings } from "./index.js";
import { applyCompressedText, isPiFormat, type PiMessage, piToOpenAI } from "./pi-format.js";
import { formatStatusLine, normalizeProxyStats, type StatusDisplayState } from "./status.js";

interface RegistrationLog {
  tools: string[];
  commands: string[];
  shortcuts: string[];
  flags: string[];
  events: string[];
}

/**
 * Builds a minimal ExtensionAPI stub that records what the factory registers.
 * Only the surface used by this extension is implemented; other methods
 * throw if called so missing coverage is loud.
 */
function createApiStub(): { api: ExtensionAPI; log: RegistrationLog } {
  const log: RegistrationLog = {
    tools: [],
    commands: [],
    shortcuts: [],
    flags: [],
    events: [],
  };

  const notImplemented = (method: string) => () => {
    throw new Error(`ExtensionAPI.${method} not implemented in test stub`);
  };

  const api = {
    on: ((event: string) => {
      log.events.push(event);
    }) as unknown as ExtensionAPI["on"],
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
    getFlag: notImplemented("getFlag"),
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

  return { api, log };
}

describe("@jmcombs/pi-headroom", () => {
  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers its status + auth commands and a session_start handler", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.commands).toContain("headroom-status");
    expect(log.commands).toContain("headroom-authenticate");
    expect(log.events).toContain("session_start");
  });

  it("registers the context hook and the disable flag (Phase 2)", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.events).toContain("context");
    expect(log.flags).toContain("headroom-no-compress");
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
