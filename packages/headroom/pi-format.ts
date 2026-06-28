/**
 * @jmcombs/pi-headroom — Pi ↔ OpenAI message conversion (LD8, Path A).
 *
 * Headroom's `compress()` does **not** recognize Pi's `AgentMessage[]` shape
 * (`role: "toolResult"`, content parts `toolCall` / `thinking`): its
 * `detectFormat()` falls through to `"openai"` and returns the messages
 * unchanged, so compression never fires on real Pi sessions (~0% savings).
 *
 * Until the upstream SDK learns the Pi format (Phase 7), this module performs
 * the conversion **in-process**:
 *
 *   Pi `AgentMessage[]`  →  `piToOpenAI`  →  OpenAI messages
 *   OpenAI messages      →  `compress()`  →  compressed OpenAI messages
 *   compressed OpenAI    →  `applyCompressedText`  →  original Pi messages with
 *                           the compressed text swapped **in place**
 *
 * The conversion is **1:1 and count-preserving**: every Pi message maps to
 * exactly one OpenAI message and vice-versa, so the compressed text can be
 * swapped back by index onto **copies** of the original Pi messages —
 * preserving every Pi field (`toolName`, `toolCallId` linkage, `usage`,
 * `provider`, `timestamp`, `thinking` / `toolCall` parts). `applyCompressedText`
 * returns `null` whenever the arrays are not 1:1 alignable so the caller can
 * pass the originals through untouched (LD3). Pi messages are never
 * reconstructed from scratch with placeholder metadata — the in-place swap is
 * mandatory; full reconstruction belongs only to the upstream SDK contribution.
 *
 * The Pi types are derived from the installed runtime (`ContextEvent`), the
 * authoritative source — not from the reference note.
 */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage as OpenAIAssistantMessage,
  OpenAIMessage,
  ToolCall as OpenAIToolCall,
} from "headroom-ai";

/** A single Pi conversation message, exactly as Pi hands it to the `context` hook. */
export type PiMessage = ContextEvent["messages"][number];

/** Read a possibly-missing `role` field off any message-shaped value. */
function roleOf(message: unknown): unknown {
  return (message as { role?: unknown } | null)?.role;
}

/** Read a possibly-missing `content` field off any message-shaped value. */
function contentOf(message: unknown): unknown {
  return (message as { content?: unknown } | null)?.content;
}

/** Read a content part's `type` discriminator defensively. */
function partType(part: unknown): unknown {
  return (part as { type?: unknown } | null)?.type;
}

/**
 * Collapse a Pi content value (string, or an array of text/thinking/toolCall/
 * image parts) into the plain text the OpenAI shape expects. Only `text` parts
 * contribute; non-text parts (images, tool calls, thinking) are carried
 * structurally, not as text.
 */
function joinText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => partType(part) === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join("\n");
}

/**
 * True when `messages` is the Pi `AgentMessage[]` shape: any message with
 * `role: "toolResult"`, or any content part of type `toolCall` / `thinking`.
 * These markers are unique to Pi among Headroom's recognized formats.
 */
export function isPiFormat(messages: readonly PiMessage[]): boolean {
  for (const message of messages) {
    if (roleOf(message) === "toolResult") return true;
    const content = contentOf(message);
    if (Array.isArray(content)) {
      for (const part of content) {
        const type = partType(part);
        if (type === "toolCall" || type === "thinking") return true;
      }
    }
  }
  return false;
}

/**
 * Convert Pi `AgentMessage[]` to OpenAI messages, **1:1 and count-preserving**.
 *
 *   - Pi `user`       → OpenAI `user` (text only).
 *   - Pi `assistant`  → OpenAI `assistant` with `tool_calls` lifted out of the
 *     `toolCall` content parts (id / name / arguments preserved).
 *   - Pi `toolResult` → OpenAI `tool` with `tool_call_id` from `toolCallId`.
 *   - Any other / custom Pi message → OpenAI `user` (best-effort text), so the
 *     slot is preserved for index-aligned swap-back.
 */
