/**
 * @jmcombs/pi-headroom — whole-conversation compression (LD1, LD3, LD8).
 *
 * `compressMessages` is the single entry point the `context` hook calls. It
 * drops `role: "system"` messages before `compress()`, then reinserts the
 * original system message objects afterward. Pi conversations are converted
 * to OpenAI via `compressPayload` → `piToOpenAI`; non-Pi conversations pass
 * the kept messages through. If the proxy did not compress, the swap is not
 * 1:1 alignable (`null`), or any error is thrown, it passes the **original**
 * messages through with `tokensSaved: 0`.
 *
 * Every path is wrapped in `try/catch` and **never throws** (LD3).
 */

import { compress, type OpenAIMessage } from "headroom-ai";
import {
  applyCompressedText,
  isPiFormat,
  type PiMessage,
  piToOpenAI,
  reinsertSystemMessages,
  splitSystemMessages,
} from "./pi-format.js";

export interface CompressMessagesOptions {
  /** Model id used by the proxy for tokenization (optional). */
  model?: string;
  /** Proxy base URL (optional; the SDK default applies otherwise). */
  baseUrl?: string;
  /** Proxy API key (optional). */
  apiKey?: string;
}

export interface CompressMessagesResult {
  /** Compressed messages in the **same** (Pi or non-Pi) format as the input. */
  messages: PiMessage[];
  /** Tokens saved by this call; `0` on passthrough, fallback, or any failure. */
  tokensSaved: number;
}

/** Clamp the proxy's `tokensSaved` to a non-negative finite number. */
function normalizeSaved(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Build the payload handed to `compress()`. Synchronous and pure: drops
 * `role: "system"` messages, then converts Pi conversations to OpenAI.
 */
export function compressPayload(messages: readonly PiMessage[]): OpenAIMessage[] | PiMessage[] {
  const { kept } = splitSystemMessages(messages);
  if (isPiFormat(messages)) return piToOpenAI(kept);
  return kept;
}

/**
 * Compress a conversation, preserving its format. System messages are stripped
 * before `compress()` and spliced back afterward. Returns the original messages
 * unchanged with `tokensSaved: 0` on any passthrough or failure — and never
 * throws (LD3).
 */
export async function compressMessages(
  messages: readonly PiMessage[],
  options: CompressMessagesOptions = {},
): Promise<CompressMessagesResult> {
  const original = messages as PiMessage[];

  try {
    const compressOptions = {
      model: options.model,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      fallback: true,
    };

    const { kept, removed } = splitSystemMessages(messages);
    const result = await compress(compressPayload(messages), compressOptions);

    // Proxy down / nothing compressed (fallback returned input) → passthrough.
    if (!result.compressed) return { messages: original, tokensSaved: 0 };

    if (isPiFormat(messages)) {
      const swapped = applyCompressedText(kept, result.messages as OpenAIMessage[]);
      if (swapped === null || swapped.length !== kept.length) {
        return { messages: original, tokensSaved: 0 };
      }

      return {
        messages: reinsertSystemMessages(swapped, removed),
        tokensSaved: normalizeSaved(result.tokensSaved),
      };
    }

    return {
      messages: reinsertSystemMessages(result.messages as PiMessage[], removed),
      tokensSaved: normalizeSaved(result.tokensSaved),
    };
  } catch {
    // Never throw into the agent loop (LD3).
    return { messages: original, tokensSaved: 0 };
  }
}
