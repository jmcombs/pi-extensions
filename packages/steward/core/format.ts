/**
 * Presentation formatters.
 *
 * Everything the dashboard renders as text passes through here, so the strings
 * live in one place and can be asserted on without a DOM. Keep this module free
 * of Node and DOM APIs — see `./types.ts`.
 */

import type { ModelInfo } from "./types.js";

/** Lowest temperature the gauges plot. Below this the bar reads empty. */
export const TEMP_SCALE_MIN_C = 30;

/** Highest temperature the gauges plot. At or above this the bar reads full. */
export const TEMP_SCALE_MAX_C = 95;

/** Above this a temperature is amber. */
export const TEMP_WARNING_C = 75;

/** Above this a temperature is red. */
export const TEMP_ERROR_C = 85;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Uptime as `3h 34m`. Minutes are zero-padded so the value does not change
 * width every ten minutes and jitter the rail.
 */
export function formatUptime(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor((Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${pad(minutes, 2)}m`;
}

/**
 * Log timestamp as `HH:MM:SS.mmm` in the operator's local time — the same shape
 * `llama-server` prints, so lines copied out of the console still line up with
 * the raw log.
 */
export function formatClock(timestampMs: number): string {
  const d = new Date(timestampMs);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(
    d.getMilliseconds(),
    3,
  )}`;
}

/**
 * The same clock without milliseconds, for prose that names a moment rather
 * than identifying a line — `nothing new since 14:19:02`. The millisecond field
 * is what makes two adjacent lines distinguishable; in a sentence it is noise.
 */
export function formatClockSeconds(timestampMs: number): string {
  const d = new Date(timestampMs);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`;
}

/**
 * A line count with thousands separators — `1,203`. Log counts run into the
 * thousands within minutes, and an unseparated `1203` beside a `209` is a
 * comparison the operator has to make character by character.
 */
export function formatCount(value: number): string {
  const whole = Number.isFinite(value) ? Math.trunc(value) : 0;
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `1 line` / `240 lines`, grouped. The singular is worth the branch. */
export function formatLines(value: number): string {
  return `${formatCount(value)} ${value === 1 ? "line" : "lines"}`;
}

/** A 0–1 fraction as a whole-percent label, e.g. `78%`. */
export function formatPercent(fraction: number): string {
  return `${Math.round(Number.isFinite(fraction) ? fraction * 100 : 0)}%`;
}

/** A 0–1 fraction as a bar width in percent, clamped so overshoot cannot bleed. */
export function barPercent(fraction: number): number {
  return Math.round(clamp01(fraction) * 100);
}

/** Memory gauges read `29.8 / 48 GB`; VRAM wants a decimal, RAM does not. */
export function formatMemory(usedGB: number, totalGB: number, decimals: number): string {
  return `${usedGB.toFixed(decimals)} / ${totalGB} GB`;
}

/** Temperature label, e.g. `64°C`. */
export function formatTemperature(celsius: number): string {
  return `${Math.round(celsius)}°C`;
}

/** Threshold color for a temperature gauge. */
export function temperatureColor(celsius: number): string {
  if (celsius > TEMP_ERROR_C) return "var(--error)";
  if (celsius > TEMP_WARNING_C) return "var(--warning)";
  return "var(--success)";
}

/**
 * Temperatures never sit near zero, so the bar plots the 30–95 °C band rather
 * than 0–100: at 0–100 every reading would hug the middle and say nothing.
 */
export function temperatureBarPercent(celsius: number): number {
  return barPercent((celsius - TEMP_SCALE_MIN_C) / (TEMP_SCALE_MAX_C - TEMP_SCALE_MIN_C));
}

/**
 * A size in GB with up to two decimals, trailing zeros trimmed: `18.4`, `0.42`,
 * `0.5`. Two places keep sub-gigabyte models legible (`0.42`, not `0.4`) without
 * making large ones noisy (`18.4`, not `18.40`).
 */
export function formatSizeGB(sizeGB: number): string {
  return String(Number(sizeGB.toFixed(2)));
}

/**
 * A token count for a tight label, keyed off binary thousands so that power-of-
 * two context windows read as clean round values: `40960` → `40k`, `65536` →
 * `64k`. Counts below 1024 print whole; larger ones show one decimal, trimmed
 * when it is zero. A value that is not a number reads as `0`.
 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1024) return String(Math.round(value));
  const thousands = Math.round((value / 1024) * 10) / 10;
  return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
}

/** A generation-rate label, e.g. `63 t/s`, or an em dash when there is none. */
export function formatTps(tokensPerSecond: number | null): string {
  return tokensPerSecond !== null && Number.isFinite(tokensPerSecond)
    ? `${Math.round(tokensPerSecond)} t/s`
    : "—";
}

/** Above this share of a slot's context the headroom reading turns amber. */
export const CONTEXT_WARNING_PCT = 85;

/** At or above this share the reading turns red — a lane about to overflow. */
export const CONTEXT_ERROR_PCT = 98;

/**
 * Threshold color for a context-headroom reading (0–100). The number is always
 * printed alongside it, so the color is a second cue, never the only one.
 */
export function contextHeadroomColor(percent: number): string {
  if (percent >= CONTEXT_ERROR_PCT) return "var(--error)";
  if (percent > CONTEXT_WARNING_PCT) return "var(--warning)";
  return "var(--text-tertiary)";
}

/**
 * The bit-depth a quantisation code implies, as `4-bit`, `16-bit`, … — the first
 * run of digits in the code (`Q4_0`→`4-bit`, `Q5_K_M`→`5-bit`, `F16`→`16-bit`,
 * `q8_0`→`8-bit`). It is the human reading that leads a card's identity line and
 * labels its KV-cache; the exact code stays beside it. Empty when the code holds
 * no digits (or is itself empty), so the caller drops the token rather than
 * printing a bare `-bit`.
 */
export function bitsFromCode(code: string): string {
  const digits = code.match(/\d+/);
  return digits === null ? "" : `${digits[0]}-bit`;
}

/**
 * The KV-cache bit-depth label, `8-bit` or `8-bit / 5-bit`: each side run through
 * {@link bitsFromCode}, collapsed to one token when K and V match (the common
 * case) and kept split only when they genuinely differ. A side whose code has no
 * digits to convert falls back to the raw code, so the label is never blank.
 */
export function formatKvBits(kvCache: string): string {
  const slash = kvCache.indexOf("/");
  const kCode = slash === -1 ? kvCache : kvCache.slice(0, slash);
  const vCode = slash === -1 ? kvCache : kvCache.slice(slash + 1);
  const k = bitsFromCode(kCode) || kCode;
  const v = bitsFromCode(vCode) || vCode;
  return k === v ? k : `${k} / ${v}`;
}

/**
 * The value a labeled card field carries when the fact behind it is not
 * confirmed. A field's fact is trusted only while a process is running for the
 * model (see the `confirmed` flag the selectors pass): a filename is a guess and
 * a preset's launch args are intent, neither true until the model loads. Every
 * field but `Type` collapses to this token when unconfirmed, so every unloaded
 * card reads the same rather than differing by how much each has configured.
 */
export const NA = "n/a";

/** `on`/`off`/`auto` shown title-cased; a lookup keeps the index access honest. */
const FLASH_LABELS: Record<ModelInfo["flashAttn"], string> = {
  on: "On",
  off: "Off",
  auto: "Auto",
};

/**
 * The `Quant` field: `4-bit (Q4_0)` — the bit-depth reading leads, the raw code
 * rides beside it. {@link NA} when unconfirmed, or when the code carries no
 * digits to read a depth from (a bare code is the noise this field translates).
 */
export function formatQuantField(quant: string, confirmed: boolean): string {
  if (!confirmed) return NA;
  const bits = bitsFromCode(quant);
  return bits === "" ? NA : `${bits} (${quant})`;
}

/** The `Size` field: `0.42 GB`. {@link NA} until loaded (no `meta`, no bytes). */
export function formatSizeField(sizeGB: number | null, confirmed: boolean): string {
  return confirmed && sizeGB !== null ? `${formatSizeGB(sizeGB)} GB` : NA;
}

/**
 * The `Context` field: `40k / slot` — the per-slot window each request is handed.
 * Per-slot only, with no native-window ceiling: the trained max is a separate
 * fact the labeled grid does not carry. {@link NA} until loaded.
 */
export function formatContextField(ctx: number | null, confirmed: boolean): string {
  return confirmed && ctx !== null ? `${formatTokenCount(ctx)} / slot` : NA;
}

/**
 * The `GPU Layers` field: the requested `--n-gpu-layers` as a raw integer (`99`
 * is llama.cpp's "all layers" sentinel, shown as-is). {@link NA} when the count
 * is `null` — including a loaded model whose layers were never pinned, because
 * the effective count is never reported back, so `n/a` is the honest reading.
 */
export function formatGpuLayersField(gpuLayers: number | null, confirmed: boolean): string {
  return confirmed && gpuLayers !== null ? String(gpuLayers) : NA;
}

/**
 * The `Flash` field: `On`/`Off`/`Auto`. Can read `Auto` even while loaded — the
 * server does not report which way `auto` resolved. {@link NA} until loaded.
 */
export function formatFlashField(flashAttn: ModelInfo["flashAttn"], confirmed: boolean): string {
  return confirmed ? FLASH_LABELS[flashAttn] : NA;
}

/**
 * The `KV Cache` field: `8-bit`, or `8-bit / 5-bit` when K and V differ — the
 * per-side bit-depth via {@link formatKvBits}. {@link NA} until loaded.
 */
export function formatKvCacheField(kvCache: string, confirmed: boolean): string {
  return confirmed ? formatKvBits(kvCache) : NA;
}

/**
 * The `Type` field: `Generative` or `Embedder`. The one field that never reads
 * {@link NA} — the router reports a model's modalities even while it is unloaded,
 * so this is confirmed for every card.
 */
export function formatTypeField(embedding: boolean): string {
  return embedding ? "Embedder" : "Generative";
}

/** One exported log line. Structurally satisfied by the console's view model. */
export interface LogTextRow {
  time: string;
  level: string;
  model: string;
  message: string;
}

/**
 * The copy/download payload: `HH:MM:SS.mmm LEVEL model message`, one line each.
 * It mirrors what is on screen, filters included — the operator is quoting the
 * console, not dumping the buffer.
 */
export function formatLogText(rows: readonly LogTextRow[]): string {
  return rows.map((r) => `${r.time} ${r.level} ${r.model} ${r.message}`).join("\n");
}
