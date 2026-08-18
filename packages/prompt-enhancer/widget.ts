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
/**
 * Brand mark: `nf-cod-chevron-right` + `nf-cod-sparkle` — caret and enhance
 * spark, matching the logo. `PROMPT_ENHANCER_GLYPH` replaces the pair; an
 * empty value drops the mark and keeps the wordmark.
 */
export const PROMPT_ENHANCER_GLYPH = "\u{EAB6}\u{EC10}";

const WIDGET_COLORS = {
  fg: "#eff1f5",
  ink: "#1e1e2e",
  brand: "#3465a4", // Path Blue — logo tile
  model: "#1e66f5", // blue — configured model
  missing: "#d20f39", // red — no model
  status: "#179299", // teal — transient feedback
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

/** Resolves the brand mark, honouring an operator override. */
export function resolveGlyph(env: Record<string, string | undefined>): string {
  const override = env.PROMPT_ENHANCER_GLYPH;
  return override === undefined ? PROMPT_ENHANCER_GLYPH : override.trim();
}

export interface WidgetState {
  /** `provider/id` when a model is resolved, else undefined. */
  model?: string;
  /** Soft status (cancelled, enhanced, …). Omitted when idle. */
  status?: string;
}

export function formatStatusWidget(state: WidgetState, glyph: string): string {
  const brand = glyph === "" ? "Prompt Enhancer" : `${glyph} Prompt Enhancer`;
  const segments: WidgetSegment[] = [{ text: brand, bg: WIDGET_COLORS.brand }];

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
