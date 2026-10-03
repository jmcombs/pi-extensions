/**
 * Smoke test — verifies the extension's default factory loads and registers
 * the resources it claims to register.
 *
 * This is a meaningful test, not coverage theater. It exercises:
 *   - The default export is a function (Pi requires this).
 *   - Calling the factory with a minimal real-shape `ExtensionAPI` does not
 *     throw and produces the expected tool/command names.
 *
 * It does NOT mock external APIs. If your tool calls a network service,
 * write the smoke test against the registration surface only — leave
 * end-to-end behavior to manual testing with `pi -e`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import factory, { isJsonValue } from "./index.js";

interface RegisteredTool {
  name: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  namespace?: {
    name: string;
    description?: string;
    instructions?: string;
  };
  outputSchema?: unknown;
}

interface RegistrationLog {
  tools: string[];
  registered: RegisteredTool[];
  commands: string[];
  shortcuts: string[];
  flags: string[];
  events: string[];
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

/**
 * Builds a minimal ExtensionAPI stub that records what the factory registers.
 * Only the surface used by typical extensions is implemented; other methods
 * throw if called so missing coverage is loud.
 */
function createApiStub(): { api: ExtensionAPI; log: RegistrationLog } {
  const log: RegistrationLog = {
    tools: [],
    registered: [],
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
    registerTool: ((tool: RegisteredTool) => {
      log.tools.push(tool.name);
      log.registered.push(tool);
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

describe("@jmcombs/pi-context7", () => {
  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers its expected tools and commands", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.tools).toContain("context7_search");
    expect(log.tools).toContain("context7_get_docs");
    expect(log.commands).toContain("context7_setup");
  });

  it("context7 tools are read-only open-world and share namespace context7", () => {
    const { api, log } = createApiStub();
    factory(api);

    const annotations = {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    };
    const search = log.registered.find((tool) => tool.name === "context7_search");
    const docs = log.registered.find((tool) => tool.name === "context7_get_docs");

    expect(search).toBeDefined();
    expect(docs).toBeDefined();
    expect(search?.annotations).toEqual(annotations);
    expect(docs?.annotations).toEqual(annotations);
    expect(search?.namespace).toEqual({ name: "context7" });
    expect(docs?.namespace).toEqual({ name: "context7" });
    expect(search?.namespace?.name).toBe("context7");
    expect(docs?.namespace?.name).toBe("context7");
    expect(search?.outputSchema).toBeDefined();
    expect(docs?.outputSchema).toBeDefined();
    expect(unionMemberKeys(search?.outputSchema)).toEqual([
      ["error"],
      ["status"],
      ["body", "status"],
      ["libraryName", "raw"],
    ]);
    expect(unionMemberKeys(docs?.outputSchema)).toEqual([
      ["error"],
      ["status"],
      ["body", "status"],
      ["libraryId", "query", "raw"],
    ]);
  });

  it("context7 isJsonValue rejects undefined", () => {
    expect(isJsonValue({ ok: true, n: 1 })).toBe(true);
    expect(isJsonValue([1, "two", null])).toBe(true);
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue("hello")).toBe(true);
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue({ path: undefined })).toBe(false);
  });
});
