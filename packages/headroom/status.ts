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
export function humanizeTokens(value: number): string {
  const n = Math.round(value);
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

// ── Powerline status widget (Blue PSL 10K look) ─────────────────────────
// A segmented, Powerline-styled rendering of the same state as
// `formatStatusLine`, for the persistent above-editor widget. Built from raw
// 24-bit ANSI like `@jmcombs/pi-blue-psl-10k`'s footer — Pi's TUI wraps each
// widget line in a `Text` component, which renders ANSI escapes (the same
// mechanism `theme.fg()` uses), so the colored blocks + Nerd-Font separators
// display in the terminal. Pure string building — no I/O, never throws.

const ESC = "\x1b";
/** Powerline solid right-pointing separator (Nerd Font). */
const ARROW_RIGHT = "";
/** Brand mark: nf-md-format-vertical-align-top — the Headroom "arrow to ceiling". */
const HEADROOM_GLYPH = "\u{F0623}";
/** Label prefix shown beside the proxy mode value. */
const MODE_LABEL = "mode:";
/** Emoji shown beside the session tokens-saved figure. */
const SAVED_EMOJI = "💾";

/** Block colors (Blue PSL 10K / Catppuccin Latte palette; Path Blue = logo blue). */
const WIDGET_COLORS = {
  fg: "#eff1f5", // light text on every block
  headroom: "#3465a4", // Path Blue (the logo blue) — brand block, always
  proxyOk: "#40a02b", // green — proxy reachable
  proxyOff: "#d20f39", // red — proxy unreachable
  mode: "#1e66f5", // blue — proxy mode block (matches blue-psl's thinking-level blue)
  saved: "#179299", // teal — session tokens saved (matches blue-psl tokens block)
} as const;

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function fgCode(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `${ESC}[38;2;${r};${g};${b}m`;
}

function bgCode(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `${ESC}[48;2;${r};${g};${b}m`;
}

const RESET = `${ESC}[0m`;

interface WidgetSegment {
  text: string;
  bg: string;
}

/**
 * Join segments into a left-aligned Powerline string: each block is padded
 * text on its background, followed by a `` separator whose foreground is the
 * block's color and whose background is the next block's color (so the triangle
 * fades cleanly into the next block; the final one fades to the terminal bg).
 */
function buildPowerline(segments: readonly WidgetSegment[]): string {
  let out = "";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    out += `${bgCode(seg.bg)}${fgCode(WIDGET_COLORS.fg)} ${seg.text} `;
    const next = segments[i + 1];
    out +=
      next !== undefined
        ? `${fgCode(seg.bg)}${bgCode(next.bg)}${ARROW_RIGHT}`
        : `${RESET}${fgCode(seg.bg)}${ARROW_RIGHT}${RESET}`;
  }
  return out;
}

/**
 * Render the persistent status widget as a Powerline bar. Blocks:
 *
 *   ` Headroom │ proxy v<version> │ mode: <mode> │ 💾 <saved>`
 *
 * The Headroom block is always the logo blue (Path Blue). The proxy block is
 * **green** with `proxy v<version>` when reachable, or a single **red**
 * `proxy offline` block when not (no mode/savings — nothing can be measured
 * with the proxy down). The mode
 * block (only when reachable) is the thinking-level blue. When compression is
 * disabled (`--headroom-no-compress`), the bar ends with a **red** `mode: off`
 * block and the savings figure is dropped (it would be meaningless). Lifetime
 * savings are intentionally omitted.
 */
export function formatStatusWidget(state: StatusDisplayState, sessionTokensSaved: number): string {
  const saved = Number.isFinite(sessionTokensSaved) ? sessionTokensSaved : 0;
  const segments: WidgetSegment[] = [
    { text: `${HEADROOM_GLYPH} Headroom`, bg: WIDGET_COLORS.headroom },
  ];

  // Proxy offline: nothing downstream can be measured (no mode, no savings), so
  // the bar ends at a single red `proxy offline` block.
  if (!state.reachable) {
    segments.push({ text: "proxy offline", bg: WIDGET_COLORS.proxyOff });
    return buildPowerline(segments);
  }

  segments.push({ text: `proxy v${state.version ?? "?"}`, bg: WIDGET_COLORS.proxyOk });

  // Compression switched off (`--headroom-no-compress`): the extension is inert,
  // so say so plainly in red and omit the (now-meaningless) mode + savings blocks.
  if (!state.enabled) {
    segments.push({ text: `${MODE_LABEL} off`, bg: WIDGET_COLORS.proxyOff });
    return buildPowerline(segments);
  }

  if (state.mode) {
    segments.push({ text: `${MODE_LABEL} ${state.mode}`, bg: WIDGET_COLORS.mode });
  }

  segments.push({ text: `${SAVED_EMOJI} ${humanizeTokens(saved)}`, bg: WIDGET_COLORS.saved });

  return buildPowerline(segments);
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
