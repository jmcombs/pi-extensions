/**
 * @jmcombs/pi-tavily-search — Real-time web search for the Pi coding agent.
 *
 * Registers a `tavily_search` tool that the LLM can call to perform a Tavily
 * web search. If no Tavily API key is configured, the tool prompts the user
 * interactively via the TUI (never leaking the key into the agent's context).
 * The key can also be set manually by running `/tavily_authenticate`.
 *
 * Supported configuration (if not using interactive prompt):
 *    1. `AuthStorage` under the "tavily" key (`~/.pi/agent/auth.json`)
 *    2. The `TAVILY_API_KEY` environment variable
 */

import { AuthStorage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

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
  const authStorage = AuthStorage.create();

  // Register /tavily_authenticate command for manual key entry.
  // The input is captured by the TUI and never enters the LLM's context.
  pi.registerCommand("tavily_authenticate", {
    description: "Securely save your Tavily API key (input never visible to LLM).",
    handler: async (_args, ctx) => {
      const apiKey = await ctx.ui.input("Enter your Tavily API key:");
      if (apiKey) {
        authStorage.set("tavily", { type: "api_key" as const, key: apiKey });
        ctx.ui.notify("Tavily API key saved successfully.", "info");
      } else {
        ctx.ui.notify("Authentication cancelled.", "warning");
      }
    },
  });

  pi.registerTool({
    name: "tavily_search",
    label: "Tavily Web Search",
    description:
      "Performs a web search using the Tavily API to get real-time information from the internet.",
    parameters: tavilySearchSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let apiKey = (await authStorage.getApiKey("tavily")) ?? process.env.TAVILY_API_KEY;

      // Auto-authenticate: prompt for key if none is configured
      if (!apiKey) {
        const newKey = await ctx.ui.input("Enter your Tavily API key:");
        if (!newKey) {
          return {
            content: [{ type: "text", text: "Search cancelled: no Tavily API key provided." }],
            details: { error: "missing_api_key" },
            isError: true,
          };
        }
        authStorage.set("tavily", { type: "api_key" as const, key: newKey });
        apiKey = await authStorage.getApiKey("tavily");
        if (!apiKey) {
          return {
            content: [
              {
                type: "text",
                text: "Failed to resolve Tavily API key. Check your shell configuration.",
              },
            ],
            details: { error: "missing_api_key" },
            isError: true,
          };
        }
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
            isError: true,
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
          isError: true,
        };
      }
    },
  });
}
