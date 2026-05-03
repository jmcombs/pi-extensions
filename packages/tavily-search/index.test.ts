/**
 * Smoke test for @jmcombs/pi-tavily-search.
 *
 * Verifies the extension's registration surface against a minimal, real-shape
 * `ExtensionAPI` stub. **No external API is mocked.** End-to-end behavior of
 * the tool is exercised manually via `pi -e ./packages/tavily-search` against
 * a real Tavily key (see README).
 */

import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import factory, { type TavilySearchInput } from "./index.js";

interface CapturedTool {
  name: string;
  label?: string;
  description?: string;
  parameters: unknown;
}

function createApiStub(): { api: ExtensionAPI; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const notImplemented = (method: string) => () => {
    throw new Error(`ExtensionAPI.${method} not implemented in test stub`);
  };

  const api = {
    on: (() => {
      /* tavily-search subscribes to no events */
    }) as unknown as ExtensionAPI["on"],
    registerTool: ((tool: ToolDefinition) => {
      tools.push({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
      });
    }) as unknown as ExtensionAPI["registerTool"],
    registerCommand: notImplemented("registerCommand"),
    registerShortcut: notImplemented("registerShortcut"),
    registerFlag: notImplemented("registerFlag"),
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

  return { api, tools };
}

describe("@jmcombs/pi-tavily-search", () => {
  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers exactly one tool, named tavily_search", () => {
    const { api, tools } = createApiStub();
    factory(api);

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("tavily_search");
    expect(tools[0]?.label).toBe("Tavily Web Search");
    expect(tools[0]?.description).toMatch(/tavily/i);
  });

  it("declares a TypeBox schema requiring a non-empty query string", () => {
    const { api, tools } = createApiStub();
    factory(api);

    const params = tools[0]?.parameters as {
      type: string;
      properties: { query: { type: string; minLength?: number } };
      required: string[];
    };

    expect(params.type).toBe("object");
    expect(params.properties.query.type).toBe("string");
    expect(params.properties.query.minLength).toBe(1);
    expect(params.required).toContain("query");
  });

  it("publicly exports the TavilySearchInput type for downstream extensions", () => {
    // Compile-time only: this assignment fails the build if the exported type
    // ever drifts from its actual schema shape.
    const sample: TavilySearchInput = { query: "pi coding agent" };
    expect(sample.query).toBe("pi coding agent");
  });
});
