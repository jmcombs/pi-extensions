import { normalizeOmlxServerUrl } from "./url.js";

const REQUEST_TIMEOUT_MS = 15_000;

/** One row from `GET /v1/models` after the id check. Extra fields are preserved. */
export interface OmlxListedModel {
  id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isListedModel(value: unknown): value is OmlxListedModel {
  return isRecord(value) && typeof value.id === "string";
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
}
