/**
 * Smoke test — the default factory loads and registers provider `omlx`.
 *
 * This does not call omlx. It only checks the registration surface Pi loads.
 */

import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import factory from "./index.js";

interface RegistrationLog {
  providers: Provider[];
}

function createApiStub(): { api: ExtensionAPI; log: RegistrationLog } {
  const log: RegistrationLog = { providers: [] };
  const notImplemented = (method: string) => () => {
    throw new Error(`ExtensionAPI.${method} not implemented in test stub`);
  };
  const api = {
    on: notImplemented("on"),
    registerTool: notImplemented("registerTool"),
    registerCommand: notImplemented("registerCommand"),
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
});
