/**
 * Prompt Enhancer above-editor status widget.
 *
 * Same Powerline construction as Steward and Headroom: Pi wraps each widget
 * line in a `Text` component that renders ANSI, so 24-bit colour plus Nerd-Font
 * separators display correctly. Brand block is Path Blue `#3465a4`.
 *
 * Pure string building. No I/O, never throws.
 */

const ESC = "\x1b";
/** Powerline solid right-pointing separator (Nerd Font). */
const ARROW_RIGHT = "\u{E0B0}";
/** Brand mark: `nf-cod-chevron-right` + `nf-cod-sparkle`. */
export const PROMPT_ENHANCER_GLYPH = "\u{EAB6}\u{EC10}";

/** The in-flight block's text. Exported so tests assert one spelling. */
export const ENHANCING_SEGMENT = "enhancing\u2026";

const WIDGET_COLORS = {
  fg: "#eff1f5",
  ink: "#1e1e2e",
  brand: "#3465a4", // Path Blue — logo tile
  model: "#1e66f5", // blue — configured model
  missing: "#d20f39", // red — no model
  auto: "#2f7d20", // green — auto-enhance on Enter is armed
  status: "#179299", // teal — transient feedback
  enhancing: "#df8e1d", // yellow — a rewrite is in flight
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
  fg?: string;
}

function buildPowerline(segments: readonly WidgetSegment[]): string {
  let out = "";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    const ink = seg.fg ?? WIDGET_COLORS.fg;
    out += `${bgCode(seg.bg)}${fgCode(ink)} ${seg.text} `;
    const next = segments[i + 1];
    out +=
      next !== undefined
        ? `${fgCode(seg.bg)}${bgCode(next.bg)}${ARROW_RIGHT}`
        : `${RESET}${fgCode(seg.bg)}${ARROW_RIGHT}${RESET}`;
  }
  return out;
}

export interface WidgetState {
  /** True while a rewrite is in flight. */
  enhancing?: boolean;
  /** `provider/id` when a model is resolved, else undefined. */
  model?: string;
  /** When true, Enter will try to enhance before sending. */
  auto?: boolean;
  /** Soft status (cancelled, enhanced, …). Omitted when idle. */
  status?: string;
}

export function formatStatusWidget(state: WidgetState): string {
  const brand = `${PROMPT_ENHANCER_GLYPH} Prompt Enhancer`;
  const segments: WidgetSegment[] = [{ text: brand, bg: WIDGET_COLORS.brand }];

  // Directly after the brand block, where nothing else can push it off the
  // line: while a rewrite is in flight the widget must say so. `ink` rather
  // than the usual light `fg` because the light one is unreadable on yellow.
  if (state.enhancing === true) {
    segments.push({
      text: ENHANCING_SEGMENT,
      bg: WIDGET_COLORS.enhancing,
      fg: WIDGET_COLORS.ink,
    });
  }

  if (state.auto === true) {
    segments.push({ text: "auto", bg: WIDGET_COLORS.auto });
  }

  if (state.model === undefined) {
    segments.push({ text: "no model", bg: WIDGET_COLORS.missing });
  } else {
    segments.push({ text: state.model, bg: WIDGET_COLORS.model });
  }

  if (state.status !== undefined && state.status.length > 0) {
    segments.push({ text: state.status, bg: WIDGET_COLORS.status });
  }

  return buildPowerline(segments);
}
