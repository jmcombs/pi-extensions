/**
 * Steward's above-editor status widget.
 *
 * Built the same way `@jmcombs/pi-headroom`'s is, and for the same reason: Pi's
 * TUI wraps each widget line in a `Text` component that renders ANSI escapes, so
 * raw 24-bit colour plus Nerd-Font Powerline separators display correctly. The
 * palette is Blue PSL 10K / Catppuccin Latte, and the brand block is `#3465a4` —
 * Path Blue, the same blue as Steward's logo tile.
 *
 * **The subject is Steward, not llama.cpp.** An earlier version reported the
 * inference server's state, so `/steward_stop` left a widget still reading
 * "running :8091" — describing something the operator had not stopped. The state
 * block now says whether the dashboard is up; llama.cpp rides along as detail,
 * which is where it belongs on a widget carrying Steward's name.
 *
 * Exactly three state colours, by design: green started, red stopped, orange
 * something is wrong and needs a person.
 *
 * Pure string building. No I/O, never throws.
 *
 * Keep this module free of Node and DOM APIs — see `./types.ts`.
 */

import type { Snapshot } from "./types.js";

const ESC = "\x1b";
/** Powerline solid right-pointing separator (Nerd Font). */
const ARROW_RIGHT = "\u{E0B0}";
/**
 * Brand mark: `nf-md-room-service` — the service bell, a dome over a base with
 * the tap-button on top, echoing the logo's arc over rounded bars.
 * `STEWARD_GLYPH` replaces it for an operator who has patched their own mark in;
 * an empty value drops it.
 */
export const STEWARD_GLYPH = "\u{F088D}";

const WIDGET_COLORS = {
  fg: "#eff1f5",
  /**
   * Dark ink for the light backgrounds. Near-white on orange is 2.64:1 — the
   * state that most needs reading was the hardest to read — and on green 2.96:1.
   * Dark lifts them to 5.50 and 4.91. Powerline convention agrees: dark text on
   * warm accents.
   */
  ink: "#1e1e2e",
  /** Neither green, blue nor orange: llama has not been read yet. */
  unknown: "#9ca0b0",
  brand: "#3465a4", // Path Blue — the logo tile, always the first block
  started: "#40a02b", // green
  stopped: "#d20f39", // red
  error: "#fe640b", // orange — up, but something needs a person
  detail: "#1e66f5", // blue — llama.cpp detail, never a state
} as const;

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const fgCode = (hex: string): string => {
  const [r, g, b] = hexToRgb(hex);
  return `${ESC}[38;2;${r};${g};${b}m`;
};

const bgCode = (hex: string): string => {
  const [r, g, b] = hexToRgb(hex);
  return `${ESC}[48;2;${r};${g};${b}m`;
};

const RESET = `${ESC}[0m`;

interface WidgetSegment {
  text: string;
  bg: string;
  /** Ink for this block. Defaults to the light foreground. */
  fg?: string;
}

/** Backgrounds too light to carry near-white text. */
const DARK_INK_ON = new Set<string>([WIDGET_COLORS.error, WIDGET_COLORS.started]);

/** Join segments into a left-aligned Powerline string. */
function buildPowerline(segments: readonly WidgetSegment[]): string {
  let out = "";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    const ink = seg.fg ?? (DARK_INK_ON.has(seg.bg) ? WIDGET_COLORS.ink : WIDGET_COLORS.fg);
    out += `${bgCode(seg.bg)}${fgCode(ink)} ${seg.text} `;
    const next = segments[i + 1];
    out +=
      next !== undefined
        ? `${fgCode(seg.bg)}${bgCode(next.bg)}${ARROW_RIGHT}`
        : `${RESET}${fgCode(seg.bg)}${ARROW_RIGHT}${RESET}`;
  }
  return out;
}

/** Resolves the brand mark, honouring an operator override. */
export function resolveGlyph(env: Record<string, string | undefined>): string {
  const override = env.STEWARD_GLYPH;
  return override === undefined ? STEWARD_GLYPH : override.trim();
}

