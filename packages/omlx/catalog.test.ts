import { readFileSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  chatModelsFromStatus,
  contextWindowOf,
  displayIdOf,
  isChatRow,
  isDecisionRow,
  isGgufRow,
  isSelectableChatRow,
  supportsThinking,
  toPiChatModel,
} from "./catalog.js";
import { type OmlxListedModel, type OmlxStatusRow, parseModelStatus } from "./client.js";
import { createOmlxProvider } from "./provider.js";

const SERVER_URL = "http://127.0.0.1:8000";

/** Physical ids from the captured omlx server. Load and unload still use these. */
const LOADED_LLM = "Qwen2.5-0.5B-Instruct-4bit";
const LOADED_LLM_ALIAS = "qwen2.5-0.5b";
const UNLOADED_LLM = "SmolLM-135M-Instruct-4bit";
const LOADED_EMBEDDING = "Qwen3-Embedding-0.6B-4bit-DWQ";
const LOADED_DECISION = "clef-flash-4bit";
const GGUF = "SmolLM2-135M-Instruct-Q4_K_M";
const LOADED_VLM = "Qwen3.8-27B-oQ8e-mtp";
const UNLOADED_VLM = "Qwen3.8-27B-oQ6e-mtp";

const COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  supportsStrictMode: false,
  maxTokensField: "max_tokens",
} as const;

const THINKING_LEVEL_MAP = {
  off: "off",
  minimal: null,
  low: null,
  medium: "medium",
  high: null,
  xhigh: null,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

function listedModels(payload: unknown): readonly OmlxListedModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("fixtures/models.json is not a model list");
  }
  return payload.data.map((row) => {
    if (!isRecord(row) || typeof row.id !== "string") {
      throw new Error("fixtures/models.json has a row without a string id");
    }
    const maxModelLen = row.max_model_len;
    return {
      id: row.id,
      ...(typeof maxModelLen === "number" || maxModelLen === null
        ? { max_model_len: maxModelLen }
        : {}),
    };
  });
}

const status = parseModelStatus(readFixture("status.json"));
const listed = listedModels(readFixture("models.json"));
const chatModels = chatModelsFromStatus(status.models, listed, SERVER_URL);

function row(id: string): OmlxStatusRow {
  const found = status.models.find((item) => item.id === id);
  if (!found) throw new Error(`fixture status is missing ${id}`);
  return found;
}

function chat(id: string): Model<"openai-completions"> {
  const found = chatModels.find((model) => model.id === id);
  if (!found) throw new Error(`chat catalog is missing ${id}`);
  return found;
}

/**
 * Inline row, not a capture. `model_context_length: null` is how the client
 * represents a null or absent status length. Do not copy this into the fixtures.
 */
function nullLengthRow(): OmlxStatusRow {
  return {
    id: "inline-cache-probe",
    loaded: true,
    is_loading: false,
    model_type: "llm",
    engine_type: "batched",
    model_format: null,
    model_context_length: null,
    thinking_default: null,
    reasoning_efforts: null,
    is_hidden: false,
    model_alias: null,
    estimated_size: null,
    loading_started_at: null,
  };
}

/**
 * Loaded MLX `llm` row. Callers override one field. Not a capture: the fixture's
 * only GGUF row is also unloaded and hidden, and no captured row is loading.
 */
function loadedLlmRow(
  overrides: Partial<OmlxStatusRow> & Pick<OmlxStatusRow, "id">,
): OmlxStatusRow {
  return {
    loaded: true,
    is_loading: false,
    model_type: "llm",
    engine_type: "batched",
    model_format: null,
    model_context_length: 4096,
    thinking_default: null,
    reasoning_efforts: null,
    is_hidden: false,
    model_alias: null,
    estimated_size: null,
    loading_started_at: null,
    ...overrides,
  };
}

