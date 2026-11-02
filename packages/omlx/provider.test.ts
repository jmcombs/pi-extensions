import type { ApiKeyCredential, AuthContext, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createOmlxProvider } from "./provider.js";

const SIGNAL = AbortSignal.abort();

function authContext(env: Record<string, string | undefined>): AuthContext {
  return {
    env: (name: string) => Promise.resolve(env[name]),
    fileExists: () => Promise.reject(new Error("fileExists must not be called")),
  };
}

function apiKeyAuth(provider: Provider): {
  check: NonNullable<NonNullable<Provider["auth"]["apiKey"]>["check"]>;
  resolve: NonNullable<Provider["auth"]["apiKey"]>["resolve"];
} {
  const apiKey = provider.auth.apiKey;
  if (!apiKey?.check) throw new Error("omlx provider is missing apiKey.check");
  return { check: apiKey.check, resolve: apiKey.resolve };
}

describe("omlx provider auth", () => {
  it("returns an empty model list and the default /v1 base URL", () => {
    const { provider } = createOmlxProvider();
    expect(provider.id).toBe("omlx");
    expect(provider.name).toBe("omlx");
    expect(provider.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(provider.getModels()).toEqual([]);
    expect(provider.getAllModels?.()).toEqual([]);
  });

  it("check returns undefined when no URL is configured", async () => {
    const { check } = apiKeyAuth(createOmlxProvider().provider);
    await expect(check({ ctx: authContext({}), signal: SIGNAL })).resolves.toBeUndefined();
  });

  it("prefers the stored URL over OMLX_BASE_URL", async () => {
    const { provider } = createOmlxProvider();
    const { check, resolve } = apiKeyAuth(provider);
    const credential: ApiKeyCredential = {
      type: "api_key",
      key: "stored-key",
      env: { OMLX_BASE_URL: "http://10.0.0.8:9000/v1/" },
    };
    const ctx = authContext({
      OMLX_BASE_URL: "http://127.0.0.1:8000",
      OMLX_API_KEY: "env-key",
    });

    await expect(check({ ctx, credential, signal: SIGNAL })).resolves.toEqual({
      type: "api_key",
      source: "stored credential",
    });
    await expect(resolve({ ctx, credential, signal: SIGNAL })).resolves.toEqual({
      auth: { apiKey: "stored-key", baseUrl: "http://10.0.0.8:9000/v1" },
      env: { OMLX_BASE_URL: "http://10.0.0.8:9000" },
      source: "stored credential",
    });
  });

  it("uses credential.key, then OMLX_API_KEY, then local", async () => {
    const { resolve } = apiKeyAuth(createOmlxProvider().provider);
    const ctx = authContext({
      OMLX_BASE_URL: "http://127.0.0.1:8000",
      OMLX_API_KEY: "env-key",
    });
    const stored: ApiKeyCredential = { type: "api_key", key: "stored-key" };
    const storedWithoutKey: ApiKeyCredential = { type: "api_key" };

    await expect(resolve({ ctx, credential: stored, signal: SIGNAL })).resolves.toMatchObject({
      auth: { apiKey: "stored-key", baseUrl: "http://127.0.0.1:8000/v1" },
    });
    await expect(
      resolve({ ctx, credential: storedWithoutKey, signal: SIGNAL }),
    ).resolves.toMatchObject({
      auth: { apiKey: "env-key" },
    });
    await expect(
      resolve({
        ctx: authContext({ OMLX_BASE_URL: "http://127.0.0.1:8000/" }),
        credential: storedWithoutKey,
        signal: SIGNAL,
      }),
    ).resolves.toMatchObject({
      auth: { apiKey: "local", baseUrl: "http://127.0.0.1:8000/v1" },
    });
    await expect(resolve({ ctx, signal: SIGNAL })).resolves.toMatchObject({
      auth: { apiKey: "env-key", baseUrl: "http://127.0.0.1:8000/v1" },
      source: "OMLX_BASE_URL",
    });
  });

  it("resolve returns undefined when no URL is configured", async () => {
    const { resolve } = apiKeyAuth(createOmlxProvider().provider);
    await expect(
      resolve({ ctx: authContext({ OMLX_API_KEY: "env-key" }), signal: SIGNAL }),
    ).resolves.toBeUndefined();
  });
});
