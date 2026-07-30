/**
 * `parseSlots` is validated against the captured real `/slots` idle and busy
 * bodies; `parseTps` against a real-shaped Prometheus scrape. Both are the
 * backbone — what a live `llama-server` actually returns.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMetrics, parseSlots, parseTps } from "./llama-slots.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/llama/${name}`, import.meta.url), "utf8"));
}

const MODEL = "Qwen3-0.6B-Q4_0";

describe("parseSlots", () => {
  it("parses idle slots: no prompt, no decoded, idle state", () => {
    const slots = parseSlots(fixture("slots-idle.json"), MODEL);
    expect(slots).toHaveLength(4);
    expect(slots[0]).toEqual({
      id: 0,
      modelId: MODEL,
      // A real idle slot body carries neither `n_prompt_tokens` nor
      // `next_token`, so both are unknown. The old parser printed `0 / 40k ctx ·
      // 0 decoded` for exactly this body — two figures the server never stated.
      promptTokens: null,
      ctxTotal: 40960,
      decoded: null,
      state: "idle",
    });
    expect(slots.every((slot) => slot.modelId === MODEL)).toBe(true);
  });

  it("parses busy slots: prompt, decoded, processing state", () => {
    const slots = parseSlots(fixture("slots-busy.json"), MODEL);
    expect(slots).toHaveLength(4);
    expect(slots[0]).toEqual({
      id: 0,
      modelId: MODEL,
      promptTokens: 27,
      ctxTotal: 40960,
      decoded: 5,
      state: "processing",
    });
  });

  it("reports an absent next_token as an unknown decoded count, never zero", () => {
    const slots = parseSlots(
      [{ id: 0, n_ctx: 4096, n_prompt_tokens: 12, is_processing: true }],
      MODEL,
    );
    expect(slots[0]?.decoded).toBeNull();
  });

  it("reports a slot with no is_processing flag as unknown, not idle", () => {
    // A body we do not recognise is not a server at rest. Defaulting to `idle`
    // here would put a confident, wrong reading on the panel.
    const slots = parseSlots([{ id: 0, n_ctx: 4096 }], MODEL);
    expect(slots[0]?.state).toBe("unknown");
  });

  it("falls back to the array index when a slot has no id", () => {
    const slots = parseSlots([{ n_ctx: 4096, is_processing: false }], MODEL);
    expect(slots[0]?.id).toBe(0);
  });

  it("returns [] for a non-array body, never throwing", () => {
    expect(parseSlots(null, MODEL)).toEqual([]);
    expect(parseSlots({ error: "bare /slots is 400" }, MODEL)).toEqual([]);
    expect(parseSlots([], MODEL)).toEqual([]);
  });
});

describe("parseTps", () => {
  const metrics = [
    "# HELP llamacpp:prompt_tokens_total Number of prompt tokens processed.",
    "# TYPE llamacpp:prompt_tokens_total counter",
    "llamacpp:prompt_tokens_total 512",
    "# HELP llamacpp:predicted_tokens_seconds Predicted tokens throughput.",
    "# TYPE llamacpp:predicted_tokens_seconds gauge",
    "llamacpp:predicted_tokens_seconds 63.42",
    "",
  ].join("\n");

  it("reads the predicted-tokens-per-second gauge", () => {
    expect(parseTps(metrics)).toBeCloseTo(63.42, 2);
  });

  it("returns null when the line is missing", () => {
    expect(parseTps("llamacpp:prompt_tokens_total 512\n")).toBeNull();
    expect(parseTps("")).toBeNull();
  });

  it("returns null when the value is not finite (nan before first generation)", () => {
    expect(parseTps("llamacpp:predicted_tokens_seconds nan\n")).toBeNull();
  });
});

describe("parseMetrics", () => {
  it("reads the rate and the request gauges together", () => {
    const text = [
      "llamacpp:predicted_tokens_seconds 128.5",
      "llamacpp:requests_processing 1",
      "llamacpp:requests_deferred 4",
      "",
    ].join("\n");
    expect(parseMetrics(text)).toEqual({ tps: 128.5, requestsProcessing: 1, requestsDeferred: 4 });
  });

  it("treats absent request gauges as zero, but an absent rate as unknown", () => {
    // Requests are counts (absent means none); the rate is null (no reading)
    // when the line is missing, distinct from a real 0.
    expect(parseMetrics("llamacpp:predicted_tokens_seconds 40\n")).toEqual({
      tps: 40,
      requestsProcessing: 0,
      requestsDeferred: 0,
    });
    expect(parseMetrics("")).toEqual({ tps: null, requestsProcessing: 0, requestsDeferred: 0 });
  });
});
