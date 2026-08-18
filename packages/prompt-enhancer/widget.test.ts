import { describe, expect, it } from "vitest";
import {
  formatStatusWidget,
  PROMPT_ENHANCER_GLYPH,
  resolveGlyph,
  type WidgetState,
} from "./widget.js";

const BG = {
  brand: "48;2;52;101;164", // #3465a4
  model: "48;2;30;102;245", // #1e66f5
  missing: "48;2;210;15;57", // #d20f39
  status: "48;2;23;146;153", // #179299
};
const ARROW = "\u{E0B0}";
const RESET = "\x1b[0m";

const base: WidgetState = { model: "anthropic/claude-sonnet-4" };

describe("formatStatusWidget", () => {
  it("renders brand + model blocks with powerline separators", () => {
    const out = formatStatusWidget(base, PROMPT_ENHANCER_GLYPH);
    expect(out).toContain(`${PROMPT_ENHANCER_GLYPH} Prompt Enhancer`);
    expect(out).toContain("anthropic/claude-sonnet-4");
    expect(out).toContain(ARROW);
    expect(out).toContain(BG.brand);
    expect(out).toContain(BG.model);
    expect(out.endsWith(RESET)).toBe(true);
  });

  it("keeps the brand block Path Blue with or without a model", () => {
    const on = formatStatusWidget(base, PROMPT_ENHANCER_GLYPH);
    const off = formatStatusWidget({}, PROMPT_ENHANCER_GLYPH);
    expect(on).toContain(BG.brand);
    expect(off).toContain(BG.brand);
  });

  it("shows a red no-model block when no model is resolved", () => {
    const out = formatStatusWidget({}, PROMPT_ENHANCER_GLYPH);
    expect(out).toContain("no model");
    expect(out).toContain(BG.missing);
    expect(out).not.toContain(BG.model);
  });

  it("appends a teal status block only when status is set", () => {
    const idle = formatStatusWidget(base, PROMPT_ENHANCER_GLYPH);
    const busy = formatStatusWidget(
      { ...base, status: "Enhanced — Ctrl+Shift+Z to revert." },
      PROMPT_ENHANCER_GLYPH,
    );
    expect(idle).not.toContain(BG.status);
    expect(busy).toContain("Enhanced — Ctrl+Shift+Z to revert.");
    expect(busy).toContain(BG.status);
  });

  it("drops the glyph and keeps the wordmark when the mark is empty", () => {
    const out = formatStatusWidget(base, "");
    expect(out).toContain("Prompt Enhancer");
    expect(out).not.toContain(PROMPT_ENHANCER_GLYPH);
  });
});

describe("resolveGlyph", () => {
  it("defaults to the chevron + sparkle mark", () => {
    expect(resolveGlyph({})).toBe(PROMPT_ENHANCER_GLYPH);
    expect(PROMPT_ENHANCER_GLYPH).toBe("\u{EAB6} \u{EC10}");
  });

  it("honours PROMPT_ENHANCER_GLYPH, including an empty override", () => {
    expect(resolveGlyph({ PROMPT_ENHANCER_GLYPH: "x" })).toBe("x");
    expect(resolveGlyph({ PROMPT_ENHANCER_GLYPH: "  " })).toBe("");
  });
});
