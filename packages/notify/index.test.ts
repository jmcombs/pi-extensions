/**
 * Smoke test for @jmcombs/pi-notify.
 *
 * Verifies the extension's registration surface against a minimal
 * ExtensionAPI stub. No OS notification calls are made. Platform-specific
 * delivery is exercised manually via `pi -e ./packages/notify`.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import factory from "./index.js";

function createApiStub(): {
  api: ExtensionAPI;
  commands: string[];
  events: string[];
} {
  const commands: string[] = [];
  const events: string[] = [];
  const notImplemented = (method: string) => () => {
    throw new Error(`ExtensionAPI.${method} not implemented in test stub`);
  };

  const api = {
    on: ((event: string) => {
      events.push(event);
    }) as unknown as ExtensionAPI["on"],
    registerCommand: ((name: string) => {
      commands.push(name);
    }) as unknown as ExtensionAPI["registerCommand"],
    registerTool: notImplemented("registerTool"),
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

  return { api, commands, events };
}

describe("@jmcombs/pi-notify", () => {
  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers exactly one command, named 'notify'", () => {
    const { api, commands } = createApiStub();
    factory(api);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBe("notify");
  });

  it("subscribes to the agent_end event", () => {
    const { api, events } = createApiStub();
    factory(api);
    expect(events).toContain("agent_end");
  });

  it("registers no tools", () => {
    let toolRegistered = false;
    const api = {
      on: () => {
        /* no-op */
      },
      registerCommand: () => {
        /* no-op */
      },
      registerTool: () => {
        toolRegistered = true;
      },
    } as unknown as ExtensionAPI;
    factory(api);
    expect(toolRegistered).toBe(false);
  });
});
