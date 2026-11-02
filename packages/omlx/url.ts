/** Default omlx server root. Inference calls append `/v1`. */
export const DEFAULT_OMLX_SERVER_URL = "http://127.0.0.1:8000";

/**
 * Canonical omlx server root.
 *
 * Matches llama.cpp's `normalizeLlamaServerUrl`: http/https only, hash and
 * search stripped, trailing slashes removed, and one trailing `/v1` removed.
 */
export function normalizeOmlxServerUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Server URL must use http or https");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

/** OpenAI-compatible inference base URL: the normalized server root plus `/v1`. */
export function omlxInferenceUrl(serverUrl: string): string {
  return `${normalizeOmlxServerUrl(serverUrl)}/v1`;
}
