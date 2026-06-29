import { describe, expect, it } from "vitest";
import { formatStatusWidget, type StatusDisplayState } from "./status.js";

// 24-bit ANSI background codes for the block colors (must match status.ts).
const BG = {
  headroom: "48;2;52;101;164", // #3465a4 Path/logo blue (brand block, always)
  proxyOk: "48;2;64;160;43", // #40a02b green (proxy reachable)
  proxyOff: "48;2;210;15;57", // #d20f39 red (proxy unreachable)
  mode: "48;2;30;102;245", // #1e66f5 blue (thinking-level blue)
  saved: "48;2;23;146;153", // #179299 teal
};
const GLYPH = "\u{F0623}";
const ARROW = "";
const RESET = "\x1b[0m";

const base: StatusDisplayState = {
  enabled: true,
  reachable: true,
  version: "0.27.0",
  mode: "token",
};

describe("formatStatusWidget", () => {
  it("renders Headroom + green proxy + mode + saved blocks with powerline separators", () => {
    const out = formatStatusWidget(base, 56_100);
    expect(out).toContain(`${GLYPH} Headroom`);
    expect(out).toContain("proxy v0.27.0");
    expect(out).toContain("mode: token");
    expect(out).toContain("💾 56.1k");
    expect(out).toContain(ARROW); // at least one separator
    expect(out).toContain(BG.headroom); // Headroom is always the logo blue
    expect(out).toContain(BG.proxyOk); // reachable → green proxy block
    expect(out).toContain(BG.mode);
    expect(out).toContain(BG.saved);
    expect(out.endsWith(RESET)).toBe(true); // terminates cleanly
  });

  it("keeps the Headroom block logo-blue regardless of the enabled flag", () => {
    const on = formatStatusWidget(base, 0);
    const off = formatStatusWidget({ ...base, enabled: false }, 0);
    expect(on).toContain(BG.headroom);
    expect(off).toContain(BG.headroom);
  });

  it("shows a red 'mode: off' block (no live mode, no savings) when compression is disabled", () => {
    const out = formatStatusWidget({ ...base, enabled: false }, 56_100);
    expect(out).toContain("mode: off");
    expect(out).toContain(BG.proxyOff); // off block reuses the red
    expect(out).toContain("proxy v0.27.0"); // proxy is still reported
    expect(out).toContain(BG.proxyOk);
    expect(out).not.toContain("mode: token"); // not the live proxy mode
    expect(out).not.toContain(BG.mode); // not the blue live-mode block
    expect(out).not.toContain("💾"); // savings dropped when off
    expect(out).not.toContain(BG.saved);
  });

  it("shows only a red 'proxy offline' block (no version/mode/savings) when unreachable", () => {
    const out = formatStatusWidget({ enabled: true, reachable: false }, 8_800);
    expect(out).toContain("proxy offline");
    expect(out).toContain(BG.proxyOff);
    expect(out).not.toContain("proxy v");
    expect(out).not.toContain(BG.proxyOk);
    expect(out).not.toContain(BG.mode);
    expect(out).not.toContain("💾"); // nothing measurable with the proxy down
    expect(out).not.toContain(BG.saved);
  });

  it("prefixes the version with 'proxy v' and shows '?' when version is missing", () => {
    const out = formatStatusWidget({ enabled: true, reachable: true }, 0);
    expect(out).toContain("proxy v?");
  });

  it("omits the mode block when the proxy reports no mode", () => {
    const out = formatStatusWidget({ enabled: true, reachable: true, version: "0.27.0" }, 100);
    expect(out).not.toContain(BG.mode);
    expect(out).toContain(BG.proxyOk);
  });
});
