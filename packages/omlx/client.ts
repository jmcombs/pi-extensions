import { normalizeOmlxServerUrl } from "./url.js";

const REQUEST_TIMEOUT_MS = 15_000;
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

/** HTTP failure from omlx. `status` lets callers tell a sub-key 401 from other errors. */
export class OmlxHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OmlxHttpError";
    this.status = status;
  }
}

/** One row from `GET /admin/api/hf/search`. */
export interface OmlxHfSearchHit {
  repo_id: string;
  downloads: number;
}

/** Fields from `GET /admin/api/hf/model-info` the download flow reads. */
export interface OmlxHfModelInfo {
  repo_id: string;
  layout: string;
}

/** One download task from `POST /admin/api/hf/download` or `GET /admin/api/hf/tasks`. */
export interface OmlxHfTask {
  task_id: string;
  repo_id: string;
  status: string;
  total_size: number;
  downloaded_size: number;
  error: string;
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

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await fetch(`${this.serverUrl}${path}`, { ...init, headers, signal });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    if (!response.ok)
      throw new OmlxHttpError(response.status, errorMessage(payload, response.status));
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

  /** Block until omlx has the model in memory. Already-loaded is success. */
  async load(id: string, signal?: AbortSignal): Promise<void> {
    await this.request(modelActionPath(id, "load"), {
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
    });
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

  /** `GET /admin/api/hf/search?q=&sort=downloads&limit=20&model_format=mlx`. */
  async hfSearch(q: string, signal?: AbortSignal): Promise<readonly OmlxHfSearchHit[]> {
    const params = new URLSearchParams({
      q,
      sort: "downloads",
      limit: "20",
      model_format: "mlx",
    });
    const payload = await this.request(
      `/admin/api/hf/search?${params}`,
      signal === undefined ? {} : { signal },
    );
    return parseHfSearch(payload);
  }

  /** `GET /admin/api/hf/model-info`. Sends `X-HF-Token` only when a token is set. */
  async hfModelInfo(
    repoId: string,
    hfToken: string | undefined,
    signal?: AbortSignal,
  ): Promise<OmlxHfModelInfo> {
    const params = new URLSearchParams({ repo_id: repoId });
    const headers = new Headers();
    if (hfToken) headers.set("X-HF-Token", hfToken);
    const payload = await this.request(`/admin/api/hf/model-info?${params}`, {
      headers,
      ...(signal === undefined ? {} : { signal }),
    });
    return parseHfModelInfo(payload);
  }

  /**
   * `POST /admin/api/hf/download`. `hf_token` is always a string: `""` when
   * absent, never `null`.
   */
  async hfDownload(
    repoId: string,
    hfToken: string | undefined,
    signal?: AbortSignal,
  ): Promise<OmlxHfTask> {
    const payload = await this.request("/admin/api/hf/download", {
      method: "POST",
      body: JSON.stringify({ repo_id: repoId, hf_token: hfToken ?? "" }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!isRecord(payload)) throw new Error("omlx returned an invalid download task");
    return parseHfTask(payload.task);
  }

  /** `GET /admin/api/hf/tasks`. */
  async hfTasks(signal?: AbortSignal): Promise<readonly OmlxHfTask[]> {
    const payload = await this.request(
      "/admin/api/hf/tasks",
      signal === undefined ? {} : { signal },
    );
    if (!isRecord(payload) || !Array.isArray(payload.tasks)) {
      throw new Error("omlx returned an invalid download task list");
    }
    return payload.tasks.map((task) => parseHfTask(task));
  }

  /** `POST /admin/api/hf/cancel/{task_id}`. */
  async hfCancel(taskId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/admin/api/hf/cancel/${encodeURIComponent(taskId)}`, {
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

function parseHfSearch(payload: unknown): readonly OmlxHfSearchHit[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error("omlx returned an invalid Hugging Face search");
  }
  return payload.models.map((value) => {
    if (!isRecord(value) || typeof value.repo_id !== "string") {
      throw new Error("omlx returned an invalid Hugging Face search");
    }
    const downloads = value.downloads;
    return {
      repo_id: value.repo_id,
      downloads: typeof downloads === "number" && Number.isFinite(downloads) ? downloads : 0,
    };
  });
}

function parseHfModelInfo(payload: unknown): OmlxHfModelInfo {
  if (
    !isRecord(payload) ||
    typeof payload.repo_id !== "string" ||
    typeof payload.layout !== "string"
  ) {
    throw new Error("omlx returned invalid model info");
  }
  return { repo_id: payload.repo_id, layout: payload.layout };
}

function parseHfTask(value: unknown): OmlxHfTask {
  if (!isRecord(value) || typeof value.task_id !== "string" || typeof value.repo_id !== "string") {
    throw new Error("omlx returned an invalid download task");
  }
  if (typeof value.status !== "string") throw new Error("omlx returned an invalid download task");
  const total = readNumberOrNull(value.total_size);
  const downloaded = readNumberOrNull(value.downloaded_size);
  if (total === undefined || total === null || downloaded === undefined || downloaded === null) {
    throw new Error("omlx returned an invalid download task");
  }
  const error = value.error;
  return {
    task_id: value.task_id,
    repo_id: value.repo_id,
    status: value.status,
    total_size: total,
    downloaded_size: downloaded,
    error: typeof error === "string" ? error : "",
  };
}
