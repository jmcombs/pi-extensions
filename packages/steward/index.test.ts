/**
 * These drive the extension the way Pi does: the stub below is a minimal
 * real-shape `ExtensionAPI` that records registrations and hands the real
 * command handlers back, so `/steward`, `/steward-stop` and the session
 * shutdown hook run their actual code against a real loopback server. Every
 * method the factory is not expected to touch throws, so missing coverage is
 * loud.
 *
 * `PATH` is emptied for the duration, which is how the browser stays shut: the
 * platform opener cannot be found, the extension reports that as a warning, and
 * the URL it printed first is still the thing under test.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import factory from "./index.js";

type NotifyLevel = "info" | "warning" | "error";

interface Notification {
  message: string;
  level: NotifyLevel;
}

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type EventHandler = (event: SessionShutdownEvent, ctx: unknown) => Promise<void> | void;

interface RegistrationLog {
  tools: string[];
  commands: string[];
  shortcuts: string[];
  flags: string[];
  events: string[];
  handlers: Map<string, CommandHandler>;
  listeners: Map<string, EventHandler>;
  notifications: Notification[];
}

function createApiStub(): { api: ExtensionAPI; log: RegistrationLog } {
  const log: RegistrationLog = {
    tools: [],
    commands: [],
    shortcuts: [],
    flags: [],
    events: [],
    handlers: new Map(),
    listeners: new Map(),
    notifications: [],
  };

  const notImplemented = (method: string) => () => {
    throw new Error(`ExtensionAPI.${method} not implemented in test stub`);
  };

  const api = {
    on: ((event: string, handler: EventHandler) => {
      log.events.push(event);
      log.listeners.set(event, handler);
    }) as unknown as ExtensionAPI["on"],
    registerTool: ((tool: { name: string }) => {
      log.tools.push(tool.name);
    }) as unknown as ExtensionAPI["registerTool"],
    registerCommand: ((name: string, options: { handler: CommandHandler }) => {
      log.commands.push(name);
      log.handlers.set(name, options.handler);
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

/** Loads the extension and returns callables for everything it registered. */
function load(): {
  log: RegistrationLog;
  run: (command: string) => Promise<void>;
  shutdown: () => Promise<void>;
} {
  const { api, log } = createApiStub();
  factory(api);

  const ctx = {
    ui: {
      notify: (message: string, level: NotifyLevel = "info") => {
        log.notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionCommandContext;

  return {
    log,
    run: async (command: string) => {
      const handler = log.handlers.get(command);
      if (handler === undefined) throw new Error(`the extension registered no /${command}`);
      await handler("", ctx);
    },
    shutdown: async () => {
      const listener = log.listeners.get("session_shutdown");
      if (listener === undefined) throw new Error("the extension registered no shutdown hook");
      await listener({} as SessionShutdownEvent, ctx);
    },
  };
}

function messages(log: RegistrationLog): string[] {
  return log.notifications.map((entry) => entry.message);
}

/** The URL out of the "serving at" notification, which is the operator's copy. */
function servedUrl(log: RegistrationLog): string {
  const match = messages(log)
    .map((message) => /(http:\/\/127\.0\.0\.1:\d+)/.exec(message))
    .find((found) => found !== null);
  if (match?.[1] === undefined)
    throw new Error(`no URL was reported: ${messages(log).join(" | ")}`);
  return match[1];
}

/** Holds a port the way a second Pi session or a leftover dev server would. */
async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createServer((_req, res) => res.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port was bound");
  return {
    port: address.port,
    release: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let emptyDir = "";
let realPath: string | undefined;

beforeAll(async () => {
  emptyDir = await mkdtemp(path.join(tmpdir(), "steward-no-opener-"));
});

afterAll(async () => {
  await rm(emptyDir, { recursive: true, force: true });
});

beforeEach(() => {
  realPath = process.env.PATH;
  process.env.PATH = emptyDir;
  process.env.STEWARD_PORT = "0";
});

afterEach(async () => {
  // The module holds one server for the whole process, so every test hands it
  // back before the next one asks for it.
  await load().run("steward-stop");
  process.env.PATH = realPath;
  delete process.env.STEWARD_PORT;
});

describe("@jmcombs/pi-steward", () => {
  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers its expected commands", () => {
    const { log } = load();

    expect(log.commands).toEqual(["steward", "steward-stop", "initialize-steward"]);
    expect(log.tools).toEqual([]);
  });

  it("hooks session shutdown so the dashboard server does not outlive the session", () => {
    const { log } = load();

    expect(log.events).toEqual(["session_start", "turn_end", "session_shutdown"]);
  });

  it("loads on a host whose API omits the optional event hook", () => {
    const { api, log } = createApiStub();
    // oh-my-pi's compatibility shim exports a subset of Pi's runtime; the
    // extension must still register its commands when `on` is missing.
    const withoutOn = { ...api, on: undefined } as unknown as ExtensionAPI;

    expect(() => factory(withoutOn)).not.toThrow();
    expect(log.commands).toEqual(["steward", "steward-stop", "initialize-steward"]);
  });
});

describe("/steward", () => {
  it("serves a dashboard, reports where, and warns when it cannot open a browser", async () => {
    const { log, run } = load();
    await run("steward");

    const url = servedUrl(log);
    const response = await fetch(`${url}/api/snapshot`);
    expect(response.status).toBe(200);

    expect(log.notifications[0]?.level).toBe("info");
    expect(log.notifications[1]).toMatchObject({ level: "warning" });
    expect(log.notifications[1]?.message).toContain("could not open a browser");
  });

  it("hands back the one server rather than binding a second one", async () => {
    const { log, run } = load();
    await run("steward");
    const first = servedUrl(log);

    log.notifications.length = 0;
    await run("steward");
    expect(servedUrl(log)).toBe(first);
  });

  it("falls back to a free port when the one it was told to use is taken", async () => {
    const taken = await occupyPort();
    process.env.STEWARD_PORT = String(taken.port);

    try {
      const { log, run } = load();
      await run("steward");

      const url = servedUrl(log);
      expect(url).not.toContain(`:${taken.port}`);
      expect(messages(log)[0]).toContain(`port ${taken.port} was already in use`);
      expect((await fetch(`${url}/api/snapshot`)).status).toBe(200);
    } finally {
      await taken.release();
    }
  });

  it("names the problem when the port it was given is not a port", async () => {
    process.env.STEWARD_PORT = "http-please";
    const { log, run } = load();

    await run("steward");

    expect(log.notifications[0]?.level).toBe("error");
    expect(log.notifications[0]?.message).toContain("STEWARD_PORT=http-please");
    expect(messages(log).join(" ")).not.toContain("http://127.0.0.1");
  });
});

describe("/steward-stop", () => {
  it("says so when there is nothing to stop", async () => {
    const { log, run } = load();
    await run("steward-stop");

    expect(log.notifications).toEqual([{ message: "Steward is not running.", level: "info" }]);
  });

  it("stops a running dashboard", async () => {
    const { log, run } = load();
    await run("steward");
    const url = servedUrl(log);

    log.notifications.length = 0;
    await run("steward-stop");

    expect(messages(log)).toEqual(["Steward stopped."]);
    await expect(fetch(url)).rejects.toThrow();
  });

  it("stops a dashboard whose start has not finished, and says what it did", async () => {
    const { log, run } = load();

    // Both commands are in flight at once; the stop must not report "not
    // running" and then let the start bind behind it.
    const opening = run("steward");
    const stopping = run("steward-stop");
    await Promise.all([opening, stopping]);

    expect(messages(log)).toContain("Steward stopped.");
    expect(messages(log)).not.toContain("Steward is not running.");
    await expect(fetch(servedUrl(log))).rejects.toThrow();
  });
});

describe("session shutdown", () => {
  it("leaves nothing bound when it lands mid-start", async () => {
    const { log, run, shutdown } = load();

    const opening = run("steward");
    await shutdown();
    await opening;

    await expect(fetch(servedUrl(log))).rejects.toThrow();
  });

  it("closes a dashboard the session opened earlier", async () => {
    const { log, run, shutdown } = load();
    await run("steward");
    const url = servedUrl(log);

    await shutdown();

    await expect(fetch(url)).rejects.toThrow();
  });
});
