/**
 * Smoke test — the default factory loads and registers provider `omlx`.
 *
 * This does not call omlx. It only checks the registration surface Pi loads.
 */

import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import factory from "./index.js";

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
