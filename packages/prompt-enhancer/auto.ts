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
 * Below this many tokens a draft carries nothing to rewrite.
 *
 * Three is where a request starts being one: an action and something to act
 * on, with enough left over to say which one ("fix the readme link"). Two or
 * fewer is an acknowledgement or a fragment — "ok", "ship it", "do that" —
 * and a rewrite of it is invention, not enhancement.
 */
const MIN_ENHANCEABLE_TOKENS = 3;

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
 * that happens to say something. A path-like token is the exemption — `fix
 * foo.ts` names a file, which is a task however few words surround it.
 *
 * The threshold matches the tiny-draft clause of `shouldSkipAutoEnhance` on
 * purpose: the same shape of draft is unenhanceable whichever way the run was
 * started. They stay separate functions because they answer different
 * questions — auto asks whether to stand aside on this turn, this asks whether
 * the model has anything to work with — and only one of them may ever speak up
 * about it. Auto-enhance stands down silently and never reaches this.
 */
export function tooShortToEnhance(text: string): boolean {
  const words = tokenizeDraft(text);
  if (words.length >= MIN_ENHANCEABLE_TOKENS) return false;
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
