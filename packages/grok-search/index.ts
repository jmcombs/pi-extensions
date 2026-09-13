/**
 * @jmcombs/pi-grok-search — Real-time web search for the Pi coding agent via xAI Grok.
 *
 * Registers a `grok_search` tool that the LLM can call to perform a Grok-powered
 * web search. Credentials are handled through `@jmcombs/pi-1password` plus the
 * xAI OAuth entry Pi stores after `/login xai` (SuperGrok / X Premium). The
 * token is never leaked into the agent's context.
 *
 * Credential handling:
 *    1. If settings.json prefers `api_key`, resolve `xai_search` / `xai` / `grok`
 *       API keys only.
 *    2. Otherwise use xAI OAuth (`auth.json` `xai.type === "oauth"`) when present,
 *       refreshing the access token when expired.
 *    3. Else fall through to the API-key chain above.
 *    4. If nothing resolves, auto-invoke 1Password `onboardSecret` (writing the
 *       `grok` id). `/grok_setup` is the explicit setup command: when OAuth is
 *       already present it shows a card offering OAuth vs an API-key override.
 *
 * Error contract: user-facing recoverable errors (missing key, 401,
 * 429, network, non-2xx) are reported via `content[]` + `details` — never a
 * returned `isError` (which pi ignores on a returned result) and never a throw.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { onboardSecret } from "@jmcombs/pi-1password";
import { type Static, Type } from "typebox";
import { readCredentialPreference, resolveGrokAuth } from "./auth.js";
import { runGrokSetup } from "./setup.js";

const XAI_RESPONSES_ENDPOINT = "https://api.x.ai/v1/responses";

// ── Tool parameter schema ──────────────────────────────────────────────

const grokSearchSchema = Type.Object({
  query: Type.String({
    description: "The search query to perform.",
    minLength: 1,
  }),
});

export type GrokSearchInput = Static<typeof grokSearchSchema>;

function formatResults(content: string, query: string): string {
  if (!content || content.trim().length === 0) {
    return `No search results found for "${query}".`;
  }
  return `Grok search results for "${query}":\n\n${content}`;
}

function missingCredentialResult(preference: "oauth" | undefined): {
  content: [{ type: "text"; text: string }];
  details: { error: string };
} {
  if (preference === "oauth") {
    return {
      content: [
        {
          type: "text",
          text:
            "Grok Search is set to use xAI OAuth, but no usable SuperGrok / X Premium " +
            "token was found. Run /login xai or /grok_setup to configure credentials.",
        },
      ],
      details: { error: "missing_oauth" },
    };
  }
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

// ── Extension factory ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("grok_setup", {
    description: "Set up Grok Search (xAI OAuth or an API key; never shown to the agent).",
    handler: async (_args, ctx) => {
      const result = await runGrokSetup(ctx);
      ctx.ui.notify(result.message, result.ok ? "info" : "warning");
    },
  });

  pi.registerTool({
    name: "grok_search",
    label: "Grok Web Search",
    description:
      "Performs real-time web research using xAI Grok. Call this to get up-to-date information on topics beyond your training cutoff, verify facts, or perform complex synthesis of live web data when reasoning and multi-source analysis are required.",
    parameters: grokSearchSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let auth = await resolveGrokAuth(signal);

      if (!auth) {
        const preference = await readCredentialPreference();
        if (preference === "oauth") {
          return missingCredentialResult("oauth");
        }
        const r = await onboardSecret(ctx, { name: "grok", label: "Grok / xAI" });
        if (r.ok) {
          auth = await resolveGrokAuth(signal);
        }
      }
      if (!auth) {
        return missingCredentialResult(undefined);
      }

      try {
        const response = await fetch(XAI_RESPONSES_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth.token}`,
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
                    "xAI API error: 401 Unauthorized. Your xAI credential may be missing " +
                    "or invalid. Run /grok_setup to configure it.",
                },
              ],
              details: { status: 401, source: auth.source },
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
              details: { status: 429, source: auth.source },
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
            details: { status: response.status, body: errorText, source: auth.source },
          };
        }

        const data: unknown = await response.json();
        const output =
          (data as { output?: { type?: string; content?: { text?: string }[] }[] }).output ?? [];
        const messageItem = output.find((o) => o.type === "message");
        const content = messageItem?.content?.[0]?.text ?? "";
        return {
          content: [{ type: "text", text: formatResults(content, params.query) }],
          details: { raw: data, source: auth.source },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error performing Grok search: ${message}` }],
          details: { error: message, source: auth.source },
        };
      }
    },
  });
}
