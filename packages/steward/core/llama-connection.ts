/**
 * How Steward finds the `llama-server` it reads.
 *
 * A connection is just a base URL and an API key. Where they come from depends
 * on the host: inside Pi they come from the provider auth the operator already
 * configured (the same resolution Pi's own llama.cpp extension performs), and
 * outside Pi — the dev server — they come from the environment. Both paths fall
 * back to the loopback default `llama-server` binds, so the dashboard always
 * has somewhere to point.
 *
 * Pi's `LlamaClient`/`normalizeLlamaServerUrl` live at a deep path outside the
 * package's `exports` map, so importing them would bypass Node's encapsulation
 * and break on hosts that ship a subset shim. The eight-line normalizer is
 * reimplemented here instead, and we talk HTTP with `fetch` ourselves.
 *
 * This module is only ever loaded in Node (the server half), never shipped to
 * the browser, so `process.env` here is fine.
 */

/** A resolved way to reach one `llama-server`. */
export interface LlamaConnection {
  /** Normalized origin, e.g. `http://127.0.0.1:8080` — no trailing slash, no `/v1`. */
  baseUrl: string;
  /** Bearer key, or `""` when the server is keyless. */
  apiKey: string;
}

/**
 * The slice of Pi's provider auth Steward needs. Declared structurally rather
 * than imported so a host that ships a narrower shape (or none) still type-checks.
 */
interface ProviderAuthResult {
  auth: { apiKey?: string; baseUrl?: string };
  /** Provider-scoped config resolved from credentials, e.g. `LLAMA_BASE_URL`. */
  env?: Record<string, string>;
}

/**
 * The one host capability this module reaches for. Optional at every level so
 * that on a host whose extension API omits `modelRegistry` (a subset shim), the
 * feature check simply fails and we fall back to the environment — a missing
 * property never throws, unlike a static named import of an absent symbol.
 */
export interface ConnectionContext {
  modelRegistry?: {
    getProviderAuth?(provider: string): Promise<ProviderAuthResult | undefined>;
  };
}

/** The provider id `llama-server` registers under, matching Pi's own extension. */
const LLAMA_PROVIDER = "llama.cpp";

/** Where `llama-server` listens unless told otherwise; already in normal form. */
const DEFAULT_BASE_URL = "http://127.0.0.1:8080";

/**
 * Normalizes a server URL to a bare origin: http/https only, no query, no
 * fragment, no trailing slash, and no `/v1` suffix (that is the inference path,
 * not the server root). Throws on a non-http(s) URL rather than guessing.
 *
 * A faithful reimplementation of Pi's `normalizeLlamaServerUrl` — see the module
 * comment for why it is not imported.
 */
export function normalizeLlamaServerUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Server URL must use http or https");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

/**
 * The `host:port` a base URL points at, for the CONFIG `listen` row and the
 * degraded overlays. Falls back to the raw string if the URL cannot be parsed,
 * so a caller never sees `undefined`.
 */
export function listenAddress(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Normalizes a configured value, or falls back to the default on empty/invalid. */
function normalizeOrDefault(value: string): string {
  if (value.trim() === "") return DEFAULT_BASE_URL;
  try {
    return normalizeLlamaServerUrl(value);
  } catch {
    // A malformed override should degrade the dashboard, not crash it.
    return DEFAULT_BASE_URL;
  }
}

/**
 * Resolves where to reach `llama-server`.
 *
 * Precedence mirrors Pi's llama.cpp extension: when the host exposes provider
 * auth, `LLAMA_BASE_URL` from the resolved provider env wins, then the
 * credential's `baseUrl`, then the loopback default; the key is the credential's
 * `apiKey`. Without that host capability (the dev server, or a subset shim) the
 * same two variables are read from the process environment instead.
 *
 * `env` is injectable so tests need not mutate the real environment.
 */
export async function resolveLlamaConnection(
  ctx?: ConnectionContext,
  env: Record<string, string | undefined> = process.env,
): Promise<LlamaConnection> {
  const getProviderAuth = ctx?.modelRegistry?.getProviderAuth;
  if (typeof getProviderAuth === "function") {
    try {
      const result = await getProviderAuth(LLAMA_PROVIDER);
      if (result !== undefined) {
        // An empty `LLAMA_BASE_URL` means "unset" — the same way Pi's own
        // resolver treats it. Plain `??` would let "" shadow a configured
        // `auth.baseUrl` and drop us onto the loopback default instead.
        const envUrl = result.env?.LLAMA_BASE_URL;
        const configured =
          typeof envUrl === "string" && envUrl !== "" ? envUrl : result.auth.baseUrl;
        return { baseUrl: normalizeOrDefault(configured ?? ""), apiKey: result.auth.apiKey ?? "" };
      }
    } catch {
      // Auth resolution is best-effort: fall through to the environment.
    }
  }

  return {
    baseUrl: normalizeOrDefault(env.LLAMA_BASE_URL ?? ""),
    apiKey: env.LLAMA_API_KEY ?? "",
  };
}
