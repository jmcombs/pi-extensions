/**
 * Login probe behavior. The unreachable case uses a closed local port.
 * The keyed-server cases call the running omlx and skip when it is absent.
 */

import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createOmlxProvider } from "./provider.js";
import { DEFAULT_OMLX_SERVER_URL, normalizeOmlxServerUrl } from "./url.js";

const SERVER_URL = normalizeOmlxServerUrl(
  process.env.OMLX_BASE_URL?.trim() || DEFAULT_OMLX_SERVER_URL,
);
const REAL_KEY = process.env.OMLX_API_KEY?.trim() ?? "";

interface ScriptedLogin {
  interaction: ProviderAuthInteraction;
  prompts: string[];
}

function scripted(answers: readonly string[]): ScriptedLogin {
  const prompts: string[] = [];
  let index = 0;
  return {
    prompts,
    interaction: {
      signal: new AbortController().signal,
      notify: () => {},
      prompt: (prompt) => {
        prompts.push(prompt.message);
        const answer = answers[index];
        index += 1;
        if (answer === undefined) {
          return Promise.reject(new Error("login prompted more than the script"));
        }
        return Promise.resolve(answer);
      },
    },
  };
}

function login(): NonNullable<
  NonNullable<ReturnType<typeof createOmlxProvider>["provider"]["auth"]["apiKey"]>["login"]
> {
  const method = createOmlxProvider().provider.auth.apiKey?.login;
  if (!method) throw new Error("omlx provider is missing apiKey.login");
  return method;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** True only when this process can reach an omlx that requires a key. */
async function keyedOmlxReachable(serverUrl: string): Promise<boolean> {
  try {
    const health = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!health.ok) return false;
    const missingKey = await fetch(`${serverUrl}/v1/models`, {
      signal: AbortSignal.timeout(2000),
    });
    if (missingKey.status !== 401) return false;
    const body: unknown = await missingKey.json();
    return isRecord(body) && isRecord(body.error) && body.error.message === "API key required";
  } catch {
    return false;
  }
}

const live = await keyedOmlxReachable(SERVER_URL);

describe("omlx login", () => {
  it("does not store a blank key when the server cannot be probed", async () => {
    const session = scripted(["http://127.0.0.1:9", ""]);
    await expect(login()(session.interaction)).rejects.toThrow(/fetch failed|ECONNREFUSED/i);
    expect(session.prompts).toEqual(["omlx server URL", "API key (optional)"]);
  });

  describe.skipIf(!live)("keyed omlx server", () => {
    it("stores a blank key as undefined", async () => {
      const session = scripted(["", ""]);
      const credential = await login()(session.interaction);
      expect(session.prompts).toEqual(["omlx server URL", "API key (optional)"]);
      expect(credential.type).toBe("api_key");
      expect(credential.key).toBeUndefined();
      expect(credential.env).toEqual({ OMLX_BASE_URL: SERVER_URL });
    }, 20_000);

    it("rejects a wrong key and returns no credential", async () => {
      const session = scripted(["", "wrong-key"]);
      await expect(login()(session.interaction)).rejects.toThrow("Invalid API key");
      expect(session.prompts).toEqual(["omlx server URL", "API key (optional)"]);
    }, 20_000);

    it.skipIf(REAL_KEY === "")(
      "stores a real key the probe accepts",
      async () => {
        const session = scripted(["", REAL_KEY]);
        const credential = await login()(session.interaction);
        if (credential.key !== REAL_KEY) {
          throw new Error("login did not return the accepted API key");
        }
        expect(credential.type).toBe("api_key");
        expect(credential.env).toEqual({ OMLX_BASE_URL: SERVER_URL });
      },
      20_000,
    );
  });
});
