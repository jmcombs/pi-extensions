/**
 * @jmcombs/pi-tavily-search — Real-time web search for the Pi coding agent.
 *
 * Registers a `tavily_search` tool that the LLM can call to perform a Tavily
 * web search. Credentials are handled entirely through the imported
 * `@jmcombs/pi-1password` credential API (`resolveSecret` / `onboardSecret`),
 * so the key is never leaked into the agent's context.
 *
 * Credential handling:
 *    1. `resolveSecret("tavily")` reads `~/.pi/agent/auth.json` and resolves the
 *       stored entry (literal key or `!op read 'op://…'` reference) fresh on each
 *       use; the `TAVILY_API_KEY` environment variable is the fallback.
 *    2. If nothing is stored, the tool auto-invokes `onboardSecret`, which branches
 *       on 1Password availability — the live vault picker when `op` is configured,
 *       manual API-key entry otherwise — then re-resolves.
 *    3. `/tavily_setup` runs the same onboarding flow on demand.
 */

import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { onboardSecret, resolveSecret } from "@jmcombs/pi-1password";
import { type Static, Type } from "typebox";

const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";

// ── Tool parameter schema ──────────────────────────────────────────────

const tavilySearchSchema = Type.Object({
  query: Type.String({
    description: "The search query to perform.",
    minLength: 1,
  }),
});

export type TavilySearchInput = Static<typeof tavilySearchSchema>;

const tavilySearchOutputSchema = Type.Union([
  Type.Object({
    error: Type.String(),
  }),
  Type.Object({
    status: Type.Number(),
    body: Type.String(),
  }),
  Type.Object({
    raw: Type.Unknown(),
  }),
]);

// ── Tavily API response types ──────────────────────────────────────────
//
// Documented at https://docs.tavily.com/documentation/api-reference/endpoint/search
// We model only the fields we actually consume; unknown fields pass through
// untouched in the `details.raw` field returned by the tool.

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  raw_content?: string | null;
}

interface TavilySearchResponse {
  query?: string;
  answer?: string;
  results?: TavilySearchResult[];
}

// ── Helpers ────────────────────────────────────────────────────────────

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return true;
    case "object": {
      if (Array.isArray(value)) return value.every(isJsonValue);
      const nested: unknown[] = Object.values(value);
      return nested.every(isJsonValue);
    }
    default:
      return false;
  }
}

function asJsonObject(value: JsonValue): JsonObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function toTavilySearchResponse(data: JsonValue): TavilySearchResponse {
  const obj = asJsonObject(data);
  if (!obj) return {};
  const out: TavilySearchResponse = {};
  if (typeof obj.query === "string") out.query = obj.query;
  if (typeof obj.answer === "string") out.answer = obj.answer;
  if (Array.isArray(obj.results)) {
    const results: TavilySearchResult[] = [];
    for (const item of obj.results) {
      const entry = asJsonObject(item);
      if (!entry) continue;
      if (
        typeof entry.title !== "string" ||
        typeof entry.url !== "string" ||
        typeof entry.content !== "string"
      ) {
        continue;
      }
      const result: TavilySearchResult = {
        title: entry.title,
        url: entry.url,
        content: entry.content,
      };
      if (typeof entry.score === "number") result.score = entry.score;
      if (typeof entry.raw_content === "string" || entry.raw_content === null) {
        result.raw_content = entry.raw_content;
      }
      results.push(result);
    }
    out.results = results;
  }
  return out;
}

function formatResults(data: TavilySearchResponse, query: string): string {
  const results = data.results ?? [];
  if (results.length === 0) {
    return `No search results found for "${query}".`;
  }

  const formatted = results
    .map((r) => `Title: ${r.title}\nURL: ${r.url}\nContent: ${r.content}\n`)
    .join("\n---\n");

  const answer = data.answer ? `Answer: ${data.answer}\n\n` : "";
  return `${answer}Search results for "${query}":\n\n${formatted}`;
}

// ── Extension factory ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // Register /tavily_setup command for onboarding the key on demand.
  // The input is captured by the TUI and never enters the LLM's context.
  pi.registerCommand("tavily_setup", {
    description: "Set up or update your Tavily API key (never shown to the agent).",
    handler: async (_args, ctx) => {
      const result = await onboardSecret(ctx, { name: "tavily", label: "Tavily" });
      ctx.ui.notify(result.message, result.ok ? "info" : "warning");
    },
  });

  pi.registerTool({
    name: "tavily_search",
    label: "Tavily Web Search",
    description:
      "Performs a web search using the Tavily API to get real-time information from the internet.",
    parameters: tavilySearchSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    outputSchema: tavilySearchOutputSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let apiKey = (await resolveSecret("tavily")) ?? process.env.TAVILY_API_KEY;

      // Auto-onboard: run the availability-branched onboarding flow if no key is
      // configured, then re-resolve (env fallback preserved).
      if (!apiKey) {
        const r = await onboardSecret(ctx, { name: "tavily", label: "Tavily" });
        if (r.ok) {
          apiKey = (await resolveSecret("tavily")) ?? process.env.TAVILY_API_KEY;
        }
      }
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "Search cancelled: no Tavily API key provided." }],
          details: { error: "missing_api_key" },
          structuredContent: { error: "missing_api_key" } as JsonObject,
        };
      }

      try {
        const response = await fetch(TAVILY_SEARCH_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            query: params.query,
            search_depth: "advanced",
            max_results: 5,
          }),
          signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            content: [
              {
                type: "text",
                text: `Tavily API error: ${String(response.status)} ${response.statusText}\n${errorText}`,
              },
            ],
            details: { status: response.status, body: errorText },
            structuredContent: { status: response.status, body: errorText } as JsonObject,
          };
        }

        const parsed: unknown = await response.json();
        if (!isJsonValue(parsed)) {
          return {
            content: [{ type: "text", text: "Tavily API returned invalid JSON." }],
            details: { error: "invalid_json" },
            structuredContent: { error: "invalid_json" } as JsonObject,
          };
        }
        const data = parsed;
        return {
          content: [
            { type: "text", text: formatResults(toTavilySearchResponse(data), params.query) },
          ],
          details: { raw: data },
          structuredContent: { raw: data } as JsonObject,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error performing Tavily search: ${message}` }],
          details: { error: message },
          structuredContent: { error: message } as JsonObject,
        };
      }
    },
  });
}
