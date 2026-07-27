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

/** The metric that carries the generation rate in a `/metrics` scrape. */
const TPS_PATTERN = /^llamacpp:predicted_tokens_seconds\s+([0-9eE+.-]+)/m;

/**
 * The generation rate from a Prometheus `/metrics` scrape, or `null` when the
 * line is absent or its value is not a finite number (llama.cpp prints `nan`
 * before the first generation).
 */
export function parseTps(prometheusText: string): number | null {
  const match = TPS_PATTERN.exec(prometheusText);
  if (match?.[1] === undefined) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}
