/**
 * Smoke test — verifies the extension's default factory loads and registers
 * the resources it claims to register.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import factory from "./index.js";

interface RegistrationLog {
  tools: string[];
  commands: string[];
  shortcuts: string[];
  flags: string[];
  events: string[];
}

function createApiStub(): { api: ExtensionAPI; log: RegistrationLog } {
  const log: RegistrationLog = {
    tools: [],
    commands: [],
    shortcuts: [],
    flags: [],
    events: [],
  };

  const notImplemented =
    (method: string): (() => never) =>
    (): never => {
      throw new Error(`ExtensionAPI.${method} not implemented in test stub`);
    };

  const api = {
    on: ((_event: string) => {
      log.events.push(_event);
    }) as unknown as ExtensionAPI["on"],
    registerTool: ((_tool: { name: string }) => {
      log.tools.push(_tool.name);
    }) as unknown as ExtensionAPI["registerTool"],
    registerCommand: ((_name: string) => {
      log.commands.push(_name);
    }) as unknown as ExtensionAPI["registerCommand"],
    registerShortcut: ((_shortcut: string) => {
      log.shortcuts.push(_shortcut);
    }) as unknown as ExtensionAPI["registerShortcut"],
    registerFlag: ((_name: string) => {
      log.flags.push(_name);
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

describe("@jmcombs/pi-better-toolsy", () => {
  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers all 6 file tools", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.tools).toContain("list_dir");
    expect(log.tools).toContain("read_file");
    expect(log.tools).toContain("code_search");
    expect(log.tools).toContain("find_files");
    expect(log.tools).toContain("edit_file");
    expect(log.tools).toContain("write_file");
    expect(log.tools).toHaveLength(6);
  });

  it("registers the intercept-bash flag", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.flags).toContain("intercept-bash");
  });

  it("registers no commands or shortcuts (file-only, no TUI)", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.commands).toHaveLength(0);
    expect(log.shortcuts).toHaveLength(0);
  });
});
