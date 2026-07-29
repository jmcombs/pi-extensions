/**
 * Turns a `llama-server` `/models` body into {@link ModelInfo} rows.
 *
 * The body arrives as `unknown` off the wire, so every field is narrowed before
 * it is read — a missing or wrong-typed field degrades to a null or a default,
 * never to `undefined` or `NaN`. The response is `{ object, data: [...] }`, but
 * a bare array is accepted too so the parser is easy to test against a single
 * captured model.
 *
 * This parser cannot decide `active`: that depends on whether any of the model's
 * slots is processing, which lives behind a different endpoint. A loaded model
 * is reported as `resident` here; the source upgrades it to `active` after it
 * has cross-referenced `/slots`. Keep this module free of Node and DOM APIs.
 */

import type { ModelInfo, ModelStatus } from "./types.js";

/** True for a non-null object we can read string-keyed fields off. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A non-empty string, or `null` when absent/blank/wrong-typed. */
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A finite number, or `null` when absent/wrong-typed/not finite. */
function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The elements of `value` that are strings, or `[]` when it is not an array. */
function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** The model records in a `/models` body, whether it is wrapped or bare. */
function readModelList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw.data)) return raw.data;
  return [];
}

/**
 * The value following the first of `flags` in a launch-args array, or `null`.
 * `["--port", "56568"]` → `argValue(args, ["--port"])` is `"56568"`.
 */
function argValue(args: readonly string[], flags: readonly string[]): string | null {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (flags.includes(args[i] ?? "")) return args[i + 1] ?? null;
  }
  return null;
}

/** Whether any of `flags` appears in the launch args at all. */
function hasFlag(args: readonly string[], flags: readonly string[]): boolean {
  return args.some((arg) => flags.includes(arg));
}

/** Common quantisation tokens, longest-first so `Q4_K_M` beats `Q4`. */
const QUANT_PATTERN =
  /\b(IQ\d+_[A-Z0-9]+|Q\d+_[A-Z0-9]+(?:_[A-Z0-9]+)?|Q\d+_\d+|Q\d+|F16|F32|BF16)\b/;

/** Best-effort quant label from a model id, e.g. `Qwen3-0.6B-Q4_0` → `Q4_0`. */
function quantFromId(id: string): string {
  const match = QUANT_PATTERN.exec(id);
  return match?.[1] ?? "";
}

/**
 * Best-effort quant from the `--model` path an unloaded preset launches with:
 * the token before `.gguf` in the file's basename, e.g.
 * `…/Qwen3-0.6B-Q4_0.gguf` → `Q4_0`. `""` when the arg is absent or unparseable.
 * This is what lets an unloaded preset card show its quant even though llama.cpp
 * ships no `meta` (and so no `ftype`) until the model is resident.
 */
function quantFromArgs(args: readonly string[]): string {
  const path = argValue(args, ["--model", "-m"]);
  if (path === null) return "";
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.gguf$/i, "");
  return quantFromId(base);
}