describe("omlx status fixture", () => {
  it("parses the captured status and rejects a bad shape", () => {
    expect(status.models.map((item) => item.id)).toEqual([
      LOADED_LLM,
      LOADED_EMBEDDING,
      UNLOADED_VLM,
      LOADED_VLM,
      "Qwen3.8-Flash-Next-oQ6e-mtp",
      UNLOADED_LLM,
      GGUF,
      LOADED_DECISION,
    ]);
    expect(status.load_time_observations).toBeTypeOf("number");
    expect(() => parseModelStatus({ models: [{ id: "x" }] })).toThrow(
      "omlx returned an invalid model status",
    );
    expect(() => parseModelStatus(null)).toThrow("omlx returned an invalid model status");
  });

  it("contains the catalog cases the filter has to tell apart", () => {
    expect(row(LOADED_LLM)).toMatchObject({
      loaded: true,
      model_type: "llm",
      model_alias: LOADED_LLM_ALIAS,
      is_hidden: false,
    });
    expect(row(UNLOADED_LLM)).toMatchObject({ loaded: false, model_type: "llm" });
    expect(row(LOADED_EMBEDDING)).toMatchObject({ loaded: true, model_type: "embedding" });
    expect(row(LOADED_DECISION)).toMatchObject({ loaded: true, model_type: "decision" });
    expect(row(GGUF)).toMatchObject({ model_format: "gguf", is_hidden: true, model_type: "llm" });
    expect(row(LOADED_VLM)).toMatchObject({
      loaded: true,
      model_type: "vlm",
      is_hidden: false,
      model_alias: null,
      thinking_default: true,
      reasoning_efforts: ["low", "medium", "xhigh"],
    });
    const listedIds = listed.map((model) => model.id);
    expect(listedIds).toContain(LOADED_LLM_ALIAS);
    expect(listedIds).not.toContain(LOADED_LLM);
    expect(listedIds).not.toContain(GGUF);
  });
});

describe("chat row selection", () => {
  it("classifies chat, decision, and GGUF rows", () => {
    expect(isChatRow(row(LOADED_LLM))).toBe(true);
    expect(isChatRow(row(LOADED_VLM))).toBe(true);
    expect(isChatRow(row(LOADED_DECISION))).toBe(false);
    expect(isChatRow(row(LOADED_EMBEDDING))).toBe(false);
    expect(isDecisionRow(row(LOADED_DECISION))).toBe(true);
    expect(isDecisionRow(row(LOADED_LLM))).toBe(false);
    expect(isGgufRow(row(GGUF))).toBe(true);
    expect(isGgufRow(row(LOADED_LLM))).toBe(false);
  });

  it("selects only loaded, non-hidden, non-GGUF llm and vlm rows", () => {
    const selectable = status.models.filter(isSelectableChatRow).map((item) => item.id);
    expect(selectable).toEqual([LOADED_LLM, LOADED_VLM]);
    expect(isSelectableChatRow(row(UNLOADED_LLM))).toBe(false);
    expect(isSelectableChatRow(row(UNLOADED_VLM))).toBe(false);
    expect(isSelectableChatRow(row(GGUF))).toBe(false);
    expect(isSelectableChatRow(row(LOADED_DECISION))).toBe(false);
    expect(isSelectableChatRow(row(LOADED_EMBEDDING))).toBe(false);

    // Each exclusion is loaded, so `loaded` cannot hide it. The capture has no such row.
    const gguf = loadedLlmRow({ id: "inline-gguf", model_format: "gguf" });
    const hidden = loadedLlmRow({ id: "inline-hidden", is_hidden: true });
    const loading = loadedLlmRow({ id: "inline-loading", is_loading: true });
    const kept = loadedLlmRow({ id: "inline-kept" });
    expect(isSelectableChatRow(gguf)).toBe(false);
    expect(isSelectableChatRow(hidden)).toBe(false);
    expect(isSelectableChatRow(loading)).toBe(false);
    expect(isSelectableChatRow(kept)).toBe(true);
    expect(
      chatModelsFromStatus([gguf, hidden, loading, kept], [], SERVER_URL).map((model) => model.id),
    ).toEqual(["inline-kept"]);
  });

  it("publishes the alias as the model id and drops excluded rows", () => {
    expect(displayIdOf(row(LOADED_LLM))).toBe(LOADED_LLM_ALIAS);
    expect(displayIdOf(row(LOADED_VLM))).toBe(LOADED_VLM);
    expect(chatModels.map((model) => model.id)).toEqual([LOADED_LLM_ALIAS, LOADED_VLM]);
    expect(chatModels.some((model) => model.id === LOADED_LLM)).toBe(false);
    expect(chatModels.some((model) => model.id === GGUF)).toBe(false);
    expect(chatModels.some((model) => model.id === LOADED_DECISION)).toBe(false);
    expect(chatModels.some((model) => model.id === LOADED_EMBEDDING)).toBe(false);
    expect(chatModels.some((model) => model.id === UNLOADED_LLM)).toBe(false);
    expect(chatModels.some((model) => model.id === UNLOADED_VLM)).toBe(false);
  });
});

