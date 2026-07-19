/**
 * @jmcombs/pi-headroom — proxy client.
 *
 * A thin, defensive wrapper around the `headroom-ai` SDK (itself a pure HTTP
 * client to the local Python Headroom proxy). This module owns:
 *
 *   - `resolveConfig()` — resolves the proxy base URL + optional API key from
 *     (in precedence order) an explicit argument, the stored `headroom`
 *     credential (via `resolveSecret` from `@jmcombs/pi-1password`, injectable as
 *     `resolveKey` for tests), the `HEADROOM_BASE_URL` / `HEADROOM_API_KEY`
 *     environment variables, and finally the default `http://127.0.0.1:8787`.
 *
 *   - `getClient()` — a memoized `HeadroomClient` instance.
 *   - `isHealthy()` — a short-TTL cached health probe that resolves `false` on
 *     any error and **never throws** (LD3).
 *
 * The extension never manages the proxy lifecycle (LD4); it only health-checks
 * and reads configuration.
 */

import { resolveSecret } from "@jmcombs/pi-1password";
import { HeadroomClient } from "headroom-ai";

/** Resolver for a stored credential by logical name. Defaults to `resolveSecret`. */
export type ResolveKey = (name: string) => Promise<string | undefined>;

/** Default proxy endpoint when nothing else is configured. */
export const DEFAULT_BASE_URL = "http://127.0.0.1:8787";

/** Health-probe cache lifetime. Short so status changes surface quickly. */
const HEALTH_TTL_MS = 5_000;

/** Bound the health request so a hung/refused proxy resolves quickly (LD3). */
const HEALTH_TIMEOUT_MS = 3_000;

export interface ResolveConfigArgs {
  /** Explicit override for the proxy base URL (highest precedence). */
  baseUrl?: string;
  /** Explicit override for the proxy API key (highest precedence). */
  apiKey?: string;
  /**
   * Inject a stored-credential resolver (tests); defaults to `resolveSecret`
   * from `@jmcombs/pi-1password`. Called with the logical name `"headroom"`.
   */
  resolveKey?: ResolveKey;
}

export interface ResolvedConfig {
  baseUrl: string;
  apiKey: string | undefined;
}

/**
 * Resolve the proxy configuration.
 *
 * Base URL precedence: explicit arg → `HEADROOM_BASE_URL` env → default
 * (`http://127.0.0.1:8787`).
 *
 * API key precedence: explicit arg → stored `headroom` credential
 * (`resolveSecret`) → `HEADROOM_API_KEY` env → undefined.
 *
 * The stored key is read through `@jmcombs/pi-1password`'s `resolveSecret`,
 * which resolves both a literal key and an `!op read 'op://…'` 1Password
 * reference fresh on each call. The lookup is best-effort and never throws (LD3).
 */
export async function resolveConfig(args: ResolveConfigArgs = {}): Promise<ResolvedConfig> {
  const resolveKey = args.resolveKey ?? resolveSecret;

  const baseUrl = args.baseUrl ?? process.env.HEADROOM_BASE_URL ?? DEFAULT_BASE_URL;

  let apiKey = args.apiKey;
  if (!apiKey) {
    try {
      apiKey = await resolveKey("headroom");
    } catch {
      apiKey = undefined;
    }
  }
  // Only accept a real string key; fall back to the environment otherwise.
  if (typeof apiKey !== "string") apiKey = undefined;
  apiKey = apiKey ?? process.env.HEADROOM_API_KEY;

  return { baseUrl, apiKey };
}

let clientPromise: Promise<HeadroomClient> | undefined;

/**
 * Return a memoized `HeadroomClient`. The first call resolves configuration
 * and constructs the client; subsequent calls reuse it.
 *
 * `fallback: true` ensures the SDK degrades to passthrough on the proxy side
 * (LD3); this client wrapper additionally guards every call site.
 */
export function getClient(args?: ResolveConfigArgs): Promise<HeadroomClient> {
  if (!clientPromise) {
    clientPromise = resolveConfig(args).then(
      (cfg) =>
        new HeadroomClient({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          fallback: true,
          timeout: HEALTH_TIMEOUT_MS,
        }),
    );
  }
  return clientPromise;
}

/** Reset memoized client + health cache (test/teardown helper). */
export function resetClient(): void {
  clientPromise = undefined;
  healthCache = undefined;
}

let healthCache: { value: boolean; expiresAt: number } | undefined;

/**
 * Cached proxy health probe. Resolves `true` only when the proxy reports
 * `status: "healthy"`. Resolves `false` on any error (connection refused,
 * timeout, non-healthy status) and **never throws** (LD3).
 */
export async function isHealthy(args?: ResolveConfigArgs): Promise<boolean> {
  const now = Date.now();
  if (healthCache && now < healthCache.expiresAt) {
    return healthCache.value;
  }

  let value = false;
  try {
    const client = await getClient(args);
    const status = await client.health();
    value = status?.status === "healthy";
  } catch (error) {
    // Developer diagnostics only — goes to pi's debug log, not the TUI. The
    // user-facing passthrough notice is emitted once at the session_start call
    // site via ctx.ui.notify. Quiet by default; opt in with HEADROOM_DEBUG.
    if (process.env.HEADROOM_DEBUG) {
      console.error("[headroom] health check failed:", error);
    }
    value = false;
  }

  healthCache = { value, expiresAt: now + HEALTH_TTL_MS };
  return value;
}
