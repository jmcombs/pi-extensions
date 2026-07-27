import { describe, expect, it } from "vitest";
import { modelColor } from "./model-color.js";

describe("modelColor", () => {
  it("is stable for a given id across calls", () => {
    const id = "qwen3.6-moe-a3b-instruct-q4_k_m";
    expect(modelColor(id, false)).toBe(modelColor(id, false));
  });

  it("gives every embedding model the reserved hue", () => {
    expect(modelColor("nomic-embed-text-v1.5-f16", true)).toBe("var(--latte-blue)");
    expect(modelColor("some-other-embedder", true)).toBe("var(--latte-blue)");
  });

  it("returns a palette custom-property reference for non-embedders", () => {
    expect(modelColor("Qwen3-0.6B-Q4_0", false)).toMatch(/^var\(--latte-[a-z]+\)$/);
  });

  it("never lands a non-embedder on the reserved embed hue", () => {
    const ids = Array.from({ length: 200 }, (_v, i) => `model-${i}`);
    expect(ids.every((id) => modelColor(id, false) !== "var(--latte-blue)")).toBe(true);
  });

  it("usually distinguishes two different ids", () => {
    // An 8-colour palette collides sometimes; these two land apart.
    expect(modelColor("alpha", false)).not.toBe(modelColor("beta", false));
  });

  it("depends only on id and embedding, not on any load state", () => {
    // The color must not change when a model loads or unloads; the inputs are
    // exactly (id, embedding), so two calls with the same pair must agree.
    const id = "qwen3.6-moe-coder-fim-q4_k_m";
    const first = modelColor(id, false);
    const second = modelColor(id, false);
    expect(second).toBe(first);
  });
});
