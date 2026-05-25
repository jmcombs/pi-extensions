/**
 * @jmcombs/pi-grok-search — Real-time web search for the Pi coding agent via xAI Grok.
 *
 * Registers a `grok_search` tool that the LLM can call to perform a Grok-powered
 * web search. If no xAI API key is configured, the tool prompts the user
 * interactively via the TUI (never leaking the key into the agent's context).
 * The key can also be set manually by running `/grok_authenticate`.
 *
 * Supported configuration (if not using interactive prompt):
 *    1. `AuthStorage` under the "grok" key (`~/.pi/agent/auth.json`)
 *    2. The `XAI_API_KEY` environment variable
 */

import { AuthStorage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const XAI_RESPONSES_ENDPOINT = "https://api.x.ai/v1/responses";

// ── Tool parameter schema ──────────────────────────────────────────────

const grokSearchSchema = Type.Object({
  query: Type.String({
    description: "The search query to perform.",
    minLength: 1,
  }),
});

export type GrokSearchInput = Static<typeof grokSearchSchema>;

// ── Helpers ────────────────────────────────────────────────────────────

function formatResults(content: string, query: string): string {
  if (!content || content.trim().length === 0) {
    return `No search results found for "${query}".`;
  }
  return `Grok search results for "${query}":\n\n${content}`;
}

// ── Extension factory ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  const authStorage = AuthStorage.create();

  // Register /grok_authenticate command for manual key entry.
  // The input is captured by the TUI and never enters the LLM's context.
  pi.registerCommand("grok_authenticate", {
    description: "Securely save your xAI API key (input never visible to LLM).",
    handler: async (_args, ctx) => {
      const existing = await authStorage.getApiKey("xai");
      if (existing) {
        const reuse = await ctx.ui.input("Found existing xAI API key. Reuse it? (Yes/No):");
        if (reuse?.toLowerCase() === "yes") {
          authStorage.remove("xai_search");
          ctx.ui.notify("Reusing existing xAI key.", "info");
          return;
        }
      }
      const apiKey = await ctx.ui.input("Enter your xAI API key:");
      if (apiKey) {
        authStorage.set("xai_search", { type: "api_key" as const, key: apiKey });
        ctx.ui.notify("xAI API key saved successfully under xai_search.", "info");
      } else {
        ctx.ui.notify("Authentication cancelled.", "warning");
      }
    },
  });

  pi.registerTool({
    name: "grok_search",
    label: "Grok Web Search",
    description:
      "Performs real-time web research using xAI Grok. Call this to get up-to-date information on topics beyond your training cutoff, verify facts, or perform complex synthesis of live web data when reasoning and multi-source analysis are required.",
    parameters: grokSearchSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let apiKey =
        (await authStorage.getApiKey("xai_search")) ??
        (await authStorage.getApiKey("xai")) ??
        process.env.XAI_API_KEY;

      // Auto-authenticate: prompt for key if none is configured
      if (!apiKey) {
        const newKey = await ctx.ui.input("Enter your xAI API key:");
        if (!newKey) {
          return {
            content: [{ type: "text", text: "Search cancelled: no xAI API key provided." }],
            details: { error: "missing_api_key" },
            isError: true,
          };
        }
        authStorage.set("grok", { type: "api_key" as const, key: newKey });
        apiKey = await authStorage.getApiKey("grok");
        if (!apiKey) {
          return {
            content: [
              {
                type: "text",
                text: "Failed to resolve xAI API key. Check your shell configuration.",
              },
            ],
            details: { error: "missing_api_key" },
            isError: true,
          };
        }
      }

      try {
        const response = await fetch(XAI_RESPONSES_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "grok-3",
            input: [{ role: "user", content: params.query }],
            tools: [{ type: "web_search" }],
          }),
          signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            content: [
              {
                type: "text",
                text: `xAI API error: ${String(response.status)} ${response.statusText}\n${errorText}`,
              },
            ],
            details: { status: response.status, body: errorText },
            isError: true,
          };
        }

        const data: unknown = await response.json();
        const output =
          (data as { output?: { type?: string; content?: { text?: string }[] }[] }).output ?? [];
        const messageItem = output.find((o) => o.type === "message");
        const content = messageItem?.content?.[0]?.text ?? "";
        return {
          content: [{ type: "text", text: formatResults(content, params.query) }],
          details: { raw: data },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error performing Grok search: ${message}` }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });
}
