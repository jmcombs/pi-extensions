/**
 * Steward's above-editor status widget.
 *
 * Built the same way `@jmcombs/pi-headroom`'s is, and for the same reason: Pi's
 * TUI wraps each widget line in a `Text` component that renders ANSI escapes, so
 * raw 24-bit colour plus Nerd-Font Powerline separators display correctly. The
 * palette is Blue PSL 10K / Catppuccin Latte, and the brand block is `#3465a4` —
 * Path Blue, the same blue as Steward's logo tile.
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
  steward: "#3465a4", // Path Blue — the logo tile, always the first block
  running: "#40a02b", // green — the service is up
  stopped: "#d20f39", // red — nothing is holding the port
  models: "#1e66f5", // blue — the model count block
  idle: "#179299", // teal — up, but nothing resident
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
}

/**
 * Join segments into a left-aligned Powerline string: each block is padded text
 * on its background, followed by a `` separator coloured with the block's own
 * background over the next block's, so the triangle fades cleanly into it.
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

/** Resolves the brand mark, honouring an operator override. */
export function resolveGlyph(env: Record<string, string | undefined>): string {
  const override = env.STEWARD_GLYPH;
  return override === undefined ? STEWARD_GLYPH : override.trim();
}

/**
 * The widget for a snapshot, or for no snapshot at all.
 *
 * Blocks: `[ 󱁖 Steward ][ state ][ models ]`. The Steward block is always Path
 * Blue. A machine that was never connected gets one blue block and a pointer at
 * the skill — not a red "stopped", which would be a claim about a machine
 * Steward has never looked at, and wrong on one whose server is running fine.
 *
 * `null` means Steward has not read the machine yet, which is distinct from
 * having read it and found nothing.
 */
export function formatStatusWidget(snapshot: Snapshot | null, glyph: string): string {
  const brand = glyph === "" ? "Steward" : `${glyph} Steward`;
  const segments: WidgetSegment[] = [{ text: brand, bg: WIDGET_COLORS.steward }];

  if (snapshot === null) {
    segments.push({ text: "checking…", bg: WIDGET_COLORS.idle });
    return buildPowerline(segments);
  }

  if (snapshot.drift.launch.status === "unknown" && snapshot.service.port === 0) {
    segments.push({ text: "not connected", bg: WIDGET_COLORS.idle });
    segments.push({ text: "/initialize-steward", bg: WIDGET_COLORS.models });
    return buildPowerline(segments);
  }

  if (!snapshot.service.running) {
    segments.push({ text: "stopped", bg: WIDGET_COLORS.stopped });
    return buildPowerline(segments);
  }

  segments.push({ text: `running :${snapshot.service.port}`, bg: WIDGET_COLORS.running });

  // `active` is serving a request, `resident` is loaded and idle. Both hold
  // weights in memory, which is what the operator is counting. There is no
  // "loaded" status.
  const loaded = snapshot.models.filter(
    (model) => model.status === "active" || model.status === "resident",
  ).length;
  if (snapshot.models.length === 0) {
    segments.push({ text: "no models", bg: WIDGET_COLORS.idle });
  } else if (loaded === 0) {
    segments.push({
      text: `${snapshot.models.length} models · none loaded`,
      bg: WIDGET_COLORS.idle,
    });
  } else {
    segments.push({ text: `${loaded}/${snapshot.models.length} loaded`, bg: WIDGET_COLORS.models });
  }
  return buildPowerline(segments);
}
