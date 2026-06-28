/**
 * Smoke test — verifies the extension's default factory loads and registers
 * the footer via setFooter.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import factory from "./index.js";

interface RegistrationLog {
  events: string[];
  commands: string[];
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
}

function createApiStub(): { api: ExtensionAPI; log: RegistrationLog } {
  const log: RegistrationLog = {
    events: [],
    commands: [],
    handlers: new Map(),
  };

  const notImplemented = (method: string) => () => {
    throw new Error(`ExtensionAPI.${method} not implemented in test stub`);
  };

  const api = {
    on: ((event: string, handler?: (event: unknown, ctx: ExtensionContext) => unknown) => {
      log.events.push(event);
      if (handler) log.handlers.set(event, handler);
    }) as unknown as ExtensionAPI["on"],
    registerTool: notImplemented("registerTool"),
    registerCommand: ((name: string) => {
      log.commands.push(name);
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

  return { api, log };
}

function createContextStub(): ExtensionContext {
  return {
    ui: {
      setFooter: vi.fn(),
      notify: vi.fn(),
      confirm: vi.fn(),
      onInput: vi.fn(),
    },
    sessionManager: {
      getBranch: () => [],
      getCwd: () => "/test",
    },
    getContextUsage: () => undefined,
    model: undefined,
  } as unknown as ExtensionContext;
}

describe("@jmcombs/pi-blue-psl-10k", () => {
  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers on session_start and a restore-footer command", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.events).toContain("session_start");
    expect(log.commands).toContain("blue-psl-restore-footer");
  });

  it("calls setFooter when session_start fires", () => {
    const { api, log } = createApiStub();
    factory(api);

    const handler = log.handlers.get("session_start");
    expect(handler).toBeDefined();

    const ctx = createContextStub();
    handler?.({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, ctx);

    expect(ctx.ui.setFooter).toHaveBeenCalledOnce();
  });
});
