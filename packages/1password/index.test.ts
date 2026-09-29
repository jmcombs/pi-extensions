/**
 * Smoke test — verifies the extension's default factory loads and registers
 * the resources it claims to register.
 *
 * This is a meaningful test, not coverage theater. It exercises:
 *   - The default export is a function (Pi requires this).
 *   - Calling the factory with a minimal real-shape `ExtensionAPI` does not
 *     throw and produces the expected tool/command names.
 *   - The user_bash handler (when the runtime exposes createLocalBashOperations)
 *     returns operations and does not throw.
 *
 * It does NOT mock external APIs. Every factory() call isolates HOME and
 * PI_CODING_AGENT_DIR so a local `npm run check` cannot hang on a live `op`
 * session.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import factory from "./index.js";

interface RegistrationLog {
  tools: string[];
  commands: string[];
  shortcuts: string[];
  flags: string[];
  events: string[];
}

type EventHandler = (...args: unknown[]) => unknown;

/**
 * Builds a minimal ExtensionAPI stub that records what the factory registers.
 * Only the surface used by typical extensions is implemented; other methods
 * throw if called so missing coverage is loud.
 */
function createApiStub(): {
  api: ExtensionAPI;
  log: RegistrationLog;
  handlers: Record<string, EventHandler>;
} {
  const log: RegistrationLog = {
    tools: [],
    commands: [],
    shortcuts: [],
    flags: [],
    events: [],
  };
  const handlers: Record<string, EventHandler> = {};

  const notImplemented = (method: string) => () => {
    throw new Error(`ExtensionAPI.${method} not implemented in test stub`);
  };

  const api = {
    on: ((event: string, handler: EventHandler) => {
      log.events.push(event);
      handlers[event] = handler;
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

  return { api, log, handlers };
}

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
  const tmp = await mkdtemp(join(tmpdir(), "1p-factory-"));
  const savedHome = process.env.HOME;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = tmp;
  process.env.PI_CODING_AGENT_DIR = tmp;
  try {
    return await fn();
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  }
}

describe("@jmcombs/pi-1password", () => {
  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers its expected tools and the /1password_setup command", async () => {
    await withIsolatedHome(async () => {
      const { api, log } = createApiStub();
      await factory(api);

      // 1p_diagnose is registered for LLM use (diagnostics). We also register a
      // wrapped "bash" tool for transparent env injection and (on runtimes that
      // expose createLocalBashOperations) handle the user_bash event.
      expect(log.tools).toContain("1p_diagnose");

      // The guided onboarding command for adding new !op read entries to auth.json
      expect(log.commands).toContain("1password_setup");
    });
  }, 30000);

  it("user_bash handler returns operations and does not throw", async () => {
    await withIsolatedHome(async () => {
      const { api, log, handlers } = createApiStub();
      await factory(api);

      if (typeof createLocalBashOperations === "function") {
        expect(log.events).toContain("user_bash");
        const handler = handlers.user_bash;
        expect(typeof handler).toBe("function");
        const pending = Promise.resolve(handler?.());
        await expect(pending).resolves.toBeDefined();
        const result = await pending;
        expect(result).toEqual(expect.objectContaining({ operations: expect.anything() }));
        const operations = (result as { operations: { exec: unknown }; result?: unknown })
          .operations;
        expect(typeof operations.exec).toBe("function");
        expect(result).not.toHaveProperty("result");
      }
    });
  }, 30000);
});
