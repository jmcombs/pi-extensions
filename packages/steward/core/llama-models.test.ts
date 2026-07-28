/**
 * `parseModels` is validated against the captured real `/models` model object,
 * plus hand-authored unloaded and embedding records and a spread of garbage. The
 * real fixture is the backbone: it is what a live `llama-server` actually sends.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseModels } from "./llama-models.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/llama/${name}`, import.meta.url), "utf8"));
}

const LOADED = fixture("models-loaded.json");
const UNLOADED_PRESET = fixture("models-unloaded-preset.json");

describe("parseModels", () => {
  it("parses the real loaded model", () => {
    // The `/models` response wraps the array as `{ object, data }`.
    const models = parseModels({ object: "list", data: [LOADED] });
    expect(models).toHaveLength(1);
    const model = models[0];
    expect(model).toMatchObject({
      id: "Qwen3-0.6B-Q4_0",
      short: "Qwen3-0.6B",
      embedding: false,
      quant: "Q4_0",
      ctx: 40960,
      // The native training window comes straight off `meta.n_ctx_train`.
      nativeCtx: 40960,
      gpuLayers: null,
      detail: null,
      // Nothing tuning-related is pinned in this model's launch args, so both
      // fall to the server defaults; the source fills in `parallel` from /slots.
      parallel: null,
      flashAttn: "auto",
      kvCache: "f16/f16",
      status: "resident",
      tokensPerSecond: null,
    });
    expect(model?.sizeGB).toBeCloseTo(0.423, 3);
  });

  it("enriches an unloaded preset model from its launch args", () => {
    // A real capture: the router hands back the launch args for a preset model
    // even while it is unloaded, so quant, per-slot ctx and parallel are known
    // with no `meta` — but size and the native window are not.
    const [model] = parseModels([UNLOADED_PRESET]);
    expect(model).toMatchObject({
      id: "chat-qwen",
      // `--model …/Qwen3-0.6B-Q4_0.gguf` → the quant token before `.gguf`.
      quant: "Q4_0",
      // `--ctx-size 8192` split across `--parallel 4`, matching the loaded
      // per-slot figure.
      ctx: 2048,
      parallel: 4,
      gpuLayers: 99,
      flashAttn: "on",
      kvCache: "q8_0/q8_0",
      sizeGB: null,
      nativeCtx: null,
      status: "unloaded",
    });
  });

  it("accepts a bare array as well as the wrapped form", () => {
    expect(parseModels([LOADED])).toHaveLength(1);
  });

  it("leaves size and ctx null for an unloaded model with no meta", () => {
    const unloaded = {
      id: "Qwen3-4B-Q5_K_M",
      status: { value: "unloaded", args: [] },
      architecture: { output_modalities: ["text"] },
    };
    const [model] = parseModels([unloaded]);
    expect(model).toMatchObject({
      id: "Qwen3-4B-Q5_K_M",
      short: "Qwen3-4B",
      quant: "Q5_K_M",
      sizeGB: null,
      ctx: null,
      status: "unloaded",
    });
  });

  it("reads tuning and gpu layers from pinned launch args", () => {
    const pinned = {
      id: "big-model-Q4_K_M",
      status: {
        value: "loaded",
        args: [
          "--parallel",
          "8",
          "--flash-attn",
          "on",
          "--cache-type-k",
          "q8_0",
          "--cache-type-v",
          "q8_0",
          "--n-gpu-layers",
          "48",
        ],
      },
      architecture: { output_modalities: ["text"] },
      meta: { ftype: "Q4_K_M", size: 1_000_000_000, n_ctx: 8192 },
    };
    const [model] = parseModels([pinned]);
    expect(model).toMatchObject({
      flashAttn: "on",
      kvCache: "q8_0/q8_0",
      gpuLayers: 48,
      status: "resident",
    });
  });

  it("marks a model with no text output as an embedder", () => {
    const embed = {
      id: "nomic-embed-text-v1.5-F16",
      status: { value: "loaded", args: [] },
      architecture: { input_modalities: ["text"], output_modalities: ["embedding"] },
      meta: { ftype: "F16", size: 274_000_000, n_ctx: 8192 },
    };
    const [model] = parseModels([embed]);
    expect(model).toMatchObject({ embedding: true, detail: "embedding" });
  });

  it("maps loading and downloading statuses through", () => {
    const rows = parseModels([
      { id: "a", status: { value: "loading", args: [] } },
      { id: "b", status: { value: "downloading", args: [] } },
      { id: "c", status: { value: "sleeping", args: [] } },
    ]);
    expect(rows.map((r) => r.status)).toEqual(["loading", "downloading", "resident"]);
  });

  it("never throws on garbage, returning safe rows or nothing", () => {
    expect(parseModels(null)).toEqual([]);
    expect(parseModels([])).toEqual([]);
    expect(parseModels({})).toEqual([]);
    expect(parseModels("nope")).toEqual([]);
    // A row without an id is dropped; a row with a wrong-typed meta degrades.
    expect(parseModels([{ status: { value: "loaded" } }])).toEqual([]);
    const [model] = parseModels([{ id: "x", status: 7, meta: "no", architecture: 3 }]);
    expect(model).toMatchObject({ id: "x", sizeGB: null, ctx: null, status: "unloaded" });
  });
});
