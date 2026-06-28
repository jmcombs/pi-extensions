/**
 * @jmcombs/pi-headroom — whole-conversation compression.
 *
 * `compressMessages()` is the single, testable seam between Pi's `context`
 * event and the Headroom proxy. It pipes the entire `messages` array through
 * the `headroom-ai` `compress()` HTTP client and reports how many tokens were
 * saved.
 *
 * Locked Decisions honored here:
 *   - LD1 — operates on the whole conversation (the `context` hook feeds it the
 *     full `messages` array); it never targets a single `tool_result`.
 *   - LD3 — graceful degradation: every call sets `fallback: true` (the proxy
 *     returns input unchanged when it cannot compress) AND is wrapped in a
 *     defensive `try/catch` that returns the **original** messages with
 *     `tokensSaved: 0`. This function never throws.
 *
 * Compression is lossy on the surface; reversibility (the CCR `headroom_retrieve`
 * tool) arrives in Phase 3.
 */

import { compress } from "headroom-ai";

export interface CompressMessagesOptions {
  /** Model id used by the proxy for tokenization + context-limit math. */
  model?: string;
  /** Proxy base URL (resolved by `client.resolveConfig`). */
  baseUrl?: string;
  /** Optional proxy API key for authenticated deployments. */
  apiKey?: string;
}

export interface CompressMessagesResult {
  /** Compressed messages in the same format as the input. */
  messages: unknown[];
  /** Tokens saved by compression; `0` when nothing was compressed or on error. */
  tokensSaved: number;
}

/**
 * Compress an entire conversation through the Headroom proxy.
 *
 * On any failure (proxy unreachable, malformed response, thrown error) this
 * returns the original `messages` untouched with `tokensSaved: 0` — it must
 * never throw into the agent loop (LD3).
 */
export async function compressMessages(
  messages: unknown[],
  options: CompressMessagesOptions = {},
): Promise<CompressMessagesResult> {
  try {
    const result = await compress(messages as never[], {
      model: options.model,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      fallback: true,
    });

    const compressed = Array.isArray(result?.messages) ? result.messages : undefined;
    const tokensSaved = typeof result?.tokensSaved === "number" ? result.tokensSaved : 0;

    if (!compressed) {
      return { messages, tokensSaved: 0 };
    }

    return { messages: compressed, tokensSaved };
  } catch {
    // LD3 — degrade to pure passthrough; never throw.
    return { messages, tokensSaved: 0 };
  }
}
