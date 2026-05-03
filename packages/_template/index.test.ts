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

import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
 * Only the surface used by typical extensions is implemented; other methods
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

describe("@jmcombs/pi-EXTENSION_NAME", () => {
  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers its expected tools and commands", () => {
    const { api, log } = createApiStub();
    factory(api);

    // TODO: replace these expectations with the names this extension actually
    // registers.
    expect(log.tools).toContain("example_echo");
    expect(log.commands).toContain("example-hello");
  });
});
