import type {
  AnyModel,
  ApiKeyCredential,
  AuthContext,
  ClassifierModel,
  Model,
  Provider,
  ProviderStreamOptions,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { isModelType } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
import { chatModelsFromStatus, classifierModelsFromStatus } from "./catalog.js";
import { createOmlxClassify } from "./classify.js";
import { OmlxClient, type OmlxListedModel, type OmlxModelStatus } from "./client.js";
import { DEFAULT_OMLX_SERVER_URL, normalizeOmlxServerUrl, omlxInferenceUrl } from "./url.js";

export const OMLX_PROVIDER_ID = "omlx";

export interface OmlxProviderController {
  provider: Provider<"openai-completions">;
  /** Replace the in-memory chat and classifier catalogs. No network. */
  setCatalog: (
    status: OmlxModelStatus,
    listed: readonly OmlxListedModel[],
    serverUrl?: string,
  ) => void;
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

function isOmlxChatModel(model: AnyModel): model is Model<"openai-completions"> {
  return (
    model.provider === OMLX_PROVIDER_ID &&
    isModelType(model, "chat") &&
    model.api === "openai-completions"
  );
}

function isOmlxClassifierModel(model: AnyModel): model is ClassifierModel<"typesafe-system-one"> {
  return (
    model.provider === OMLX_PROVIDER_ID &&
    isModelType(model, "classifier") &&
    model.api === "typesafe-system-one"
  );
}

function cachedContextWindows(stored: readonly AnyModel[]): Map<string, number> {
  const cached = new Map<string, number>();
  for (const model of stored) {
    if (model.provider !== OMLX_PROVIDER_ID || !("contextWindow" in model)) continue;
    if (typeof model.contextWindow === "number") cached.set(model.id, model.contextWindow);
  }
  return cached;
}

export function createOmlxProvider(): OmlxProviderController {
  let models: Model<"openai-completions">[] = [];
  let classifiers: ClassifierModel<"typesafe-system-one">[] = [];
  const classify = createOmlxClassify();
  const setCatalog = (
    status: OmlxModelStatus,
    listed: readonly OmlxListedModel[],
    serverUrl: string = DEFAULT_OMLX_SERVER_URL,
  ): void => {
    models = chatModelsFromStatus(status.models, listed, serverUrl);
    classifiers = classifierModelsFromStatus(status.models, listed, serverUrl);
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
              message: "API key (required)",
            })
          ).trim();
          // Admin routes need the main key, so a blank key is never stored.
          if (apiKey === "") throw new Error("API key required");
          await new OmlxClient(serverUrl, apiKey).listModels(interaction.signal);
          return {
            type: "api_key",
            key: apiKey,
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
    getAllModels: () => [...models, ...classifiers],
    refreshModels: async (context: RefreshModelsContext): Promise<void> => {
      const cached = context.stored ? cachedContextWindows(context.stored.models) : undefined;
      if (context.stored) {
        const restored = context.stored.models.filter(isOmlxChatModel);
        const restoredClassifiers = context.stored.models.filter(isOmlxClassifierModel);
        if (
          !(await context.publish({
            update: () => {
              models = restored;
              classifiers = restoredClassifiers;
            },
          }))
        ) {
          return;
        }
      }
      if (
        !context.allowNetwork ||
        context.signal.aborted ||
        context.credential?.type !== "api_key"
      ) {
        return;
      }
      const serverUrl = credentialServerUrl(context.credential);
      if (!serverUrl) return;
      const client = new OmlxClient(serverUrl, context.credential.key);
      const status = await client.listStatus(context.signal);
      if (context.signal.aborted) return;
      const listed = await client.listModels(context.signal);
      if (context.signal.aborted) return;
      const refreshed = chatModelsFromStatus(status.models, listed, serverUrl, cached);
      const refreshedClassifiers = classifierModelsFromStatus(
        status.models,
        listed,
        serverUrl,
        cached,
      );
      if (context.signal.aborted) return;
      await context.publish({
        persist: { models: [...refreshed, ...refreshedClassifiers], checkedAt: Date.now() },
        update: () => {
          models = refreshed;
          classifiers = refreshedClassifiers;
        },
      });
    },
    stream: (model, context, options) => stream(model, context, compatStreamOptions(options)),
    streamSimple: (model, context, options) => streamSimple(model, context, options),
    classify,
  };
  return { provider, setCatalog };
}
