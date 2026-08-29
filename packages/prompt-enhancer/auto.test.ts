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
    // Whitespace is not content, on either measure.
    expect(tooShortToEnhance("  do \n that  ")).toBe(true);
  });

  it("needs a draft to be short by both measures before refusing it", () => {
    // Short in tokens, long enough in characters: enhanceable.
    expect(tooShortToEnhance("memory leak")).toBe(false);
    // Short in characters, enough tokens: enhanceable.
    expect(tooShortToEnhance("a b c")).toBe(false);
    // Short by both: refused.
    expect(tooShortToEnhance("do it")).toBe(true);
  });

  /**
   * The tokenizer splits on whitespace, and Chinese and Japanese do not write
   * it. A whole request arrives as one token; the character floor is what
   * stops the refusal from making the shortcut useless in those languages.
   */
  it("enhances a CJK request that arrives as a single token", () => {
    // "rewrite this function to support async and add error handling"
    expect(tooShortToEnhance("重写这个函数以支持异步并添加错误处理")).toBe(false);
    // Japanese equivalent.
    expect(tooShortToEnhance("この関数を非同期対応にしてエラー処理を追加して")).toBe(false);
    // Two words in Russian: "fix the leak".
    expect(tooShortToEnhance("исправить утечку")).toBe(false);
  });

  it("enhances the two-word requests the token count alone refused", () => {
    for (const draft of [
      "implement OAuth2",
      "refactor UserServiceImpl",
      "harden getApiKeyAndHeaders",
      "add rate-limiting",
      "memory leak",
      "dockerise everything",
      "explain useEffect",
    ]) {
      expect(tooShortToEnhance(draft)).toBe(false);
    }
  });

  it("exempts a draft that names a path, however short", () => {
    expect(tooShortToEnhance("fix foo.ts")).toBe(false);
    expect(tooShortToEnhance("packages/prompt-enhancer/index.ts")).toBe(false);
    expect(tooShortToEnhance("README.md")).toBe(false);
  });

  /**
   * Chatter this rule knowingly lets through, recorded so a future change
   * knows what it is changing.
   *
   * The three-token ones were never this rule's to catch: the token clause has
   * always let three tokens past, and requiring *both* measures can only
   * narrow what is refused, never widen it.
   *
   * `and/or`, `yes 3/5` and `no w/e` get past on the path exemption, because
   * `looksLikePathToken` counts a bare slash. That is not a path, but the
   * predicate is shared with `shouldSkipAutoEnhance`, and tightening it only
   * here would break the implication proved below — auto-enhance would hand
   * over a draft this rule then refuses out loud. Tightening it in both places
   * is a change to auto-enhance's behaviour and does not belong in this fix.
   *
   * `ok 👨‍👩‍👧‍👦` gets past on the character floor: the count is code points, and one
   * family emoji is seven of them, so two tokens reach nine characters. Every
   * emoji a developer actually types in a draft (✅ ❌ ✓) is a single code point
   * and counts as one; recorded here so the multi-code-point ones are a known
   * hole rather than a discovery.
   */
  it("lets some worthless chatter through, knowingly", () => {
    for (const draft of [
      "ok ok ok",
      "yes sure thanks",
      "thanks a lot",
      "k thx bye",
      "do it now",
      "ok 👍 sure",
      "ok 👨‍👩‍👧‍👦",
      "and/or",
      "yes 3/5",
      "no w/e",
    ]) {
      expect(tooShortToEnhance(draft)).toBe(false);
    }
  });

  /**
   * Drafts that used to be refused and now enhance, because they clear the
   * character floor with two tokens. Both carry a verb or a complaint, which
   * is no less to work with than `memory leak`.
   */
  it("accepts the two-token drafts the character floor now clears", () => {
    expect(tooShortToEnhance("rewrite this")).toBe(false);
    expect(tooShortToEnhance("looks wrong")).toBe(false);
    expect(tooShortToEnhance("looks wrong in widget.ts")).toBe(false);
  });

  /**
   * The invariant the whole design rests on: anything this refuses,
   * auto-enhance already stood down for silently. Break it and an auto run
   * reaches a path that refuses its draft out loud, for a draft the user never
   * asked to enhance.
   *
   * Proved over every draft of up to three tokens drawn from a vocabulary that
   * mixes acknowledgements, real request words, path tokens, a bare slash, CJK
   * and an emoji, plus the empty token that produces runs of whitespace.
   * `shouldSkipAutoEnhance` is called with no options, its strictest form —
   * `lastAssistantAsked` only ever makes it skip more.
   */
  it("never speaks for a draft auto-enhance would have taken on", () => {
    const vocab = [
      "",
      "a",
      "ok",
      "yes",
      "thx",
      "ship",
      "it",
      "do",
      "that",
      "fix",
      "the",
      "readme",
      "link",
      "rate-limiting",
      "OAuth2",
      "исправить",
      "重写这个函数以支持异步",
      "👍",
      "foo.ts",
      "packages/x",
      "and/or",
      "w/e",
    ];
    const drafts: string[] = [];
    for (const a of vocab) {
      drafts.push(a);
      for (const b of vocab) {
        drafts.push(`${a} ${b}`);
        for (const c of vocab) drafts.push(`${a} ${b} ${c}`);
      }
    }

    let refused = 0;
    for (const draft of drafts) {
      if (!tooShortToEnhance(draft)) continue;
      refused += 1;
      expect(shouldSkipAutoEnhance(draft)).toBe(true);
    }

    // Not vacuous, and the corpus is the size the claim is made over.
    expect(drafts.length).toBeGreaterThan(9826);
    expect(refused).toBeGreaterThan(100);
  });
});
