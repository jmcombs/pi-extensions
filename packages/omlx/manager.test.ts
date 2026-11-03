/**
 * Pure `/omlx` list building over the captured status fixture.
 *
 * No server and no TUI. Descriptions use the row 23 context chain.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type OmlxListedModel, type OmlxStatusRow, parseModelStatus } from "./client.js";
import { buildManagerItems } from "./ui.js";

const LOADED_LLM = "Qwen2.5-0.5B-Instruct-4bit";
const LOADED_VLM = "Qwen3.8-27B-oQ8e-mtp";
const LOADED_DECISION = "clef-flash-4bit";
const UNLOADED_VLM = "Qwen3.8-27B-oQ6e-mtp";
const UNLOADED_LARGE_VLM = "Qwen3.8-Flash-Next-oQ6e-mtp";
const UNLOADED_LLM = "SmolLM-135M-Instruct-4bit";
const EMBEDDING = "Qwen3-Embedding-0.6B-4bit-DWQ";
const GGUF = "SmolLM2-135M-Instruct-Q4_K_M";

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

describe("omlx manager list", () => {
  it("lists physical non-GGUF llm, vlm, and decision rows, loaded first", () => {
    const items = buildManagerItems(status);
    const ids = items.slice(0, -1).map((item) => item.label);
    const byId = (left: string, right: string): number => left.localeCompare(right);
    expect(ids).toEqual([
      ...[LOADED_LLM, LOADED_VLM, LOADED_DECISION].sort(byId),
      ...[UNLOADED_VLM, UNLOADED_LARGE_VLM, UNLOADED_LLM].sort(byId),
    ]);
    expect(ids).not.toContain(GGUF);
    expect(ids).not.toContain(EMBEDDING);
    expect(ids).not.toContain("qwen2.5-0.5b");
  });

  it("describes loaded rows with context, loading rows as loading, and unloaded rows as empty", () => {
    const items = buildManagerItems(status);
    const description = (id: string): string | undefined =>
      items.find((item) => item.label === id)?.description;
    // llama's label rounds context / 1000. 32768 is 33k, 262144 is 262k.
    expect(description(LOADED_LLM)).toBe("loaded · 33k context");
    expect(description(LOADED_VLM)).toBe("loaded · 262k context");
    expect(description(LOADED_DECISION)).toBe("loaded · 262k context");
    expect(description(UNLOADED_LLM)).toBe("");
    expect(description(UNLOADED_VLM)).toBe("");

    const loading = structuredClone(status);
    const row = loading.models.find((item) => item.id === UNLOADED_LLM);
    if (!row) throw new Error("fixture is missing the unloaded llm");
    const loadingRow: OmlxStatusRow = { ...row, is_loading: true };
    const withLoading = {
      ...loading,
      models: loading.models.map((item) => (item.id === UNLOADED_LLM ? loadingRow : item)),
    };
    expect(
      buildManagerItems(withLoading).find((item) => item.label === UNLOADED_LLM)?.description,
    ).toBe("loading");
  });

  it("ends with the MLX-only download row", () => {
    const items = buildManagerItems(status);
    expect(items.at(-1)).toMatchObject({
      label: "Download model…",
      description: "Hugging Face owner/repository (MLX only)",
    });
  });

  it("prefers /v1/models max_model_len over the status context length", () => {
    const items = buildManagerItems(status, listed);
    // The loaded VLM's status length is 262144; its max_model_len is 131072.
    expect(items.find((item) => item.label === LOADED_VLM)?.description).toBe(
      "loaded · 131k context",
    );
  });
});
