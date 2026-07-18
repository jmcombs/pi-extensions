/**
 * @jmcombs/pi-grok-search — Real-time web search for the Pi coding agent via xAI Grok.
 *
 * Registers a `grok_search` tool that the LLM can call to perform a Grok-powered
 * web search. Credentials are handled entirely through the imported
 * `@jmcombs/pi-1password` credential API (`resolveSecret` / `onboardSecret`), so the
 * key is never leaked into the agent's context.
 *
 * Credential handling (D12 three-id precedence):
 *    1. `resolveSecret("xai_search")` — a dedicated Grok search key, if set.
 *    2. `resolveSecret("xai")` — the real xAI model-provider key, reused as-is
 *       (never overwritten by onboarding).
 *    3. `resolveSecret("grok")` — the id onboarding writes.
 *    Each reads `~/.pi/agent/auth.json` fresh on every call (a literal key or an
 *    `!op read 'op://…'` reference). If none resolves, the tool auto-invokes
 *    `onboardSecret` (writing the `grok` id), which branches on 1Password
 *    availability — the live vault picker when `op` is configured, manual API-key
 *    entry otherwise — then re-resolves. `/grok_setup` runs the same onboarding
 *    flow on demand.
 *
 * Error contract (ADR 0007): user-facing recoverable errors (missing key, 401,
 * 429, network, non-2xx) are reported via `content[]` + `details` — never a
 * returned `isError` (which pi ignores on a returned result) and never a throw.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { onboardSecret, resolveSecret } from "@jmcombs/pi-1password";
import { type Static, Type } from "typebox";

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

/**
 * Resolve the xAI key in D12 precedence: a dedicated `xai_search` key, else the
 * real `xai` provider key, else the onboarding-written `grok` id. Each entry is
 * resolved fresh (literal or `!op read`) and never surfaces to the LLM.
 */
async function resolveGrokKey(): Promise<string | undefined> {
  return (
    (await resolveSecret("xai_search")) ??
    (await resolveSecret("xai")) ??
    (await resolveSecret("grok"))
  );
}

function formatResults(content: string, query: string): string {
  if (!content || content.trim().length === 0) {
    return `No search results found for "${query}".`;
  }
  return `Grok search results for "${query}":\n\n${content}`;
}

// ── Extension factory ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // -- /grok_setup (user-facing command)
  // The input is captured by the TUI and never enters the LLM's context.
  // Onboarding writes the `grok` id — it never overwrites the shared real `xai`
  // provider key.
  pi.registerCommand("grok_setup", {
    description: "Set up or update your Grok / xAI API key (never shown to the agent).",
    handler: async (_args, ctx) => {
      const result = await onboardSecret(ctx, { name: "grok", label: "Grok / xAI" });
      ctx.ui.notify(result.message, result.ok ? "info" : "warning");
    },
  });

  pi.registerTool({
    name: "grok_search",
    label: "Grok Web Search",
    description:
      // Improved tool description for better intent matching and reasoning support.
      "Performs real-time web research using xAI Grok. Call this to get up-to-date information on topics beyond your training cutoff, verify facts, or perform complex synthesis of live web data when reasoning and multi-source analysis are required.",
    parameters: grokSearchSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let apiKey = await resolveGrokKey();

      // Auto-onboard: run the availability-branched onboarding flow if no key is
      // configured, then re-resolve. Onboarding writes the `grok` id.
      if (!apiKey) {
        const r = await onboardSecret(ctx, { name: "grok", label: "Grok / xAI" });
        if (r.ok) {
          apiKey = await resolveGrokKey();
        }
      }
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "Search cancelled: no xAI API key provided. Run /grok_setup to configure one.",
            },
          ],
          details: { error: "missing_api_key" },
        };
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
          if (response.status === 401) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "xAI API error: 401 Unauthorized. Your xAI API key may be missing " +
                    "or invalid. Run /grok_setup to configure it.",
                },
              ],
              details: { status: 401 },
            };
          }
          if (response.status === 429) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "xAI API error: 429 Too Many Requests. You are being rate limited — " +
                    "please wait a moment and try again.",
                },
              ],
              details: { status: 429 },
            };
          }

          const errorText = await response.text();
          return {
            content: [
              {
                type: "text",
                text: `xAI API error: ${String(response.status)} ${response.statusText}\n${errorText}`,
              },
            ],
            details: { status: response.status, body: errorText },
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
        };
      }
    },
  });
}
