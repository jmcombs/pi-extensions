import { describe, expect, it } from "vitest";
import {
  ENHANCING_SEGMENT,
  formatStatusWidget,
  PROMPT_ENHANCER_GLYPH,
  type WidgetState,
} from "./widget.js";

const BG = {
  brand: "48;2;52;101;164", // #3465a4
  model: "48;2;30;102;245", // #1e66f5
  missing: "48;2;210;15;57", // #d20f39
  auto: "48;2;47;125;32", // #2f7d20
  status: "48;2;23;146;153", // #179299
  enhancing: "48;2;223;142;29", // #df8e1d
};
const INK_FG = "38;2;30;30;46"; // #1e1e2e
const ARROW = "\u{E0B0}";
const RESET = "\x1b[0m";

const base: WidgetState = { model: "anthropic/claude-sonnet-4" };

describe("formatStatusWidget", () => {
  it("renders brand + model blocks with powerline separators", () => {
    const out = formatStatusWidget(base);
    expect(out).toContain(`${PROMPT_ENHANCER_GLYPH} Prompt Enhancer`);
    expect(out).toContain("anthropic/claude-sonnet-4");
    expect(out).toContain(ARROW);
    expect(out).toContain(BG.brand);
    expect(out).toContain(BG.model);
    expect(out.endsWith(RESET)).toBe(true);
  });

  it("keeps the brand block Path Blue with or without a model", () => {
    expect(formatStatusWidget(base)).toContain(BG.brand);
    expect(formatStatusWidget({})).toContain(BG.brand);
  });

  it("shows a red no-model block when no model is resolved", () => {
    const out = formatStatusWidget({});
    expect(out).toContain("no model");
    expect(out).toContain(BG.missing);
    expect(out).not.toContain(BG.model);
  });

  it("appends a teal status block only when status is set", () => {
    const idle = formatStatusWidget(base);
    const busy = formatStatusWidget({
      ...base,
      status: "Enhanced. Ctrl+Shift+Z to revert.",
    });
    expect(idle).not.toContain(BG.status);
    expect(busy).toContain("Enhanced. Ctrl+Shift+Z to revert.");
    expect(busy).toContain(BG.status);
  });

  it("inserts a yellow enhancing block only while a rewrite is in flight", () => {
    const idle = formatStatusWidget(base);
    const busy = formatStatusWidget({ ...base, enhancing: true });
    expect(idle).not.toContain(BG.enhancing);
    expect(idle).not.toContain(ENHANCING_SEGMENT);
    expect(busy).toContain(ENHANCING_SEGMENT);
    expect(busy).toContain(BG.enhancing);
    // Dark ink: the light foreground the other blocks use is unreadable on it.
    expect(busy).toContain(INK_FG);
  });

  it("puts the enhancing block first, where nothing can push it off the line", () => {
    const busy = formatStatusWidget({ ...base, auto: true, enhancing: true, status: "working" });
    const at = (needle: string) => busy.indexOf(needle);
    expect(at(ENHANCING_SEGMENT)).toBeGreaterThan(at("Prompt Enhancer"));
    expect(at(ENHANCING_SEGMENT)).toBeLessThan(at(" auto "));
    expect(at(ENHANCING_SEGMENT)).toBeLessThan(at(base.model as string));
  });

  it("inserts a green auto block only when auto-enhance is armed", () => {
    const off = formatStatusWidget(base);
    const on = formatStatusWidget({ ...base, auto: true });
    expect(off).not.toContain(BG.auto);
    expect(on).toContain(BG.auto);
    expect(on).toContain("auto");
  });
});
