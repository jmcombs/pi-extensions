/**
 * @jmcombs/pi-headroom — read-only proxy status snapshot + display formatting (LD9).
 *
 * The proxy's `token`/`cache` **mode** and tuning are server-launch-only: the
 * `/v1/compress` endpoint ignores any per-request `mode`/`config`, and the npm
 * SDK exposes no token/cache mode (proven by the Phase 4 spike). So this module
 * only ever **reads and reports** the proxy's effective settings (LD9) — it
 * never sets `mode` or any proxy-side config (that would require relaunching the
 * proxy → LD4). The user changes proxy settings on their own.
 *
 * `getProxyStatus` performs two read-only GETs — `health()` (reachability +
 * version) and `proxyStats()` (mode + tuning + lifetime savings) — and folds the
 * result into a normalized, never-throwing snapshot (`reachable:false` on any
 * error). `formatStatusLine` is a pure renderer for the persistent display.
 *
 * Field provenance was verified empirically against the live proxy (v0.27.0):
 *   - `version`               ← `health().version`
 *   - `mode`                  ← `proxyStats().summary.mode`        (e.g. "token")
 *   - `targetRatio`           ← `proxyStats().config.targetRatio`
 *   - `protectRecent`         ← `proxyStats().config.protectRecent`
 *   - `compressUserMessages`  ← `proxyStats().config.compressUserMessages`
 *   - `proxyTokensSaved`      ← `proxyStats().tokens.saved`        (lifetime)
 *   - `proxyCompressionRatio` ← `proxyStats().tokens.savingsPercent`
 *
 * Note: the SDK's published `ProxyStats` type omits `summary` and `config`, but
 * the live `/stats` response (which `proxyStats()` returns verbatim, camelCased)
 * carries them. We read those fields defensively from the runtime object.
 */

import { HeadroomClient } from "headroom-ai";

/** Bound each status GET so a hung/refused proxy resolves quickly (LD3). */
const STATUS_TIMEOUT_MS = 3_000;

/**
 * Normalized, never-throwing snapshot of the proxy's reachability, effective
 * read-only settings, and lifetime savings. All fields beyond `reachable` are
 * optional — absent when the proxy is unreachable or does not report them.
 */
export interface ProxyStatusState {
  /** True only when the proxy answered a healthy `health()` probe. */
  reachable: boolean;
  /** Proxy version string from `health()`, e.g. `"0.27.0"`. */
  version?: string;
  /** Proxy optimization mode, e.g. `"token"` or `"cache"` (read-only; LD9). */
  mode?: string;
  /** Effective target keep-ratio, when the proxy has one configured. */
  targetRatio?: number;
  /** Effective recent-turn protection count, when configured. */
  protectRecent?: number;
  /** Whether the proxy compresses user messages. */
  compressUserMessages?: boolean;
  /** Lifetime tokens saved as reported by the proxy. */
  proxyTokensSaved?: number;
  /** Lifetime savings percentage as reported by the proxy. */
  proxyCompressionRatio?: number;
}

/** Display state = the proxy snapshot plus the extension's own enabled flag. */
export interface StatusDisplayState extends ProxyStatusState {
  /** Whether session compression is enabled (false when `--headroom-no-compress`). */
  enabled: boolean;
}

/** The subset of the live `proxyStats()` runtime object this module reads. */
interface RawProxyStats {
  summary?: { mode?: unknown } | null;
  config?: {
    targetRatio?: unknown;
    protectRecent?: unknown;
    compressUserMessages?: unknown;
  } | null;
  tokens?: { saved?: unknown; savingsPercent?: unknown } | null;
}

/** Coerce to a finite number, or `undefined` (handles `null`/non-numeric). */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Coerce to a non-empty string, or `undefined`. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Map a live `proxyStats()` object onto the settings + lifetime-savings fields
 * of a `ProxyStatusState`. Pure and exported so the shaping can be unit-tested
 * with an injected stub object and **no network**. Tolerates missing/`null`
 * fields — anything absent maps to `undefined`.
 */
