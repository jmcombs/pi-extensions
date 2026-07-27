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
 * A model card's meta line: `Q4_K_M · 18.4 GB · ctx 65536 · 48 gpu layers`.
 * Models without a layer count (embedders) show their own detail instead.
 */
export function formatModelMeta(model: ModelInfo): string {
  const parts = [model.quant, `${model.sizeGB.toFixed(1)} GB`, `ctx ${model.ctx}`];
  const tail = model.gpuLayers === null ? model.detail : `${model.gpuLayers} gpu layers`;
  if (tail) parts.push(tail);
  return parts.join(" · ");
}

/**
 * A model card's tuning line: `4 slots · flash on · kv q8_0/q8_0`. These come
 * from the model's preset, so they are known whether or not it is loaded —
 * unlike the runtime rate on the footer.
 */
export function formatModelTuning(model: ModelInfo): string {
  return `${model.parallel} slots · flash ${model.flashAttn} · kv ${model.kvCache}`;
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