describe("chat model mapping", () => {
  it("gives vlm image input and every other chat model text only", () => {
    expect(chat(LOADED_VLM).input).toEqual(["text", "image"]);
    expect(chat(LOADED_LLM_ALIAS).input).toEqual(["text"]);
  });

  it("prefers max_model_len, then native length", () => {
    // Captured rows all have a positive model_context_length. The 128000 fallback
    // and the cached window are proven on inline rows, not on the fixture.
    const vlm = row(LOADED_VLM);
    expect(vlm.model_context_length).toBe(262144);
    expect(chat(LOADED_VLM).contextWindow).toBe(131072);
    expect(chat(LOADED_LLM_ALIAS).contextWindow).toBe(32768);
    expect(contextWindowOf(vlm, 131072, 55555)).toBe(131072);
    expect(contextWindowOf(vlm, undefined, 55555)).toBe(262144);

    const aliased = chatModelsFromStatus(
      status.models,
      listed.map((model) =>
        model.id === LOADED_LLM_ALIAS ? { ...model, max_model_len: 1111 } : model,
      ),
      SERVER_URL,
    ).find((model) => model.id === LOADED_LLM_ALIAS);
    expect(aliased?.contextWindow).toBe(1111);
  });

  it("uses the cached window when status length is null", () => {
    const probe = nullLengthRow();
    expect(probe.model_context_length).toBeNull();
    // Earlier steps still win. Removing them would let 424242 through.
    expect(contextWindowOf(probe, 131072, 424242)).toBe(131072);
    expect(contextWindowOf({ ...probe, model_context_length: 8192 }, undefined, 424242)).toBe(8192);
    // Fails if the cached step is removed: the only remaining value is 128000.
    expect(contextWindowOf(probe, undefined, 424242)).toBe(424242);
    expect(contextWindowOf(nullLengthRow(), undefined, undefined)).toBe(128000);

    const aliased: OmlxStatusRow = {
      ...probe,
      id: "inline-physical",
      model_alias: "inline-published",
    };
    const published = chatModelsFromStatus(
      [aliased],
      [{ id: "inline-published" }],
      SERVER_URL,
      new Map([["inline-published", 424242]]),
    );
    expect(published).toMatchObject([
      { id: "inline-published", contextWindow: 424242, maxTokens: 424242 },
    ]);
  });

  it("sets maxTokens to the context window and zero cost", () => {
    for (const model of chatModels) {
      expect(model.maxTokens).toBe(model.contextWindow);
      expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(model.provider).toBe("omlx");
      expect(model.api).toBe("openai-completions");
      expect(model.baseUrl).toBe("http://127.0.0.1:8000/v1");
      expect(model.name).toBe(model.id);
    }
  });

  it("adds the llama thinking map only on qualifying loaded rows", () => {
    const thinking = chat(LOADED_VLM);
    expect(thinking.reasoning).toBe(true);
    expect(thinking.thinkingLevelMap).toEqual(THINKING_LEVEL_MAP);
    expect(thinking.compat).toEqual({ ...COMPAT, thinkingFormat: "qwen-chat-template" });

    const plain = chat(LOADED_LLM_ALIAS);
    expect(plain.reasoning).toBe(false);
    expect(plain.thinkingLevelMap).toBeUndefined();
    expect(plain.compat).toEqual(COMPAT);

    const unloaded = row(UNLOADED_VLM);
    expect(unloaded.thinking_default).toBe(true);
    expect(unloaded.reasoning_efforts).toEqual(["low", "medium", "xhigh"]);
    expect(supportsThinking(unloaded)).toBe(false);
    expect(toPiChatModel(unloaded, unloaded.id, SERVER_URL, undefined, undefined).reasoning).toBe(
      false,
    );
    expect(supportsThinking(row(LOADED_LLM))).toBe(false);
    expect(supportsThinking(row(GGUF))).toBe(false);

    // Captured thinking rows also have thinking_default: true, so efforts never decide.
    const effortsOnly = loadedLlmRow({
      id: "inline-efforts",
      thinking_default: null,
      reasoning_efforts: ["medium"],
    });
    expect(supportsThinking(effortsOnly)).toBe(true);
    const mapped = toPiChatModel(effortsOnly, effortsOnly.id, SERVER_URL, undefined, undefined);
    expect(mapped.reasoning).toBe(true);
    expect(mapped.thinkingLevelMap).toEqual(THINKING_LEVEL_MAP);
    expect(mapped.compat).toEqual({ ...COMPAT, thinkingFormat: "qwen-chat-template" });
    expect(chatModelsFromStatus([effortsOnly], [], SERVER_URL)).toMatchObject([
      {
        id: "inline-efforts",
        reasoning: true,
        thinkingLevelMap: THINKING_LEVEL_MAP,
        compat: { ...COMPAT, thinkingFormat: "qwen-chat-template" },
      },
    ]);
  });
});

describe("setCatalog", () => {
  it("publishes the fixture chat models without a network call", () => {
    const { provider, setCatalog } = createOmlxProvider();
    setCatalog(status, listed, SERVER_URL);
    expect(provider.getModels()).toEqual(chatModels);
    expect(provider.getAllModels?.()).toEqual(chatModels);
  });
});
