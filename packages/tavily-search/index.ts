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
          };
        }

        const data = (await response.json()) as TavilySearchResponse;
        return {
          content: [{ type: "text", text: formatResults(data, params.query) }],
          details: { raw: data },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error performing Tavily search: ${message}` }],
          details: { error: message },
        };
      }
    },
  });
}
