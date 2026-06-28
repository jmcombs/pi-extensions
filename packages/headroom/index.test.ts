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
import factory, { createSavingsAccumulator } from "./index.js";

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

  it("registers a context handler and the disable-compression flag", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.events).toContain("context");
    expect(log.flags).toContain("headroom-no-compress");
  });
});

describe("createSavingsAccumulator", () => {
  it("starts at zero", () => {
    const acc = createSavingsAccumulator();
    expect(acc.snapshot()).toEqual({ totalTokensSaved: 0, compressions: 0 });
  });

  it("accumulates token savings and counts every pass", () => {
    const acc = createSavingsAccumulator();
    acc.record(100);
    acc.record(250);
    acc.record(0);

    expect(acc.snapshot()).toEqual({ totalTokensSaved: 350, compressions: 3 });
  });

  it("clamps negative and non-finite savings to zero but still counts the pass", () => {
    const acc = createSavingsAccumulator();
    acc.record(-50);
    acc.record(Number.NaN);
    acc.record(Number.POSITIVE_INFINITY);
    acc.record(40);

    expect(acc.snapshot()).toEqual({ totalTokensSaved: 40, compressions: 4 });
  });
});
