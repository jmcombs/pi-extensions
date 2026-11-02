import type {
  ApiKeyCredential,
  AuthContext,
  Model,
  Provider,
  ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
import { OmlxClient } from "./client.js";
import { DEFAULT_OMLX_SERVER_URL, normalizeOmlxServerUrl, omlxInferenceUrl } from "./url.js";

export const OMLX_PROVIDER_ID = "omlx";

export interface OmlxProviderController {
  provider: Provider<"openai-completions">;
  /** Phase 1 keeps the catalog empty. Later phases map omlx rows into it. */
  setCatalog: () => void;
}

function credentialServerUrl(credential: ApiKeyCredential | undefined): string | undefined {
  const value = credential?.env?.OMLX_BASE_URL;
  return typeof value === "string" && value.trim() ? normalizeOmlxServerUrl(value) : undefined;
}

/**
 * compat `stream` takes `ProviderStreamOptions` (`StreamOptions & Record<string, unknown>`).
 * Provider `stream` passes API-specific options that lack that index signature. A shallow copy
 * keeps the same fields, and the fresh object satisfies the index signature.
 */
function compatStreamOptions(options: object | undefined): ProviderStreamOptions | undefined {
  if (options === undefined) return undefined;
  return { ...options };
}

async function resolveServerUrl(
  ctx: AuthContext,
  credential: ApiKeyCredential | undefined,
): Promise<string | undefined> {
  const fromEnv = (await ctx.env("OMLX_BASE_URL"))?.trim();
  const configured = credentialServerUrl(credential) ?? fromEnv;
  return configured ? normalizeOmlxServerUrl(configured) : undefined;
}

/**
 * omlx's missing-key 401 on `GET /v1/models` (`error.message`).
 * A rejected key is `"Invalid API key"` and must not match.
 */
function isMissingApiKeyProbe(error: unknown): boolean {
  return error instanceof Error && error.message === "API key required";
}

export function createOmlxProvider(): OmlxProviderController {
  let models: Model<"openai-completions">[] = [];
  const setCatalog = (): void => {
    models = [];
  };
  const provider: Provider<"openai-completions"> = {
    id: OMLX_PROVIDER_ID,
    name: "omlx",
    baseUrl: omlxInferenceUrl(DEFAULT_OMLX_SERVER_URL),
    auth: {
      apiKey: {
        name: "omlx server",
        login: async (interaction) => {
          const enteredUrl = await interaction.prompt({
            type: "text",
            message: "omlx server URL",
            placeholder: process.env.OMLX_BASE_URL ?? DEFAULT_OMLX_SERVER_URL,
          });
          const serverUrl = normalizeOmlxServerUrl(
            enteredUrl.trim() || process.env.OMLX_BASE_URL || DEFAULT_OMLX_SERVER_URL,
          );
          const apiKey = (
            await interaction.prompt({
              type: "secret",
              message: "API key (optional)",
            })
          ).trim();
          try {
            await new OmlxClient(serverUrl, apiKey || undefined).listModels(interaction.signal);
          } catch (error) {
            // Row 4: a blank key is stored as no key. On a keyed server the
            // keyless probe still reaches omlx and returns "API key required".
            // That is not a rejected key. A present key fails on any probe error.
            if (apiKey !== "" || !isMissingApiKeyProbe(error)) throw error;
          }
          return {
            type: "api_key",
            key: apiKey || undefined,
            env: { OMLX_BASE_URL: serverUrl },
          };
        },
        check: async ({ ctx, credential }) => {
          const serverUrl = await resolveServerUrl(ctx, credential);
          if (!serverUrl) return undefined;
          return {
            type: "api_key",
            source: credential ? "stored credential" : "OMLX_BASE_URL",
          };
        },
        resolve: async ({ ctx, credential }) => {
          const serverUrl = await resolveServerUrl(ctx, credential);
          if (!serverUrl) return undefined;
          const apiKey = credential?.key ?? (await ctx.env("OMLX_API_KEY")) ?? "local";
          return {
            auth: { apiKey, baseUrl: omlxInferenceUrl(serverUrl) },
            env: { ...credential?.env, OMLX_BASE_URL: serverUrl },
            source: credential ? "stored credential" : "OMLX_BASE_URL",
          };
        },
      },
    },
    getModels: () => models,
    getAllModels: () => models,
    stream: (model, context, options) => stream(model, context, compatStreamOptions(options)),
    streamSimple: (model, context, options) => streamSimple(model, context, options),
  };
  return { provider, setCatalog };
}