export function piToOpenAI(messages: readonly PiMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const message of messages) {
    const role = roleOf(message);
    const content = contentOf(message);

    if (role === "assistant") {
      const text = joinText(content);
      const toolCalls: OpenAIToolCall[] = (Array.isArray(content) ? content : [])
        .filter((part) => partType(part) === "toolCall")
        .map((part) => {
          const call = part as { id?: unknown; name?: unknown; arguments?: unknown };
          return {
            id: String(call.id ?? ""),
            type: "function" as const,
            function: {
              name: String(call.name ?? ""),
              arguments:
                typeof call.arguments === "string"
                  ? call.arguments
                  : JSON.stringify(call.arguments ?? {}),
            },
          };
        });

      const assistant: OpenAIAssistantMessage = { role: "assistant", content: text || null };
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      result.push(assistant);
      continue;
    }

    if (role === "toolResult") {
      const toolCallId = String((message as { toolCallId?: unknown }).toolCallId ?? "");
      result.push({ role: "tool", content: joinText(content), tool_call_id: toolCallId });
      continue;
    }

    // user + any other/custom role → preserve the slot as a user message.
    result.push({ role: "user", content: joinText(content) });
  }

  return result;
}

/** The OpenAI role a given Pi role maps to under `piToOpenAI`. */
function expectedOpenAIRole(piRole: unknown): OpenAIMessage["role"] {
  if (piRole === "assistant") return "assistant";
  if (piRole === "toolResult") return "tool";
  return "user";
}

/** Extract the plain text from a compressed OpenAI message. */
function openAIText(message: OpenAIMessage): string {
  const content = (message as { content?: unknown }).content;
  return joinText(content);
}

/**
 * Rewrite Headroom's inline CCR marker so it is **directive** — naming the
 * `headroom_retrieve` tool at the point of need. The proxy embeds a marker like
 * `… Retrieve more: hash=<hash>` in compressed text; on its own that phrasing
 * (often alongside "compressed to 0") reads as a dead end, so models see the
 * hash but do not connect it to the tool that recovers the original. We rewrite
 * just the call-to-action — **preserving `hash=<hash>` verbatim** so the tool
 * still extracts the same hash — into an explicit instruction. The leading
 * `[N … compressed to M.` summary is left untouched. Idempotent: text without
 * the marker is returned unchanged.
 */
export function rewriteRetrieveMarker(text: string): string {
  return text.replace(
    /Retrieve more:\s*hash=([0-9a-fA-F]+)/g,
    "To recover an omitted detail, call the headroom_retrieve tool with hash=$1 and a query describing the specific line you need",
  );
}

/**
 * Return a copy of a Pi message with its text content replaced by `newText`,
 * preserving all non-text content parts (images, `toolCall`, `thinking`) and
 * every other field (`toolName`, `toolCallId`, `usage`, `provider`,
 * `timestamp`, …). When the original content is a bare string, the copy keeps a
 * bare string. When it is an array, the text is collapsed into a single leading
 * `text` part (omitted entirely when `newText` is empty) followed by the
 * preserved non-text parts.
 */
function swapText(original: PiMessage, newText: string): PiMessage {
  const copy: Record<string, unknown> = { ...(original as unknown as Record<string, unknown>) };
  const content = copy.content;

  if (typeof content === "string") {
    copy.content = newText;
    return copy as unknown as PiMessage;
  }

  if (Array.isArray(content)) {
    const nonTextParts = content.filter((part) => partType(part) !== "text");
    const newContent: unknown[] = [];
    if (newText.length > 0) newContent.push({ type: "text", text: newText });
    newContent.push(...nonTextParts);
    copy.content = newContent;
    return copy as unknown as PiMessage;
  }

  return copy as unknown as PiMessage;
}

/**
 * Swap compressed OpenAI text back into **copies** of the original Pi messages,
 * by index. Returns `null` (so the caller passes the originals through) when the
 * two arrays are not 1:1 alignable — length mismatch, or any per-index role
 * mismatch between the Pi message and its compressed OpenAI counterpart. The
 * original array and its messages are never mutated.
 */
export function applyCompressedText(
  originalPiMessages: readonly PiMessage[],
  compressedOpenAIMessages: readonly OpenAIMessage[],
): PiMessage[] | null {
  if (originalPiMessages.length !== compressedOpenAIMessages.length) return null;

  const result: PiMessage[] = [];
  for (let index = 0; index < originalPiMessages.length; index++) {
    const original = originalPiMessages[index];
    const compressed = compressedOpenAIMessages[index];
    if (original === undefined || compressed === undefined) return null;
    if (compressed.role !== expectedOpenAIRole(roleOf(original))) return null;
    result.push(swapText(original, rewriteRetrieveMarker(openAIText(compressed))));
  }

  return result;
}