export function normalizeProxyStats(
  stats: unknown,
): Omit<ProxyStatusState, "reachable" | "version"> {
  const raw = (stats ?? {}) as RawProxyStats;
  const config = raw.config ?? {};
  const tokens = raw.tokens ?? {};
  const compressUserMessages =
    typeof config.compressUserMessages === "boolean" ? config.compressUserMessages : undefined;

  return {
    mode: str(raw.summary?.mode),
    targetRatio: num(config.targetRatio),
    protectRecent: num(config.protectRecent),
    compressUserMessages,
    proxyTokensSaved: num(tokens.saved),
    proxyCompressionRatio: num(tokens.savingsPercent),
  };
}

/**
 * Read the proxy's reachability, read-only settings, and lifetime savings.
 *
 * Performs only read-only GETs (`health()`, `proxyStats()`) — never mutates any
 * proxy-side config (LD9) and never manages the proxy (LD4). Returns
 * `{ reachable: false }` on any error (down proxy, timeout, bad response) and
 * **never throws** (LD3).
 */
export async function getProxyStatus(baseUrl?: string, apiKey?: string): Promise<ProxyStatusState> {
  try {
    const client = new HeadroomClient({
      baseUrl,
      apiKey,
      fallback: true,
      timeout: STATUS_TIMEOUT_MS,
    });
    const health = await client.health();
    if (health?.status !== "healthy") return { reachable: false };

    let normalized: Omit<ProxyStatusState, "reachable" | "version"> = {};
    try {
      const stats = await client.proxyStats();
      normalized = normalizeProxyStats(stats);
    } catch {
      // Reachable + healthy, but stats unavailable — report what we have.
      normalized = {};
    }

    return { reachable: true, version: str(health.version), ...normalized };
  } catch {
    return { reachable: false };
  }
}

/** Render a token count compactly: `0`, `880`, `8.8k`, `1.2M`. */
function humanizeTokens(value: number): string {
  const n = Math.round(value);
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/**
 * Render the one-line status display from the current display state and the
 * in-memory session savings. Pure — no I/O, never throws. Examples:
 *
 *   `Headroom: on · proxy 0.27.0 · mode token · saved 8.8k this session · 1.2M lifetime`
 *   `Headroom: off · proxy 0.27.0 · mode token · saved 0 this session · 0 lifetime`
 *   `Headroom: on · proxy unreachable · saved 8.8k this session`
 */
export function formatStatusLine(state: StatusDisplayState, sessionTokensSaved: number): string {
  const sessionSaved = Number.isFinite(sessionTokensSaved) ? sessionTokensSaved : 0;
  const parts: string[] = [`Headroom: ${state.enabled ? "on" : "off"}`];

  if (!state.reachable) {
    parts.push("proxy unreachable");
    parts.push(`saved ${humanizeTokens(sessionSaved)} this session`);
    return parts.join(" · ");
  }

  parts.push(`proxy ${state.version ?? "unknown"}`);
  if (state.mode) parts.push(`mode ${state.mode}`);

  // Key tuning — only surfaced when the proxy actually has it set, so a
  // default proxy keeps the line clean.
  const settings: string[] = [];
  if (typeof state.targetRatio === "number") settings.push(`ratio ${state.targetRatio}`);
  if (typeof state.protectRecent === "number") settings.push(`protect ${state.protectRecent}`);
  if (state.compressUserMessages) settings.push("user-msgs");
  if (settings.length > 0) parts.push(settings.join(" "));

  parts.push(`saved ${humanizeTokens(sessionSaved)} this session`);
  if (typeof state.proxyTokensSaved === "number") {
    parts.push(`${humanizeTokens(state.proxyTokensSaved)} lifetime`);
  }

  return parts.join(" · ");
}
