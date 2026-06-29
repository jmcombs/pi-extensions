/**
 * @jmcombs/pi-headroom — deterministic query → line matching.
 *
 * Shared by the `headroom_retrieve` tool (Phase 3) and the query-aware
 * auto-retrieve step (Phase 6): given the recovered original text and a few
 * query words, return the line(s) that best match. This is deliberately a
 * **lexical** matcher, not the proxy's semantic search — the proxy's search
 * misses ordinary substrings (e.g. `txn 147`), whereas this is exact,
 * explainable, and guarantees a short, focused result the model can read.
 */

/**
 * Hard cap on lines returned by a query filter, so a broad query cannot dump the
 * whole original back into context.
 */
export const MAX_FILTERED_LINES = 25;

/**
 * Pick the lines of `original` that best match `query`, deterministically.
 *
 * Each line is scored by how many distinct query terms (length ≥ 2) it contains;
 * the highest-scoring lines are returned (capped at {@link MAX_FILTERED_LINES}).
 * Returns `null` when the query carries no usable terms or no line matches any
 * term — the caller then keeps the full original (so detail is never lost).
 */
export function filterByQuery(original: string, query: string): string[] | null {
  const terms = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .map((term) => term.replace(/[^a-z0-9._:/\\-]/g, ""))
        .filter((term) => term.length >= 2),
    ),
  );
  if (terms.length === 0) return null;

  const lines = original.split("\n");
  let best = 0;
  const scored = lines.map((line) => {
    const lower = line.toLowerCase();
    let score = 0;
    for (const term of terms) if (lower.includes(term)) score++;
    if (score > best) best = score;
    return { line, score };
  });
  if (best === 0) return null;

  return scored
    .filter((entry) => entry.score === best)
    .map((entry) => entry.line)
    .slice(0, MAX_FILTERED_LINES);
}
