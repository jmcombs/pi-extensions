/**
 * Smoke test — the default factory loads and registers provider `omlx`.
 *
 * This does not call omlx. It only checks the registration surface Pi loads.
 */

import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import factory, { finishStoppedLoad, settleModelLoad, stopWaitingNotice } from "./index.js";

interface RegisteredCommandCall {
  name: string;
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface RegistrationLog {
  providers: Provider[];
  commands: RegisteredCommandCall[];
}

interface Notification {
  message: string;
  type?: string;
}

function createApiStub(): { api: ExtensionAPI; log: RegistrationLog } {
  const log: RegistrationLog = { providers: [], commands: [] };
  const notImplemented = (method: string) => () => {
    throw new Error(`ExtensionAPI.${method} not implemented in test stub`);
  };
  const api = {
    on: notImplemented("on"),
    registerTool: notImplemented("registerTool"),
    registerCommand: ((name, options) => {
      log.commands.push({
        name,
        ...(options.description === undefined ? {} : { description: options.description }),
        handler: options.handler,
      });
    }) as ExtensionAPI["registerCommand"],
    registerShortcut: notImplemented("registerShortcut"),
    registerFlag: notImplemented("registerFlag"),
    registerMessageRenderer: notImplemented("registerMessageRenderer"),
    registerProvider: ((providerOrName: Provider | string) => {
      if (typeof providerOrName === "string") {
        throw new Error(`expected a Provider object, received name ${providerOrName}`);
      }
      log.providers.push(providerOrName);
    }) as ExtensionAPI["registerProvider"],
    unregisterProvider: notImplemented("unregisterProvider"),
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

describe("@jmcombs/pi-omlx", () => {
  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers exactly one provider with id omlx", () => {
    const { api, log } = createApiStub();
    factory(api);
    expect(log.providers).toHaveLength(1);
    expect(log.providers[0]?.id).toBe("omlx");
    expect(log.providers[0]?.name).toBe("omlx");
  });

  it("registers command omlx alongside provider omlx", () => {
    const { api, log } = createApiStub();
    factory(api);
    expect(log.providers.map((provider) => provider.id)).toEqual(["omlx"]);
    expect(log.commands.map((command) => command.name)).toEqual(["omlx"]);
    expect(log.commands[0]?.description).toBe("Manage omlx models");
  });

  it("warns that /omlx is interactive only", async () => {
    const { api, log } = createApiStub();
    factory(api);
    const command = log.commands.find((item) => item.name === "omlx");
    expect(command).toBeDefined();
    const notifications: Notification[] = [];
    const ctx = {
      mode: "print",
      ui: {
        notify: (message: string, type?: string) => {
          notifications.push(type === undefined ? { message } : { message, type });
        },
      },
    } as ExtensionCommandContext;
    await command?.handler("", ctx);
    expect(notifications).toContainEqual({
      message: "/omlx is available in interactive mode",
      type: "warning",
    });
  });
});

describe("stop waiting", () => {
  const modelId = "Qwen3.8-27B-oQ8e-mtp";
  const stopped = `Stopped waiting for ${modelId}. omlx finishes the load in the background.`;

  it("notifies that omlx finishes the load in the background", () => {
    expect(stopWaitingNotice(modelId, false)).toBe(stopped);
  });

  it("keeps the background-load sentence when unload-all restore starts", () => {
    const notice = stopWaitingNotice(modelId, true);
    expect(notice.startsWith(stopped)).toBe(true);
    expect(notice).toContain("Restoring previously loaded models.");
    expect(notice).not.toBe("Restoring previously loaded models");
  });

  it("shows the stop notice once, then restores, without a restore-only notice", async () => {
    const notices: string[] = [];
    let restored = false;
    await finishStoppedLoad({
      notify: (message) => {
        notices.push(message);
      },
      modelId,
      restoring: true,
      restore: () => {
        expect(notices).toEqual([stopWaitingNotice(modelId, true)]);
        restored = true;
        return Promise.resolve();
      },
    });
    expect(restored).toBe(true);
    expect(notices).toEqual([stopWaitingNotice(modelId, true)]);
    expect(notices[0]).toContain("omlx finishes the load in the background");
  });

  it("does not restore when unload-all has not started", async () => {
    const notices: string[] = [];
    let restored = false;
    await finishStoppedLoad({
      notify: (message) => {
        notices.push(message);
      },
      modelId,
      restoring: false,
      restore: () => {
        restored = true;
        return Promise.resolve();
      },
    });
    expect(restored).toBe(false);
    expect(notices).toEqual([stopped]);
  });

  it("keeps the stop-waiting notice when restore rejects", async () => {
    const notices: string[] = [];
    let restores = 0;
    await settleModelLoad({
      notify: (message) => {
        notices.push(message);
      },
      modelId,
      replace: true,
      run: () => Promise.resolve({ cancelled: true }),
      restore: () => {
        restores += 1;
        return Promise.reject(new Error("The operation was aborted due to timeout"));
      },
    });
    expect(restores).toBe(1);
    expect(notices).toEqual([stopWaitingNotice(modelId, true)]);
    expect(notices).not.toContain("Restoring previously loaded models");
    expect(notices[0]).toContain("omlx finishes the load in the background");
    expect(notices[0]?.startsWith(stopped)).toBe(true);
  });

  it("still restores after a failed unload-all load", async () => {
    const notices: string[] = [];
    let restores = 0;
    await expect(
      settleModelLoad({
        notify: (message) => {
          notices.push(message);
        },
        modelId,
        replace: true,
        run: () => Promise.reject(new Error("omlx returned HTTP 507")),
        restore: () => {
          restores += 1;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("omlx returned HTTP 507");
    expect(restores).toBe(1);
    expect(notices).toContain("Restoring previously loaded models");
  });
});
