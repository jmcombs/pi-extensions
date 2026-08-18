/**
 * Decide whether auto-enhance should stand down for this draft.
 *
 * No vocabulary list — those rot. We classify the *shape* of the turn:
 * tiny drafts, short single-line chatter, or a short reply to a question.
 * A path-like token is treated as a task, even when the draft is short.
 * Explicit `/prompt_enhance` / Ctrl+Shift+E never consults this.
 */

const REPLY_WORD_LIMIT = 6;

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
