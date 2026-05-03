/**
 * @jmcombs/pi-tavily-search — Real-time web search for the Pi coding agent.
 *
 * Registers a `tavily_search` tool that the LLM can call to perform a Tavily
 * web search. The Tavily API key is resolved from (in order):
 *   1. `AuthStorage` under the "tavily" key (`~/.pi/agent/auth.json`)
 *   2. The `TAVILY_API_KEY` environment variable
 *
 * See README.md for configuration details and recommended secret-storage
 * patterns (env var, plain auth.json, or shell-resolved 1Password / Keychain).
 */

import { AuthStorage, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

const MISSING_KEY_MESSAGE = [
  "Error: No Tavily API key configured.",
  "",
  "Configure one of the following:",
  "  • Environment variable: export TAVILY_API_KEY=<your-key>",
  '  • ~/.pi/agent/auth.json: { "tavily": { "type": "api_key", "key": "<your-key>" } }',
  '  • Shell-resolved: { "tavily": { "type": "api_key", "key": "!security find-generic-password -ws tavily" } }',
  '  • 1Password: { "tavily": { "type": "api_key", "key": "!op read \'op://Personal/tavily/credential\'" } }',
].join("\n");

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

  pi.registerTool({
    name: "tavily_search",
    label: "Tavily Web Search",
    description:
      "Performs a web search using the Tavily API to get real-time information from the internet.",
    parameters: tavilySearchSchema,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const apiKey = (await authStorage.getApiKey("tavily")) ?? process.env.TAVILY_API_KEY;
      if (!apiKey) {
        return {
          content: [{ type: "text", text: MISSING_KEY_MESSAGE }],
          details: { error: "missing_api_key" },
          isError: true,
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
