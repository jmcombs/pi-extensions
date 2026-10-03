/**
 * Smoke test for @jmcombs/pi-tavily-search.
 *
 * Verifies the extension's registration surface against a minimal, real-shape
 * `ExtensionAPI` stub. **No external API is mocked.** End-to-end behavior of
 * the tool is exercised manually via `pi -e ./packages/tavily-search` against
 * a real Tavily key (see README).
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import factory, { isJsonValue, type TavilySearchInput } from "./index.js";

interface CapturedCommand {
  name: string;
  description?: string;
}

interface CapturedTool {
  name: string;
  label?: string;
  description?: string;
  parameters: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  outputSchema?: unknown;
  namespace?: {
    name: string;
    description?: string;
    instructions?: string;
  };
}

function unionMemberKeys(schema: unknown): string[][] {
  expect(schema).toEqual(expect.objectContaining({ anyOf: expect.any(Array) }));
  const anyOf = (schema as { anyOf: unknown[] }).anyOf;
  return anyOf.map((member) => {
    expect(member).toEqual(
      expect.objectContaining({ type: "object", required: expect.any(Array) }),
    );
    const required = (member as { required: string[] }).required;
    return [...required].sort();
  });
}

function createApiStub(): {
  api: ExtensionAPI;
  tools: CapturedTool[];
  commands: CapturedCommand[];
} {
  const tools: CapturedTool[] = [];
  const commands: CapturedCommand[] = [];
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
        annotations: tool.annotations,
        outputSchema: tool.outputSchema,
        namespace: tool.namespace,
      });
    }) as unknown as ExtensionAPI["registerTool"],
    registerCommand: ((name: string, opts: { description?: string }) => {
      commands.push({ name, description: opts.description });
    }) as unknown as ExtensionAPI["registerCommand"],
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

  return { api, tools, commands };
}

describe("@jmcombs/pi-tavily-search", () => {
  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers exactly one tool and one setup command", () => {
    const { api, commands, tools } = createApiStub();
    factory(api);

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("tavily_search");
    expect(tools[0]?.label).toBe("Tavily Web Search");
    expect(tools[0]?.description).toMatch(/tavily/i);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.name).toBe("tavily_setup");
    expect(commands[0]?.description).toMatch(/tavily/i);
  });

  it("tavily_search is read-only open-world and mirrors details in outputSchema", () => {
    const { api, tools } = createApiStub();
    factory(api);

    const tool = tools.find((entry) => entry.name === "tavily_search");
    expect(tool?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(tool?.namespace).toBeUndefined();
    expect(tool?.outputSchema).toBeDefined();
    expect(unionMemberKeys(tool?.outputSchema)).toEqual([["error"], ["body", "status"], ["raw"]]);
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

  it("tavily-search isJsonValue rejects undefined", () => {
    expect(isJsonValue({ ok: true, n: 1 })).toBe(true);
    expect(isJsonValue([1, "two", null])).toBe(true);
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue("hello")).toBe(true);
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue({ path: undefined })).toBe(false);
  });
});
