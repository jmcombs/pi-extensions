/**
 * Smoke test — verifies the extension's default factory loads and registers
 * the resources it claims to register.
 *
 * This is a meaningful test, not coverage theater. It exercises:
 *   - The default export is a function (Pi requires this).
 *   - Calling the factory with a minimal real-shape `ExtensionAPI` does not
 *     throw and produces the expected tool names.
 *
 * It does NOT spawn `claude`, hit the network, or exercise dispatch — the async
 * substrate is proven separately by `scripts/harness.mjs` (Gate 2) against a
 * real `claude -p`. This test only asserts the registration surface.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import factory from "./index.js";

interface RegistrationLog {
  tools: string[];
  commands: string[];
  shortcuts: string[];
  flags: string[];
  events: string[];
}

/**
 * Builds a minimal ExtensionAPI stub that records what the factory registers.
 * Only the surface used by this extension's registration path is implemented;
 * other methods throw if called so missing coverage is loud.
 */
function createApiStub(): {
  api: ExtensionAPI;
  log: RegistrationLog;
  tools: Map<string, ToolDefinition>;
} {
  const log: RegistrationLog = {
    tools: [],
    commands: [],
    shortcuts: [],
    flags: [],
    events: [],
  };
  const tools = new Map<string, ToolDefinition>();

  const notImplemented = (method: string) => () => {
    throw new Error(`ExtensionAPI.${method} not implemented in test stub`);
  };

  const api = {
    on: ((event: string) => {
      log.events.push(event);
    }) as unknown as ExtensionAPI["on"],
    registerTool: ((tool: ToolDefinition) => {
      log.tools.push(tool.name);
      tools.set(tool.name, tool);
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
    events: { emit: notImplemented("events.emit") },
  } as unknown as ExtensionAPI;

  return { api, log, tools };
}

describe("@jmcombs/pi-relay", () => {
  beforeEach(() => {
    // Clear the D8 re-entrancy sentinel so each factory call registers cleanly
    // (a prior call — or an inherited env — would otherwise short-circuit it).
    delete process.env.PI_RELAY_ACTIVE;
  });

  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers its expected tools", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.tools).toContain("verify_phase");
    expect(log.tools).toContain("dispatch");
  });

  it("honors the D8 re-entrancy guard: no re-registration when the sentinel is set", () => {
    process.env.PI_RELAY_ACTIVE = "1";
    const { api, log } = createApiStub();
    factory(api);

    expect(log.tools).toEqual([]);
  });

  it("throws (never silently returns an error flag) on synchronous setup failure (D9)", () => {
    const { api, tools } = createApiStub();
    factory(api);

    const verifyPhase = tools.get("verify_phase");
    if (!verifyPhase) throw new Error("verify_phase was not registered");

    // A non-string cwd makes the synchronous `child_process.spawn` setup throw
    // (ERR_INVALID_ARG_TYPE). Per D9 the pi runtime silently discards a returned
    // tool-result error flag, so the ONLY way to surface a real error is to throw.
    // This asserts the tool propagates the failure as a throw, not a no-op result.
    const ctx = { cwd: process.cwd() } as unknown as ExtensionContext;
    const badParams = { phase: "boom", cwd: 12345 } as unknown as Parameters<
      ToolDefinition["execute"]
    >[1];

    expect(() => verifyPhase.execute("call-throw", badParams, undefined, undefined, ctx)).toThrow(
      /Failed to dispatch verify_phase/,
    );
  });
});
