import { createServer, type Server } from "node:http";
import type {
  AnyModel,
  ApiKeyCredential,
  AuthContext,
  Model,
  Provider,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
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

const STORED_CHAT: Model<"openai-completions"> = {
  id: "cached",
  name: "cached",
  api: "openai-completions",
  provider: "omlx",
  baseUrl: "http://10.0.0.8:9000/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

const OTHER_PROVIDER: Model<"openai-completions"> = {
  ...STORED_CHAT,
  id: "foreign",
  provider: "other",
};

function refreshContext(
  overrides: Partial<RefreshModelsContext> & Pick<RefreshModelsContext, "publish">,
): RefreshModelsContext {
  return {
    allowNetwork: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function refresh(): NonNullable<Provider["refreshModels"]> {
  const method = createOmlxProvider().provider.refreshModels;
  if (!method) throw new Error("omlx provider is missing refreshModels");
  return method;
}

describe("omlx refreshModels", () => {
  it("restores stored omlx chat models and ignores other providers", async () => {
    const { provider } = createOmlxProvider();
    const method = provider.refreshModels;
    if (!method) throw new Error("omlx provider is missing refreshModels");
    await method(
      refreshContext({
        stored: { models: [OTHER_PROVIDER, STORED_CHAT] },
        allowNetwork: false,
        publish: (publication) => {
          publication.update?.();
          return Promise.resolve(true);
        },
      }),
    );
    expect(provider.getModels()).toEqual([STORED_CHAT]);
  });

  it("returns without fetching when publish rejects the restore", async () => {
    await expect(
      refresh()(
        refreshContext({
          stored: { models: [STORED_CHAT] },
          allowNetwork: true,
          credential: {
            type: "api_key",
            key: "stored-key",
            env: { OMLX_BASE_URL: "http://127.0.0.1:9" },
          },
          publish: () => Promise.resolve(false),
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("skips the network phase unless allowNetwork, a live signal, and an api_key URL", async () => {
    const closed: ApiKeyCredential = {
      type: "api_key",
      key: "stored-key",
      env: { OMLX_BASE_URL: "http://127.0.0.1:9" },
    };
    const method = refresh();
    await expect(
      method(
        refreshContext({
          allowNetwork: false,
          credential: closed,
          publish: () => Promise.resolve(true),
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      method(
        refreshContext({
          allowNetwork: true,
          signal: AbortSignal.abort(),
          credential: closed,
          publish: () => Promise.resolve(true),
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      method(
        refreshContext({
          allowNetwork: true,
          credential: { type: "api_key", key: "stored-key" },
          publish: () => Promise.resolve(true),
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      method(
        refreshContext({
          allowNetwork: true,
          credential: {
            type: "oauth",
            access: "access",
            refresh: "refresh",
            expires: 0,
            env: { OMLX_BASE_URL: "http://127.0.0.1:9" },
          },
          publish: () => Promise.resolve(true),
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("applies a stored context window when status length is null", async () => {
    // Ephemeral stand-in for the two GETs refreshModels already makes. Not a fetch
    // mock and not a fixture file: this row exists only here so a null status length
    // can let the stored window win.
    const publishedId = "inline-published";
    const cachedWindow = 424242;
    const server = createServer((req, res) => {
      const path = req.url ?? "";
      if (path === "/v1/models/status") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            models: [
              {
                id: "inline-physical",
                loaded: true,
                is_loading: false,
                model_type: "llm",
                engine_type: "batched",
                model_format: null,
                model_context_length: null,
                thinking_default: null,
                reasoning_efforts: null,
                is_hidden: false,
                model_alias: publishedId,
                estimated_size: null,
                loading_started_at: null,
              },
            ],
            load_seconds_per_gb_estimate: null,
            load_time_observations: 0,
          }),
        );
        return;
      }
      if (path === "/v1/models") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ id: publishedId }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const url = await listen(server);
      const { provider } = createOmlxProvider();
      const method = provider.refreshModels;
      if (!method) throw new Error("omlx provider is missing refreshModels");
      const stored: Model<"openai-completions"> = {
        ...STORED_CHAT,
        id: publishedId,
        name: "stale-name",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: cachedWindow,
        maxTokens: 999,
      };
      const foreignSameId: Model<"openai-completions"> = {
        ...stored,
        provider: "other",
        contextWindow: 111,
        maxTokens: 111,
      };
      const persisted: AnyModel[] = [];
      await method(
        refreshContext({
          allowNetwork: true,
          credential: {
            type: "api_key",
            key: "stored-key",
            env: { OMLX_BASE_URL: url },
          },
          stored: { models: [stored, foreignSameId] },
          publish: (publication) => {
            publication.update?.();
            if (publication.persist) persisted.push(...publication.persist.models);
            return Promise.resolve(true);
          },
        }),
      );
      // A restore-only publish has no persist payload. Mapping without the cached
      // step would publish 128000, and copying the stored model would keep its name.
      expect(persisted).toMatchObject([
        {
          id: publishedId,
          name: publishedId,
          reasoning: false,
          input: ["text"],
          contextWindow: cachedWindow,
          maxTokens: cachedWindow,
        },
      ]);
      expect(provider.getModels()).toEqual(persisted);
    } finally {
      await closeServer(server);
    }
  });
});

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("status stand-in did not bind a port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
