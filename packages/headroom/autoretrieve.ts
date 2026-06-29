/**
 * @jmcombs/pi-headroom — query-aware auto-retrieve (Phase 6).
 *
 * Whole-conversation compression crushes bulky tool results to near-zero and
 * leaves an inline CCR marker (`… hash=<hash>`). Recovering the elided detail
 * then depends on the **model** choosing to call `headroom_retrieve` — and weaker
 * models simply don't, so a later recall question fails even though the content
 * is sitting in the CCR store (verified: `compress()` crushes the needle to
 * `compressed to 0`; `retrieve(hash)` returns it intact).
 *
 * That dependence is removable. The `context` hook sees the **whole**
 * conversation, including the user's newest turn — i.e. the recall query itself.
 * So when the latest turn is a user question and the conversation carries CCR
 * markers, we proactively `retrieve(hash)` the originals and inject just the
 * line(s) that lexically match the query (via {@link filterByQuery}) back next
 * to their marker. The model then answers from context with no tool call — making
 * recall **model-independent**.
 *
 * It is conservative by construction:
 *   - Only fires when the latest message is a `user` turn (the question), never
 *     mid-tool-loop.
 *   - Only injects when the query actually matches a crushed line; a non-matching
 *     query injects nothing (compression savings untouched).
 *   - Injects at most {@link MAX_FILTERED_LINES} lines per marker, newest markers
 *     first, capped to a few markers.
 *   - Never throws (LD3): any retrieve error skips that marker and moves on.
 */

import type { RetrieveResult, RetrieveSearchResult } from "headroom-ai";
import type { PiMessage } from "./pi-format.js";
import { filterByQuery } from "./query.js";

/** Minimal client surface auto-retrieve needs — lets tests inject a stub. */
export type AutoRetrieveClient = {
  retrieve(hash: string): Promise<RetrieveResult | RetrieveSearchResult>;
};

/** Default cap on how many distinct CCR markers we expand on one user turn. */
const DEFAULT_MAX_MARKERS = 3;

/** Extract a CCR hash from text (after `hash=`); hex, ≥ 6 chars. */
const HASH_RE = /hash=([0-9a-fA-F]{6,})/;

/**
 * Signature of a Headroom CCR marker, present in both the raw
 * (`[N lines compressed to M. Retrieve more: hash=…]`) and the rewritten
 * directive form (which keeps the leading `[N … compressed to M.` summary).
 * Requiring it stops an unrelated `hash=<hex>` in ordinary prose from being
 * mistaken for a marker (which would waste a retrieve and, worse, could crowd
 * out genuine markers under the per-turn cap).
 */
const MARKER_HINT = /compressed to/i;

function roleOf(message: unknown): unknown {
  return (message as { role?: unknown } | null)?.role;
}

function partType(part: unknown): unknown {
  return (part as { type?: unknown } | null)?.type;
}

/** Collapse a Pi message's content to its plain text (text parts only). */
function textOf(message: PiMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => partType(part) === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join("\n");
}

/**
 * The latest user turn's text, or `""` when the conversation's last message is
 * not a `user` message (e.g. a tool result mid-loop) — the signal that this is a
 * fresh question, the only point at which auto-retrieve should act.
 */
export function latestUserQuery(messages: readonly PiMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last || roleOf(last) !== "user") return "";
  return textOf(last).trim();
}

/** A compressed message that still carries a CCR marker we can expand. */
interface Marker {
  index: number;
  hash: string;
}

/** Find messages carrying a CCR hash, **newest first** (highest index first). */
export function collectMarkers(messages: readonly PiMessage[]): Marker[] {
  const markers: Marker[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message === undefined) continue;
    const text = textOf(message);
    if (!MARKER_HINT.test(text)) continue;
    const match = HASH_RE.exec(text);
    if (match?.[1]) markers.push({ index, hash: match[1] });
  }
  return markers;
}

/**
 * Return a copy of a Pi message with `note` appended to its text content,
 * preserving every other field and all non-text parts. A bare-string message
 * stays a bare string; an array message gets the note folded into a single
 * leading text part (mirroring `pi-format`'s in-place swap discipline).
 */
function appendText(original: PiMessage, note: string): PiMessage {
  const copy: Record<string, unknown> = { ...(original as unknown as Record<string, unknown>) };
  const content = copy.content;

  if (typeof content === "string") {
    copy.content = `${content}${note}`;
    return copy as unknown as PiMessage;
  }
  if (Array.isArray(content)) {
    const nonText = content.filter((part) => partType(part) !== "text");
    const text = content
      .filter((part) => partType(part) === "text")
      .map((part) => String((part as { text?: unknown }).text ?? ""))
      .join("\n");
    copy.content = [{ type: "text", text: `${text}${note}` }, ...nonText];
    return copy as unknown as PiMessage;
  }
  return copy as unknown as PiMessage;
}

/** Build the inline note that carries the auto-retrieved line(s). */
function buildNote(query: string, matches: string[]): string {
  const n = matches.length;
  return (
    `\n\n[Headroom auto-retrieved ${n} line${n === 1 ? "" : "s"} matching your question` +
    ` "${query}" from the compressed content above:]\n${matches.join("\n")}`
  );
}

export interface AutoRetrieveResult {
  /** Messages with matching originals injected (copies; input untouched). */
  messages: PiMessage[];
  /** Total lines injected across all markers (0 = nothing changed). */
  injectedLines: number;
  /** Markers whose original was injected. */
  injectedMarkers: number;
}

/**
 * Query-aware auto-retrieve. When the latest turn is a user question and the
 * conversation carries CCR markers, retrieve each marker's original and inject
 * the line(s) matching the question back next to the marker. Returns the input
 * unchanged (`injectedLines: 0`) when the latest turn isn't a user question,
 * there are no markers, or nothing matches. Never throws (LD3).
 */
export async function augmentWithAutoRetrieve(
  messages: readonly PiMessage[],
  client: AutoRetrieveClient,
  options: { maxMarkers?: number } = {},
): Promise<AutoRetrieveResult> {
  const passthrough: AutoRetrieveResult = {
    messages: messages as PiMessage[],
    injectedLines: 0,
    injectedMarkers: 0,
  };

  const query = latestUserQuery(messages);
  if (!query) return passthrough;

  const markers = collectMarkers(messages).slice(0, options.maxMarkers ?? DEFAULT_MAX_MARKERS);
  if (markers.length === 0) return passthrough;

  const out = [...messages] as PiMessage[];
  let injectedLines = 0;
  let injectedMarkers = 0;

  for (const { index, hash } of markers) {
    try {
      const full = await client.retrieve(hash);
      if (!("originalContent" in full)) continue;
      const matches = filterByQuery(full.originalContent, query);
      if (!matches || matches.length === 0) continue;
      const target = out[index];
      if (target === undefined) continue;
      out[index] = appendText(target, buildNote(query, matches));
      injectedLines += matches.length;
      injectedMarkers += 1;
    } catch {
      // Skip this marker; never throw into the agent loop (LD3).
    }
  }

  if (injectedLines === 0) return passthrough;
  return { messages: out, injectedLines, injectedMarkers };
}
