/**
 * @jmcombs/pi-headroom — whole-conversation compression (LD1, LD3, LD8).
 *
 * `compressMessages` is the single entry point the `context` hook calls. It:
 *
 *   - For **Pi** input (`isPiFormat`): converts to OpenAI via `piToOpenAI`,
 *     compresses with `fallback: true`, then swaps the compressed text back onto
 *     the original Pi messages with `applyCompressedText`. If the proxy did not
 *     compress, the swap is not 1:1 alignable (`null`), or the count differs, it
 *     passes the **original** messages through with `tokensSaved: 0`.
 *   - For **non-Pi** input: plain `compress({ fallback: true })`.
 *
 * Every path is wrapped in `try/catch` and **never throws** (LD3); on any error
 * or passthrough it returns the original messages and `tokensSaved: 0`.
 */

import { compress, type OpenAIMessage } from "headroom-ai";
import { applyCompressedText, isPiFormat, type PiMessage, piToOpenAI } from "./pi-format.js";

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
 * Compress a conversation, preserving its format. Pi conversations are converted
 * to OpenAI, compressed, and swapped back in place (LD8); non-Pi conversations
 * are compressed directly. Returns the original messages unchanged with
 * `tokensSaved: 0` on any passthrough or failure — and never throws (LD3).
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

    if (isPiFormat(messages)) {
      const openAIMessages = piToOpenAI(messages);
      const result = await compress(openAIMessages, compressOptions);

      // Proxy down / nothing compressed (fallback returned input) → passthrough.
      if (!result.compressed) return { messages: original, tokensSaved: 0 };

      const swapped = applyCompressedText(messages, result.messages as OpenAIMessage[]);
      if (swapped === null || swapped.length !== messages.length) {
        return { messages: original, tokensSaved: 0 };
      }

      return { messages: swapped, tokensSaved: normalizeSaved(result.tokensSaved) };
    }

    // Non-Pi input: Headroom recognizes the format natively.
    const result = await compress(original, compressOptions);
    if (!result.compressed) return { messages: original, tokensSaved: 0 };
    return {
      messages: result.messages as PiMessage[],
      tokensSaved: normalizeSaved(result.tokensSaved),
    };
  } catch {
    // Never throw into the agent loop (LD3).
    return { messages: original, tokensSaved: 0 };
  }
}