/** Everything the widget needs. All of it is already known to the extension. */
export interface WidgetState {
  /** The dashboard's URL when it is serving, else `null`. Steward's own state. */
  portalUrl: string | null;
  /** The machine as last read, or `null` when it has not been read yet. */
  snapshot: Snapshot | null;
  /**
   * Where Pi's llama.cpp provider points, and where Steward was told to look.
   * When both are set and differ, the operator has a router Pi cannot use — a
   * dashboard reporting green while chat fails. That is the failure the orange
   * state exists for.
   */
  providerBaseUrl: string | null;
  stewardBaseUrl: string | null;
}

/** Hosts that mean "this machine", where naming the host says nothing. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/**
 * `:port` on loopback, `host:port` anywhere else — the same rule for Steward and
 * for llama.cpp, which is what actually makes the two blocks consistent. They
 * used to format addresses by two different rules.
 *
 * The host is not dropped, only elided when it carries no information. A bare
 * `:8788` for a remote host would be a plausible-looking wrong value; a host
 * appearing at all is the signal that this is not the usual machine.
 */
function formatAddress(host: string, port: number | string): string {
  return LOOPBACK.has(host) ? `:${port}` : `${host}:${port}`;
}

/** The same, from a URL. Falls back to the raw string when it will not parse. */
function formatUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return formatAddress(parsed.hostname, parsed.port);
  } catch {
    return url;
  }
}

export function formatStatusWidget(state: WidgetState, glyph: string): string {
  const brand = glyph === "" ? "Steward" : `${glyph} Steward`;
  const segments: WidgetSegment[] = [{ text: brand, bg: WIDGET_COLORS.brand }];

  // Steward itself first: the question this widget's name promises to answer.
  // It needs no probe — the extension holds the server.
  if (state.portalUrl === null) {
    segments.push({ text: "stopped", bg: WIDGET_COLORS.stopped });
    return buildPowerline(segments);
  }

  const here = formatUrl(state.portalUrl);

  // A router Pi cannot reach is an error even when everything Steward owns is
  // healthy: the dashboard goes green while chat fails.
  //
  // ONE block, not two. Two adjacent blocks of the same colour drew their
  // separator as orange-on-orange — an invisible arrow and an unexplained gap
  // where the two fused into a single wide band.
  if (
    state.providerBaseUrl !== null &&
    state.stewardBaseUrl !== null &&
    state.providerBaseUrl !== state.stewardBaseUrl
  ) {
    segments.push({
      text: `${here} \u{2260} pi ${formatUrl(state.providerBaseUrl)}`,
      bg: WIDGET_COLORS.error,
    });
    return buildPowerline(segments);
  }

  // Same reason as the mismatch block: two adjacent orange blocks would draw an
  // invisible separator and fuse into one band anyway. Say it in one.
  if (state.snapshot !== null && !state.snapshot.service.running) {
    segments.push({ text: `${here} \u{B7} llama stopped`, bg: WIDGET_COLORS.error });
    return buildPowerline(segments);
  }
  segments.push({ text: here, bg: WIDGET_COLORS.started });

  // Not yet read is its own state. Ending the bar here would look exactly like a
  // healthy one with its tail cut off, which the eye reads as "fine".
  if (state.snapshot === null) {
    segments.push({ text: "llama \u{2014}", bg: WIDGET_COLORS.unknown });
    return buildPowerline(segments);
  }

  // `active` is serving a request, `resident` is loaded and idle. Both hold
  // weights in memory, which is what the operator is counting.
  const models = state.snapshot.models;
  const loaded = models.filter((m) => m.status === "active" || m.status === "resident").length;
  const where = formatAddress(state.snapshot.service.host, state.snapshot.service.port);
  const detail =
    models.length === 0 ? `llama ${where}` : `llama ${where} \u{B7} ${loaded}/${models.length}`;
  segments.push({ text: detail, bg: WIDGET_COLORS.detail });
  return buildPowerline(segments);
}
