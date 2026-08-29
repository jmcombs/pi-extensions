/**
 * Decide whether auto-enhance should stand down for this draft.
 *
 * No vocabulary list — those rot. We classify the *shape* of the turn:
 * tiny drafts, short single-line chatter, or a short reply to a question.
 * A path-like token is treated as a task, even when the draft is short.
 * Explicit `/prompt_enhance` / Ctrl+Shift+E never consults this.
 */

const REPLY_WORD_LIMIT = 6;

/**
 * Below this many tokens a draft *may* carry nothing to rewrite.
 *
 * Three is where a request starts being one in a space-separated language: an
 * action and something to act on, with enough left over to say which one
 * ("fix the readme link"). Two or fewer is often an acknowledgement or a
 * fragment — "ok", "ship it", "do that".
 *
 * Only ever half the answer. See `MIN_ENHANCEABLE_CHARS`.
 */
const MIN_ENHANCEABLE_TOKENS = 3;

/**
 * ...and below this many characters as well, before a draft is refused.
 *
 * A token count alone is a count of spaces, and Chinese and Japanese do not
 * write them: 重写这个函数以支持异步并添加错误处理 — a whole request — is one
 * token, and refusing it made the explicit shortcut useless in those
 * languages. It also refused plenty of English: `implement OAuth2`,
 * `refactor UserServiceImpl`, `add rate-limiting`, `memory leak`. Two words
 * is not the same as two words' worth of content.
 *
 * So both measures have to agree before we refuse. Counting content characters
 * — whitespace stripped, so padding a draft with spaces cannot buy its way
 * past the floor — the evidence leaves a band: the longest acknowledgement
 * that must stay refused is six ("ship it", "do that"), and the shortest
 * genuine two-token request is ten ("memory leak"). Eight sits in the middle
 * with a margin either side rather than flush against either, and every real
 * request collected clears it comfortably — `implement OAuth2` at 15, a
 * two-word Russian request at 15, the CJK sentences at 18 and 23.
 *
 * Where the band left a choice, permissive won. This gate fires only on the
 * explicit shortcut, where the user has already decided they want the call: a
 * wrong refusal blocks work and has no override, a wrong acceptance costs one
 * call they asked for.
 *
 * Counted in code points rather than UTF-16 units, so anything outside the BMP
 * counts once instead of twice and a surrogate pair cannot buy its way past the
 * floor. It is a count of code points and not of what a reader would call
 * characters: an emoji drawn as a single glyph is often several code points — a
 * family 👨‍👩‍👧‍👦 is seven, a flag two, a keycap three — so `ok 👨‍👩‍👧‍👦` counts nine and clears a
 * floor that `ok` alone is refused by.
 *
 * Left that way on purpose. The marks that actually turn up in developer drafts
 * (✅ ❌ ✓) are one code point each and already count as one, and a two-word
 * draft padded to length with a family emoji is not something anyone types.
 */
const MIN_ENHANCEABLE_CHARS = 8;

const PATHISH = /\/|\.[A-Za-z][A-Za-z0-9]{0,7}$/;

export interface AutoEnhanceSkipOptions {
  /** True when the last assistant message asked a question. */
  lastAssistantAsked?: boolean;
}

export function tokenizeDraft(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

export function looksLikePathToken(token: string): boolean {
  return PATHISH.test(token);
}

/**
 * Is there too little here to enhance at all?
 *
 * Shape, not vocabulary, for the same reason as everything else in this file:
 * a word list of acknowledgements rots, and it would refuse a two-word draft
 * that happens to say something. Two measures of shape, and a draft has to be
 * short by *both* — few tokens and few characters — before it is refused. A
 * path-like token is the exemption on top of that: `fix foo.ts` names a file,
 * which is a task however few words surround it.
 *
 * Refusing on the token count alone was the bug this pair replaces; the
 * reasoning is on the two constants above.
 *
 * Deliberately weaker than the tiny-draft clause of `shouldSkipAutoEnhance`,
 * and it has to stay that way: everything this refuses, auto-enhance must
 * already have stood down for, or an auto run reaches a path that would refuse
 * its draft and say so out loud. That holds by construction — every refusal
 * here has two tokens or fewer and no path token, which is exactly that
 * clause — and by the generated proof in `auto.test.ts`.
 *
 * They stay separate functions because they answer different questions: auto
 * asks whether to stand aside on this turn, this asks whether the model has
 * anything to work with, and only one of them may ever speak up about it.
 * Auto-enhance stands down silently and never reaches this.
 */
export function tooShortToEnhance(text: string): boolean {
  const words = tokenizeDraft(text);
  if (words.length >= MIN_ENHANCEABLE_TOKENS) return false;
  if ([...words.join("")].length >= MIN_ENHANCEABLE_CHARS) return false;
  return !words.some(looksLikePathToken);
}

export function shouldSkipAutoEnhance(text: string, options: AutoEnhanceSkipOptions = {}): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;

  const words = tokenizeDraft(trimmed);
  const hasPath = words.some(looksLikePathToken);

  // "ok", "yes", "approved", "ship it" — two tokens or fewer, no path.
  if (words.length <= 2 && !hasPath) return true;

  // Answering the agent: keep it short and single-line.
  if (
    options.lastAssistantAsked === true &&
    !trimmed.includes("\n") &&
    words.length <= REPLY_WORD_LIMIT &&
    !hasPath
  ) {
    return true;
  }

  return false;
}
