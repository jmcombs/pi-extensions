/**
 * Smoke + behavioral tests for @jmcombs/pi-notify.
 *
 * Registration tests use a minimal ExtensionAPI stub. Behavioral tests capture
 * handlers and spy on stdout to verify OSC emission without a real terminal.
 * Platform-specific delivery is still exercised manually via `pi -e ./packages/notify`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import factory, { resolveWaitTools } from "./index.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => void;

function createApiStub(): {
  api: ExtensionAPI;
  commands: string[];
  events: string[];
  handlers: Map<string, EventHandler>;
} {
  const commands: string[] = [];
  const events: string[] = [];
  const handlers = new Map<string, EventHandler>();
  const notImplemented = (method: string) => () => {
    throw new Error(`ExtensionAPI.${method} not implemented in test stub`);
  };

  const api = {
    on: ((event: string, handler: EventHandler) => {
      events.push(event);
      handlers.set(event, handler);
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

  return { api, commands, events, handlers };
}

function fakeCtx(notify = vi.fn()): ExtensionContext {
  return { ui: { notify } } as unknown as ExtensionContext;
}

describe("@jmcombs/pi-notify", () => {
  const envKeys = [
    "TERM_PROGRAM",
    "KITTY_WINDOW_ID",
    "ITERM_SESSION_ID",
    "TMUX",
    "PI_NOTIFY_WAIT_TOOLS",
    "TERM",
    "WT_SESSION",
  ] as const;
  const originalEnv: Record<string, string | undefined> = {};

  for (const key of envKeys) {
    originalEnv[key] = process.env[key];
  }

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.restoreAllMocks();
  });

  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers exactly one command, named 'notify'", () => {
    const { api, commands } = createApiStub();
    factory(api);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBe("notify");
  });

  it("subscribes to agent_end and tool_execution_start", () => {
    const { api, events } = createApiStub();
    factory(api);
    expect(events).toContain("agent_end");
    expect(events).toContain("tool_execution_start");
    expect(events).toContain("tool_execution_end");
    expect(events).toContain("agent_start");
    expect(events).toContain("turn_end");
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

  describe("resolveWaitTools", () => {
    it("defaults to ask_user when unset", () => {
      expect([...resolveWaitTools(undefined)]).toEqual(["ask_user"]);
    });

    it("disables wait tools when empty", () => {
      expect(resolveWaitTools("").size).toBe(0);
      expect(resolveWaitTools("  ,  ").size).toBe(0);
    });

    it("parses a comma-separated override list", () => {
      expect([...resolveWaitTools("ask_user, confirm ,other")].sort()).toEqual([
        "ask_user",
        "confirm",
        "other",
      ]);
    });
  });

  describe("tool_execution_start wait notifications (issue #219)", () => {
    it("emits an OSC notification when ask_user starts", () => {
      // Reproduce: agent is blocked on ask_user so agent_end never fires;
      // tool_execution_start is the only moment we can alert the user.
      delete process.env.TERM_PROGRAM;
      delete process.env.KITTY_WINDOW_ID;
      delete process.env.ITERM_SESSION_ID;
      delete process.env.TMUX;
      delete process.env.PI_NOTIFY_WAIT_TOOLS;

      const writes: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

      const { api, handlers } = createApiStub();
      factory(api);

      const start = handlers.get("tool_execution_start");
      expect(start).toBeTypeOf("function");
      start?.({ toolName: "ask_user", toolCallId: "c1", args: {} }, fakeCtx());

      expect(writes.length).toBeGreaterThan(0);
      const payload = writes.join("");
      expect(payload).toContain("Waiting for your input");
      // OSC 777: ESC ] 777 ; notify ; title ; body BEL
      expect(payload).toContain("]777;notify;Pi;");
      expect(payload.charCodeAt(payload.indexOf("]777") - 1)).toBe(0x1b);
    });

    it("does not notify on unrelated tool starts", () => {
      delete process.env.TERM_PROGRAM;
      delete process.env.KITTY_WINDOW_ID;
      delete process.env.ITERM_SESSION_ID;
      delete process.env.TMUX;
      delete process.env.PI_NOTIFY_WAIT_TOOLS;

      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((() => true) as typeof process.stdout.write);

      const { api, handlers } = createApiStub();
      factory(api);
      handlers.get("tool_execution_start")?.(
        { toolName: "bash", toolCallId: "c2", args: {} },
        fakeCtx(),
      );

      expect(write).not.toHaveBeenCalled();
    });

    it("still notifies on agent_end after a completed run", () => {
      delete process.env.TERM_PROGRAM;
      delete process.env.KITTY_WINDOW_ID;
      delete process.env.ITERM_SESSION_ID;
      delete process.env.TMUX;

      const writes: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

      const { api, handlers } = createApiStub();
      factory(api);

      handlers.get("agent_start")?.({}, fakeCtx());
      handlers.get("turn_end")?.({}, fakeCtx());
      handlers.get("tool_execution_end")?.({ toolName: "bash", isError: false }, fakeCtx());
      handlers.get("agent_end")?.({}, fakeCtx());

      const payload = writes.join("");
      expect(payload).toContain("Done —");
      expect(payload).toContain("1 turn");
      expect(payload).toContain("1 tool call");
    });
  });
});
