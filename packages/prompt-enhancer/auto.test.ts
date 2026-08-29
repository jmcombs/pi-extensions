import { describe, expect, it } from "vitest";
import {
  looksLikePathToken,
  shouldSkipAutoEnhance,
  tokenizeDraft,
  tooShortToEnhance,
} from "./auto.js";

describe("shouldSkipAutoEnhance", () => {
  it("skips empty and tiny acknowledgements without a word list", () => {
    expect(shouldSkipAutoEnhance("")).toBe(true);
    expect(shouldSkipAutoEnhance("   ")).toBe(true);
    expect(shouldSkipAutoEnhance("ok")).toBe(true);
    expect(shouldSkipAutoEnhance("yes")).toBe(true);
    expect(shouldSkipAutoEnhance("approved")).toBe(true);
    expect(shouldSkipAutoEnhance("denied")).toBe(true);
    expect(shouldSkipAutoEnhance("ship it")).toBe(true);
  });

  it("does not skip a real request, even when short-ish", () => {
    expect(shouldSkipAutoEnhance("fix the widget tests")).toBe(false);
    expect(shouldSkipAutoEnhance("please add logging to the enhancer")).toBe(false);
  });

  it("does not skip a short draft that names a path", () => {
    expect(shouldSkipAutoEnhance("fix foo.ts")).toBe(false);
    expect(shouldSkipAutoEnhance("packages/prompt-enhancer/index.ts")).toBe(false);
  });

  it("skips a short single-line reply to a question", () => {
    expect(shouldSkipAutoEnhance("the second one", { lastAssistantAsked: true })).toBe(true);
    expect(
      shouldSkipAutoEnhance("rewrite the model picker so it matches /model exactly", {
        lastAssistantAsked: true,
      }),
    ).toBe(false);
  });
});

describe("tokenizeDraft / looksLikePathToken", () => {
  it("splits on whitespace", () => {
    expect(tokenizeDraft("  ship   it ")).toEqual(["ship", "it"]);
  });

  it("treats slashes and file extensions as paths", () => {
    expect(looksLikePathToken("foo.ts")).toBe(true);
    expect(looksLikePathToken("packages/x")).toBe(true);
    expect(looksLikePathToken("approved")).toBe(false);
  });
});

describe("tooShortToEnhance", () => {
  it("refuses drafts with nothing in them to work with", () => {
    expect(tooShortToEnhance("")).toBe(true);
    expect(tooShortToEnhance("   ")).toBe(true);
    expect(tooShortToEnhance("ok")).toBe(true);
    expect(tooShortToEnhance("ship it")).toBe(true);
    expect(tooShortToEnhance("do that")).toBe(true);
  });

  it("sits the boundary at three tokens", () => {
    expect(tooShortToEnhance("rewrite this")).toBe(true);
    expect(tooShortToEnhance("rewrite this properly")).toBe(false);
    // Whitespace is not content: the count is of tokens, not of characters.
    expect(tooShortToEnhance("  rewrite \n this  ")).toBe(true);
    expect(tooShortToEnhance("a b c")).toBe(false);
  });

  it("exempts a draft that names a path, however short", () => {
    expect(tooShortToEnhance("fix foo.ts")).toBe(false);
    expect(tooShortToEnhance("packages/prompt-enhancer/index.ts")).toBe(false);
    expect(tooShortToEnhance("README.md")).toBe(false);
  });

  it("is shape, not a word list: a two-word draft naming nothing is refused", () => {
    // Nothing here is on a list; both are refused for having two tokens and
    // no path, and both would be accepted the moment a file joins them.
    expect(tooShortToEnhance("looks wrong")).toBe(true);
    expect(tooShortToEnhance("looks wrong in widget.ts")).toBe(false);
  });

  it("never speaks for a draft auto-enhance would have taken on", () => {
    // The two thresholds agree by construction. If this ever fails, auto has
    // started handing drafts to a path that would refuse them.
    for (const draft of ["ok", "ship it", "fix foo.ts", "fix the readme link", "yes please now"]) {
      if (tooShortToEnhance(draft)) expect(shouldSkipAutoEnhance(draft)).toBe(true);
    }
  });
});
