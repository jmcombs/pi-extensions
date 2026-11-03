/**
 * Hugging Face token lookup and download-input checks.
 *
 * Token order matches Pi's llama.cpp `findHuggingFaceToken`. Gated status
 * comes from Hugging Face because omlx model-info has no gated field.
 * `:quant` is rejected: this extension supports MLX repos only.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const HUGGING_FACE_MODELS_URL = "https://huggingface.co/api/models";
const REQUEST_TIMEOUT_MS = 15_000;
const BYTE_UNITS = ["KiB", "MiB", "GiB", "TiB"] as const;

/** Shown for a `:quant` suffix and for a repo whose layout is `gguf`. */
export const MLX_ONLY_ERROR =
  "This extension supports MLX models only. GGUF quantizations are not supported.";

const QUANT_INPUT = /^[^/\s]+\/[^:\s]+:[^\s:]+$/u;
const REPO_INPUT = /^([^/\s]+)\/([^:\s]+)$/u;

export interface HuggingFaceGated {
  id: string;
  gated: false | "auto" | "manual";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readToken(path: string): Promise<string | undefined> {
  try {
    const token = (await readFile(path, "utf8")).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Trimmed `HF_TOKEN`, then `HF_TOKEN_PATH`, `$HF_HOME/token`,
 * `$XDG_CACHE_HOME/huggingface/token`, then `~/.cache/huggingface/token`.
 * Blank values are skipped.
 */
export async function findHuggingFaceToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const fromEnvironment = env.HF_TOKEN?.trim();
  if (fromEnvironment) return fromEnvironment;
  const paths = [
    env.HF_TOKEN_PATH,
    env.HF_HOME ? join(env.HF_HOME, "token") : undefined,
    env.XDG_CACHE_HOME ? join(env.XDG_CACHE_HOME, "huggingface", "token") : undefined,
    join(homedir(), ".cache", "huggingface", "token"),
  ].filter((path): path is string => Boolean(path));
  for (const path of new Set(paths)) {
    const token = await readToken(path);
    if (token) return token;
  }
  return undefined;
}

function huggingFaceError(payload: unknown, status: number): string {
  if (status === 429) return "Hugging Face rate limit reached";
  const fallback = `Hugging Face returned HTTP ${status}`;
  if (!isRecord(payload)) return fallback;
  return typeof payload.error === "string" && payload.error ? payload.error : fallback;
}

/**
 * Gated flag from `GET https://huggingface.co/api/models/<id>`.
 * `auto` and `manual` are gated. Anything else, including `false`, is not.
 */
export async function fetchGated(
  repoId: string,
  token: string | undefined,
  signal?: AbortSignal,
): Promise<HuggingFaceGated> {
  const encoded = repoId
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const headers = new Headers();
  const trimmed = token?.trim();
  if (trimmed) headers.set("Authorization", `Bearer ${trimmed}`);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(`${HUGGING_FACE_MODELS_URL}/${encoded}`, {
    headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (!response.ok) throw new Error(huggingFaceError(payload, response.status));
  if (!isRecord(payload)) throw new Error("Hugging Face returned invalid model details");
  const id = typeof payload.id === "string" && payload.id ? payload.id : repoId;
  const gated = payload.gated === "auto" || payload.gated === "manual" ? payload.gated : false;
  return { id, gated };
}

/** llama.cpp `formatBytes`: bytes under 1024, then KiB/MiB/GiB/TiB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit: (typeof BYTE_UNITS)[number] = BYTE_UNITS[0];
  for (let index = 1; index < BYTE_UNITS.length && value >= 1024; index += 1) {
    value /= 1024;
    const next = BYTE_UNITS[index];
    if (next !== undefined) unit = next;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

/**
 * Exact `owner/repo` bypasses search. A `:quant` suffix is the MLX-only error.
 * Other text is not a repository id.
 */
export function parseDownloadInput(value: string): { repoId: string } | { error: string } {
  const trimmed = value.trim();
  if (QUANT_INPUT.test(trimmed)) return { error: MLX_ONLY_ERROR };
  const match = REPO_INPUT.exec(trimmed);
  const owner = match?.[1];
  const repo = match?.[2];
  if (!owner || !repo) return { error: "Enter a Hugging Face owner/repository." };
  return { repoId: `${owner}/${repo}` };
}
