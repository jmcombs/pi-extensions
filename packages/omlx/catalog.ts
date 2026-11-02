import type { Model } from "@earendil-works/pi-ai";
import type { OmlxListedModel, OmlxStatusRow } from "./client.js";
import { omlxInferenceUrl } from "./url.js";

/** Matches `OMLX_PROVIDER_ID`. Kept here so catalog mapping does not import the provider. */
const OMLX_PROVIDER = "omlx";

/** Last fallback in the llama context-window chain. */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

const THINKING_LEVEL_MAP = {
  off: "off",
  minimal: null,
  low: null,
  medium: "medium",
  high: null,
  xhigh: null,
} as const;

/** Chat rows are `llm` and `vlm`. Decision, embedding, rerank, and audio are not. */
export function isChatRow(row: OmlxStatusRow): boolean {
  return row.model_type === "llm" || row.model_type === "vlm";
}

/** Decision models are classifier-only. Phase 3 publishes them; chat never does. */
export function isDecisionRow(row: OmlxStatusRow): boolean {
  return row.model_type === "decision";
}

/** GGUF rows are outside this extension even when omlx can serve them. */
export function isGgufRow(row: OmlxStatusRow): boolean {
  return row.model_format === "gguf";
}

/**
 * `/model` lists loaded MLX chat rows only.
 *
 * Mirrors llama.cpp `--no-models-autoload`: unloaded rows stay hidden until
 * `/omlx` loads them. Loading, hidden, and GGUF rows are not selectable.
 */
export function isSelectableChatRow(row: OmlxStatusRow): boolean {
  return isChatRow(row) && row.loaded && !row.is_loading && !row.is_hidden && !isGgufRow(row);
}

/** Pi model id: the `/v1/models` alias when `model_alias` is set, else the pool id. */
export function displayIdOf(row: OmlxStatusRow): string {
  const alias = row.model_alias?.trim();
  return alias ? alias : row.id;
}

function positive(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Context window, first hit wins: `/v1/models` `max_model_len`, status
 * `model_context_length`, the cached window from the stored catalog, else 128000.
 */
export function contextWindowOf(
  row: OmlxStatusRow,
  maxModelLen: number | undefined,
  cached: number | undefined,
): number {
  return (
    positive(maxModelLen) ??
    positive(row.model_context_length) ??
    positive(cached) ??
    FALLBACK_CONTEXT_WINDOW
  );
}

function listedMaxModelLen(listed: readonly OmlxListedModel[], id: string): number | undefined {
  return positive(listed.find((model) => model.id === id)?.max_model_len);
}

/**
 * Thinking is offered only after a loaded row reports it.
 *
 * A boolean `thinking_default` counts even when it is false: false means the
 * template can think and the default is off. A non-empty `reasoning_efforts`
 * list counts the same way. Unloaded rows stay non-reasoning until a later
 * refresh sees them loaded.
 */
export function supportsThinking(row: OmlxStatusRow): boolean {
  if (!row.loaded) return false;
  if (typeof row.thinking_default === "boolean") return true;
  return (row.reasoning_efforts?.length ?? 0) > 0;
}

/** Map one status row to a Pi chat model. `displayId` is the id `/model` shows. */
export function toPiChatModel(
  row: OmlxStatusRow,
  displayId: string,
  serverUrl: string,
  maxModelLen: number | undefined,
  cached: number | undefined,
): Model<"openai-completions"> {
  const contextWindow = contextWindowOf(row, maxModelLen, cached);
  const reasoning = supportsThinking(row);
  return {
    id: displayId,
    name: displayId,
    api: "openai-completions",
    provider: OMLX_PROVIDER,
    baseUrl: omlxInferenceUrl(serverUrl),
    reasoning,
    ...(reasoning ? { thinkingLevelMap: THINKING_LEVEL_MAP } : {}),
    input: row.model_type === "vlm" ? ["text", "image"] : ["text"],
    cost: { ...ZERO_COST },
    contextWindow,
    maxTokens: contextWindow,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
      ...(reasoning ? { thinkingFormat: "qwen-chat-template" as const } : {}),
    },
  };
}

/**
 * Selectable chat models for one status payload.
 *
 * `cached` is keyed by the Pi model id (the alias when one is published).
 */
export function chatModelsFromStatus(
  rows: readonly OmlxStatusRow[],
  listed: readonly OmlxListedModel[],
  serverUrl: string,
  cached?: ReadonlyMap<string, number>,
): Model<"openai-completions">[] {
  return rows.filter(isSelectableChatRow).map((row) => {
    const displayId = displayIdOf(row);
    return toPiChatModel(
      row,
      displayId,
      serverUrl,
      listedMaxModelLen(listed, displayId),
      cached?.get(displayId),
    );
  });
}