/** The last path/tag segment of an id: `ggml-org/Qwen3-GGUF:Q4_0` → `Qwen3-GGUF:Q4_0`. */
function lastSegment(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

/** Drops a trailing `<sep><suffix>` (case-insensitive) from `value`, if present. */
function stripSuffix(value: string, suffix: string): string {
  if (suffix === "") return value;
  for (const sep of ["-", ":", "_", "."]) {
    const tail = `${sep}${suffix}`;
    if (value.toLowerCase().endsWith(tail.toLowerCase())) {
      return value.slice(0, value.length - tail.length);
    }
  }
  return value;
}

/** Display name: last segment with the quant tag and a `GGUF` marker trimmed. */
function shortName(id: string, quant: string): string {
  let short = lastSegment(id);
  short = stripSuffix(short, quant);
  short = stripSuffix(short, "GGUF");
  short = stripSuffix(short, "gguf");
  return short === "" ? id : short;
}

/**
 * Maps llama.cpp's `status.value` to a {@link ModelStatus}. `loaded` becomes
 * `resident` (the source may upgrade it to `active`); `sleeping` is loaded and
 * ready, so it folds into `resident` too; anything unrecognised is treated as
 * not loaded rather than invented.
 */
function mapStatus(value: string | null): ModelStatus {
  switch (value) {
    case "loaded":
    case "sleeping":
      return "resident";
    case "loading":
      return "loading";
    case "downloading":
      return "downloading";
    default:
      return "unloaded";
  }
}

/** Flash-attention from launch args: an explicit value, a bare flag, or `auto`. */
function readFlashAttn(args: readonly string[]): "on" | "off" | "auto" {
  const value = argValue(args, ["--flash-attn", "-fa"]);
  if (value === "on" || value === "off" || value === "auto") return value;
  if (hasFlag(args, ["--flash-attn", "-fa"])) return "on";
  return "auto";
}

/** KV-cache types from launch args, defaulting each side to `f16`. */
function readKvCache(args: readonly string[]): string {
  const k = argValue(args, ["--cache-type-k", "-ctk"]) ?? "f16";
  const v = argValue(args, ["--cache-type-v", "-ctv"]) ?? "f16";
  return `${k}/${v}`;
}

/** One `/models` record → a {@link ModelInfo}, or `null` when it has no id. */
function parseModel(raw: unknown): ModelInfo | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw.id);
  if (id === null) return null;

  const status = isRecord(raw.status) ? raw.status : {};
  const args = readStringArray(status.args);
  const modelStatus = mapStatus(readString(status.value));

  const architecture = isRecord(raw.architecture) ? raw.architecture : {};
  const outputs = readStringArray(architecture.output_modalities);
  // A model that cannot emit text is an embedder. When the field is absent we
  // assume a normal text model rather than guessing an embedder.
  const embedding = outputs.length > 0 && !outputs.includes("text");

  // `meta` is only present for loaded models, so size and the native context
  // window are known only then; the quant falls back to the launch args (an
  // unloaded preset names its `.gguf`) and finally to the id.
  const meta = isRecord(raw.meta) ? raw.meta : {};
  const ftype = readString(meta.ftype);
  const argQuant = quantFromArgs(args);
  const quant = ftype ?? (argQuant !== "" ? argQuant : quantFromId(id));
  const sizeBytes = readNumber(meta.size);
  const nativeCtx = readNumber(meta.n_ctx_train);

  // `--parallel` is a plain integer when pinned; the live slot count later
  // overrides it for a loaded model, but it is all an unloaded preset has.
  const parallelArg = argValue(args, ["--parallel", "-np"]);
  const parallel = parallelArg === null ? null : readNumber(Number(parallelArg));

  // Per-slot context. Loaded models report it directly; an unloaded preset only
  // states the whole `--ctx-size`, which the router splits across `--parallel`,
  // so we divide to land on the same per-slot figure a loaded model would show.
  const metaCtx = readNumber(meta.n_ctx);
  const ctxSizeArg = argValue(args, ["--ctx-size", "-c"]);
  const ctxSize = ctxSizeArg === null ? null : readNumber(Number(ctxSizeArg));
  const ctx =
    metaCtx ??
    (ctxSize !== null && ctxSize > 0 && parallel !== null && parallel > 0
      ? Math.floor(ctxSize / parallel)
      : null);

  // Only a pinned `--n-gpu-layers` counts; a missing flag stays `null` rather
  // than becoming `Number(null) === 0`, which would invent a reading.
  const ngl = argValue(args, ["--n-gpu-layers", "-ngl"]);
  const gpuLayers = ngl === null ? null : readNumber(Number(ngl));

  return {
    id,
    short: shortName(id, quant),
    embedding,
    quant,
    sizeGB: sizeBytes === null ? null : sizeBytes / 1e9,
    ctx,
    nativeCtx,
    gpuLayers,
    detail: embedding ? "embedding" : null,
    parallel,
    flashAttn: readFlashAttn(args),
    kvCache: readKvCache(args),
    status: modelStatus,
    tokensPerSecond: null,
  };
}

/**
 * Which model is listening on which port, from the same `/models` body — the log
 * console's attribution map.
 *
 * The router prefixes every child line with `[port]` and nothing else, so a port
 * is all the console has to go on. The log *does* state the mapping, in the
 * `spawning … name=X on port P` line, but that line is written once per load and
 * is typically thousands of lines behind the live tail (14,010 in one measured
 * corpus) — so a cold-started console would attribute nothing. HTTP has the
 * answer on demand instead, and stays right across load/unload cycles because
 * every poll rebuilds it.
 *
 * Only genuinely listening ports are reported: an unloaded preset carries
 * `--port 0`, which is not a port and would otherwise map every model in the
 * catalogue onto one imaginary child.
 */
export function parseModelPorts(raw: unknown): Map<number, string> {
  const ports = new Map<number, string>();
  for (const entry of readModelList(raw)) {
    if (!isRecord(entry)) continue;
    const id = readString(entry.id);
    if (id === null) continue;
    const status = isRecord(entry.status) ? entry.status : {};
    const value = argValue(readStringArray(status.args), ["--port"]);
    if (value === null) continue;
    const port = Number.parseInt(value, 10);
    if (!Number.isInteger(port) || port <= 0) continue;
    // Last wins: ports are ephemeral and a model respawned on a new port must
    // not be shadowed by a stale entry.
    ports.set(port, id);
  }
  return ports;
}

/**
 * All models in a `/models` body, in the order the server listed them. Garbage
 * in (`null`, `{}`, wrong types) yields `[]` or drops the offending row; it
 * never throws.
 */
export function parseModels(raw: unknown): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const entry of readModelList(raw)) {
    const model = parseModel(entry);
    if (model !== null) models.push(model);
  }
  return models;
}
