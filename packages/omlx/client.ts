import { normalizeOmlxServerUrl } from "./url.js";

const REQUEST_TIMEOUT_MS = 15_000;
/**
 * `POST /v1/models/{id}/load` blocks until the model is loaded. A 27B MLX
 * load outlives the 15s management timeout, so this call waits longer. Every
 * other request keeps the 15s timeout.
 */
const LOAD_TIMEOUT_MS = 30 * 60 * 1000;
const UNLOAD_POLL_MS = 100;

/** One row from `GET /v1/models` after the id check. Extra fields are preserved. */
export interface OmlxListedModel {
  id: string;
  /** Effective context limit. Absent or null when omlx did not report one. */
  max_model_len?: number | null;
}

/**
 * One pool row from `GET /v1/models/status`.
 *
 * `id` is the physical pool id. Chat publishes `model_alias` instead when set.
 */
export interface OmlxStatusRow {
  id: string;
  loaded: boolean;
  is_loading: boolean;
  model_type: string;
  engine_type: string;
  model_format: string | null;
  model_context_length: number | null;
  thinking_default: boolean | null;
  reasoning_efforts: readonly string[] | null;
  is_hidden: boolean;
  model_alias: string | null;
  estimated_size: number | null;
  loading_started_at: number | null;
}

/** `GET /v1/models/status` fields the catalog and load-progress UI read. */
export interface OmlxModelStatus {
  models: readonly OmlxStatusRow[];
  load_seconds_per_gb_estimate: number | null;
  load_time_observations: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isListedModel(value: unknown): value is OmlxListedModel {
  return isRecord(value) && typeof value.id === "string";
}

function readStringOrNull(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function readNumberOrNull(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBooleanOrNull(value: unknown): boolean | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "boolean" ? value : undefined;
}

function readEfforts(value: unknown): readonly string[] | null | undefined {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function readStatusRow(value: unknown): OmlxStatusRow | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  if (typeof value.loaded !== "boolean" || typeof value.is_loading !== "boolean") return undefined;
  if (typeof value.model_type !== "string" || typeof value.engine_type !== "string")
    return undefined;
  if (typeof value.is_hidden !== "boolean") return undefined;
  const modelFormat = readStringOrNull(value.model_format);
  const modelContextLength = readNumberOrNull(value.model_context_length);
  const thinkingDefault = readBooleanOrNull(value.thinking_default);
  const reasoningEfforts = readEfforts(value.reasoning_efforts);
  const modelAlias = readStringOrNull(value.model_alias);
  const estimatedSize = readNumberOrNull(value.estimated_size);
  const loadingStartedAt = readNumberOrNull(value.loading_started_at);
  if (
    modelFormat === undefined ||
    modelContextLength === undefined ||
    thinkingDefault === undefined ||
    reasoningEfforts === undefined ||
    modelAlias === undefined ||
    estimatedSize === undefined ||
    loadingStartedAt === undefined
  ) {
    return undefined;
  }
  return {
    id: value.id,
    loaded: value.loaded,
    is_loading: value.is_loading,
    model_type: value.model_type,
    engine_type: value.engine_type,
    model_format: modelFormat,
    model_context_length: modelContextLength,
    thinking_default: thinkingDefault,
    reasoning_efforts: reasoningEfforts,
    is_hidden: value.is_hidden,
    model_alias: modelAlias,
    estimated_size: estimatedSize,
    loading_started_at: loadingStartedAt,
  };
}

/** Parse a `GET /v1/models/status` body. Throws on a shape this client cannot map. */
export function parseModelStatus(payload: unknown): OmlxModelStatus {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error("omlx returned an invalid model status");
  }
  const models = payload.models.map(readStatusRow);
  const estimate = readNumberOrNull(payload.load_seconds_per_gb_estimate);
  const observations = payload.load_time_observations;
  if (
    models.some((row) => row === undefined) ||
    estimate === undefined ||
    typeof observations !== "number" ||
    !Number.isFinite(observations)
  ) {
    throw new Error("omlx returned an invalid model status");
  }
  return {
    models: models.filter((row): row is OmlxStatusRow => row !== undefined),
    load_seconds_per_gb_estimate: estimate,
    load_time_observations: observations,
  };
}

/**
 * Error text from an omlx JSON body: string `detail`, then `error.message`,
 * otherwise a status fallback. `/v1/*` uses the OpenAI `error.message` shape;
 * other routes use FastAPI `detail`.
 */
function errorMessage(payload: unknown, status: number): string {
  const fallback = `omlx returned HTTP ${status}`;
  if (!isRecord(payload)) return fallback;
  if (typeof payload.detail === "string" && payload.detail) return payload.detail;
  if (
    isRecord(payload.error) &&
    typeof payload.error.message === "string" &&
    payload.error.message
  ) {
    return payload.error.message;
  }
  return fallback;
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error("Cancelled");
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function modelActionPath(id: string, action: "load" | "unload"): string {
  return `/v1/models/${encodeURIComponent(id)}/${action}`;
}

/** HTTP client for one omlx server. Paths are rooted at the server, not `/v1`. */
export class OmlxClient {
  private readonly serverUrl: string;
  private readonly apiKey: string | undefined;

  constructor(serverUrl: string, apiKey?: string) {
    this.serverUrl = normalizeOmlxServerUrl(serverUrl);
    this.apiKey = apiKey;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await fetch(`${this.serverUrl}${path}`, { ...init, headers, signal });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    if (!response.ok) throw new Error(errorMessage(payload, response.status));
    return payload;
  }

  async listModels(signal?: AbortSignal): Promise<readonly OmlxListedModel[]> {
    const payload = await this.request("/v1/models", signal === undefined ? {} : { signal });
    if (!isRecord(payload) || !Array.isArray(payload.data) || !payload.data.every(isListedModel)) {
      throw new Error("omlx returned an invalid model list");
    }
    return payload.data;
  }

  async listStatus(signal?: AbortSignal): Promise<OmlxModelStatus> {
    const payload = await this.request("/v1/models/status", signal === undefined ? {} : { signal });
    return parseModelStatus(payload);
  }

  /**
   * Block until omlx has the model in memory. Already-loaded is success.
   *
   * The request timeout is 30 minutes because the route does not return until
   * loading finishes. Callers that only need to stop waiting must not abort
   * this signal: omlx has no load-cancel route, and dropping the request is
   * not a supported cancel.
   */
  async load(id: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      modelActionPath(id, "load"),
      {
        method: "POST",
        ...(signal === undefined ? {} : { signal }),
      },
      LOAD_TIMEOUT_MS,
    );
  }

  /**
   * Start an unload. omlx answers 202 when active requests are still aborting;
   * that status is success because `request` accepts every 2xx.
   */
  async unload(id: string, signal?: AbortSignal): Promise<void> {
    await this.request(modelActionPath(id, "unload"), {
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** Unload, then poll status every 100 ms until the row is missing or not loaded. */
  async unloadAndWait(id: string, signal?: AbortSignal): Promise<void> {
    await this.unload(id, signal);
    for (;;) {
      if (signal?.aborted) throw abortError(signal);
      const status = await this.listStatus(signal);
      const row = status.models.find((model) => model.id === id);
      if (row === undefined || !row.loaded) return;
      await wait(UNLOAD_POLL_MS, signal);
    }
  }
}
