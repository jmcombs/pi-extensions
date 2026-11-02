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

describe("omlx status fixture", () => {
  it("parses the captured status and rejects a bad shape", () => {
    expect(status.models.length).toBeGreaterThanOrEqual(9);
    expect(status.load_time_observations).toBeTypeOf("number");
    expect(() => parseModelStatus({ models: [{ id: "x" }] })).toThrow(
      "omlx returned an invalid model status",
    );
    expect(() => parseModelStatus(null)).toThrow("omlx returned an invalid model status");
  });

  it("contains the catalog cases the filter has to tell apart", () => {
    expect(row("Qwen3.8-27B-oQ8e-mtp")).toMatchObject({
      loaded: true,
      model_type: "vlm",
      is_hidden: false,
    });
    expect(row("fixture-loaded-llm").model_type).toBe("llm");
    expect(row("fixture-unloaded-llm").loaded).toBe(false);
    expect(row("fixture-decision").model_type).toBe("decision");
    expect(row("fixture-embedding").model_type).toBe("embedding");
    expect(row("fixture-gguf").model_format).toBe("gguf");
    expect(row("fixture-hidden").is_hidden).toBe(true);
    expect(row("fixture-aliased-physical").model_alias).toBe("fixture-alias");
    expect(row("fixture-thinking").reasoning_efforts).toEqual(["low", "medium"]);
  });
});

describe("chat row selection", () => {
  it("classifies chat, decision, and GGUF rows", () => {
    expect(isChatRow(row("fixture-loaded-llm"))).toBe(true);
    expect(isChatRow(row("Qwen3.8-27B-oQ8e-mtp"))).toBe(true);
    expect(isChatRow(row("fixture-decision"))).toBe(false);
    expect(isChatRow(row("fixture-embedding"))).toBe(false);
    expect(isDecisionRow(row("fixture-decision"))).toBe(true);
    expect(isDecisionRow(row("fixture-loaded-llm"))).toBe(false);
    expect(isGgufRow(row("fixture-gguf"))).toBe(true);
    expect(isGgufRow(row("fixture-loaded-llm"))).toBe(false);
  });

  it("selects only loaded, non-hidden, non-GGUF llm and vlm rows", () => {
    const selectable = status.models.filter(isSelectableChatRow).map((item) => item.id);
    expect(selectable).toEqual([
      "Qwen3.8-27B-oQ8e-mtp",
      "fixture-loaded-llm",
      "fixture-aliased-physical",
      "fixture-thinking",
      "fixture-efforts-only",
      "fixture-thinking-disabled",
    ]);
    expect(isSelectableChatRow(row("fixture-unloaded-llm"))).toBe(false);
    expect(isSelectableChatRow(row("fixture-loading-llm"))).toBe(false);
    expect(isSelectableChatRow(row("Qwen3.8-27B-oQ6e-mtp"))).toBe(false);
  });

  it("publishes the alias as the model id and drops excluded rows", () => {
    expect(displayIdOf(row("fixture-aliased-physical"))).toBe("fixture-alias");
    expect(chatModels.map((model) => model.id)).toEqual([
      "Qwen3.8-27B-oQ8e-mtp",
      "fixture-loaded-llm",
      "fixture-alias",
      "fixture-thinking",
      "fixture-efforts-only",
      "fixture-thinking-disabled",
    ]);
    expect(chatModels.some((model) => model.id === "fixture-aliased-physical")).toBe(false);
    expect(chatModels.some((model) => model.id === "fixture-gguf")).toBe(false);
    expect(chatModels.some((model) => model.id === "fixture-hidden")).toBe(false);
    expect(chatModels.some((model) => model.id === "fixture-decision")).toBe(false);
    expect(chatModels.some((model) => model.id === "fixture-embedding")).toBe(false);
  });
});

describe("chat model mapping", () => {
  it("gives vlm image input and every other chat model text only", () => {
    expect(chat("Qwen3.8-27B-oQ8e-mtp").input).toEqual(["text", "image"]);
    for (const model of chatModels) {
      if (model.id === "Qwen3.8-27B-oQ8e-mtp") continue;
      expect(model.input).toEqual(["text"]);
    }
  });

  it("uses max_model_len, then native length, then 128000", () => {
    expect(chat("Qwen3.8-27B-oQ8e-mtp").contextWindow).toBe(131072);
    expect(chat("fixture-loaded-llm").contextWindow).toBe(8192);
    expect(chat("fixture-alias").contextWindow).toBe(16384);
    expect(chat("fixture-efforts-only").contextWindow).toBe(32768);
    expect(chat("fixture-thinking").contextWindow).toBe(128000);
    expect(chat("fixture-thinking-disabled").contextWindow).toBe(128000);

    const fallback = row("fixture-thinking");
    expect(contextWindowOf(fallback, undefined, undefined)).toBe(128000);
    expect(contextWindowOf(fallback, undefined, 55555)).toBe(55555);
    expect(contextWindowOf(fallback, 8192, 55555)).toBe(8192);
    expect(contextWindowOf(row("fixture-efforts-only"), undefined, 55555)).toBe(32768);
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
    for (const id of [
      "Qwen3.8-27B-oQ8e-mtp",
      "fixture-thinking",
      "fixture-efforts-only",
      "fixture-thinking-disabled",
    ]) {
      const model = chat(id);
      expect(model.reasoning).toBe(true);
      expect(model.thinkingLevelMap).toEqual(THINKING_LEVEL_MAP);
      expect(model.compat).toEqual({ ...COMPAT, thinkingFormat: "qwen-chat-template" });
    }
    for (const id of ["fixture-loaded-llm", "fixture-alias"]) {
      const model = chat(id);
      expect(model.reasoning).toBe(false);
      expect(model.thinkingLevelMap).toBeUndefined();
      expect(model.compat).toEqual(COMPAT);
    }
    const unloaded = row("fixture-unloaded-llm");
    expect(supportsThinking(unloaded)).toBe(false);
    expect(toPiChatModel(unloaded, unloaded.id, SERVER_URL, undefined, undefined).reasoning).toBe(
      false,
    );
    expect(supportsThinking(row("fixture-thinking-disabled"))).toBe(true);
    expect(supportsThinking(row("fixture-gguf"))).toBe(true);
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
