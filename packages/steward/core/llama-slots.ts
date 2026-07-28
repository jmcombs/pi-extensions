/**
 * Turns a `llama-server` `/slots` body into {@link SlotInfo} rows, and a
 * `/metrics` body into a generation rate.
 *
 * Both arrive as `unknown` (or raw Prometheus text) off the wire, so each field
 * is narrowed before it is read. The model id is not in the slot body — we know
 * it because we asked `/slots?model=<id>` — so it is passed in and stamped onto
 * every row. Keep this module free of Node and DOM APIs — see `./types.ts`.
 */

import type { SlotInfo } from "./types.js";

/** True for a non-null object we can read string-keyed fields off. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A finite number, or `null` when absent/wrong-typed/not finite. */
function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Tokens generated so far, from `next_token[0].n_decoded`; 0 when idle/absent. */
function readDecoded(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  const first = value[0];
  if (!isRecord(first)) return 0;
  return readNumber(first.n_decoded) ?? 0;
}

/**
 * The slots for `modelId`. `raw` that is not an array (a 400 on a bare `/slots`,
 * a stray object) yields `[]`; a slot missing its id falls back to its position.
 */
export function parseSlots(raw: unknown, modelId: string): SlotInfo[] {
  if (!Array.isArray(raw)) return [];
  const slots: SlotInfo[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    slots.push({
      id: readNumber(entry.id) ?? index,
      modelId,
      promptTokens: readNumber(entry.n_prompt_tokens) ?? 0,
      ctxTotal: readNumber(entry.n_ctx) ?? 0,
      decoded: readDecoded(entry.next_token),
      state: entry.is_processing === true ? "processing" : "idle",
    });
  });
  return slots;
}

/** The `/metrics` values Steward reads, aggregated across a model's instance. */
export interface LlamaMetrics {
  /** Generation rate (`predicted_tokens_seconds`), null when absent or `nan`. */
  tps: number | null;
  /** Requests being processed (`requests_processing`), 0 when absent. */
  requestsProcessing: number;
  /** Requests deferred for a free slot (`requests_deferred`), 0 when absent. */
  requestsDeferred: number;
}

/**
 * Reads one `llamacpp:<name>` gauge from a Prometheus scrape, or `null` when the
 * line is absent or its value is not finite (llama.cpp prints `nan` before the
 * first generation).
 */
function readGauge(prometheusText: string, name: string): number | null {
  const match = new RegExp(`^llamacpp:${name}\\s+([0-9eE+.-]+)`, "m").exec(prometheusText);
  if (match?.[1] === undefined) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** The generation rate, or `null` when absent or not yet a finite number. */
export function parseTps(prometheusText: string): number | null {
  return readGauge(prometheusText, "predicted_tokens_seconds");
}

/**
 * The rate and request gauges from a `/metrics` scrape. The request gauges are
 * counts, so an absent line means zero; the rate is `null` (unknown) when
 * absent, since 0 t/s and "no reading" are different states.
 */
export function parseMetrics(prometheusText: string): LlamaMetrics {
  return {
    tps: readGauge(prometheusText, "predicted_tokens_seconds"),
    requestsProcessing: readGauge(prometheusText, "requests_processing") ?? 0,
    requestsDeferred: readGauge(prometheusText, "requests_deferred") ?? 0,
  };
}
