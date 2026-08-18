import { describe, expect, it } from "vitest";
import { looksLikePathToken, shouldSkipAutoEnhance, tokenizeDraft } from "./auto.js";

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
