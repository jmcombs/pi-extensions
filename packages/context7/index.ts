/**
 * @jmcombs/pi-context7 — Real-time documentation for the Pi coding agent via Context7.
 *
 * Registers `context7_search` and `context7_get_docs` tools that let the LLM
 * find and retrieve version-aware documentation and code snippets from the
 * Context7 API. Credentials are handled entirely through the imported
 * `@jmcombs/pi-1password` credential API (`resolveSecret` / `onboardSecret`),
 * so the key is never leaked into the agent's context.
 *
 * Credential handling:
 *    1. `resolveSecret("context7")` reads `~/.pi/agent/auth.json` and resolves the
 *       stored entry (literal key or `!op read 'op://…'` reference) fresh on each use.
 *    2. If nothing is stored, the tool auto-invokes `onboardSecret`, which branches
 *       on 1Password availability — the live vault picker when `op` is configured,
 *       manual API-key entry otherwise — then re-resolves.
 *    3. `/context7_setup` runs the same onboarding flow on demand.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { onboardSecret, resolveSecret } from "@jmcombs/pi-1password";
import { type Static, Type } from "typebox";

const CONTEXT7_API_BASE = "https://context7.com/api/v2";

// -- Context7 API response types

interface CodeSnippet {
  codeTitle?: string;
  codeList?: { language?: string; code?: string }[];
}

interface InfoSnippet {
  content?: string;
}

interface Context7SearchResult {
  id: string;
  title: string;
  [key: string]: unknown;
}

interface Context7SearchResponse {
  results?: Context7SearchResult[];
}

interface Context7DocsResponse {
  codeSnippets?: CodeSnippet[];
  infoSnippets?: InfoSnippet[];
  [key: string]: unknown;
}

// -- Tool parameter schemas

const context7SearchSchema = Type.Object({
  libraryName: Type.String({
    description: "The name of the library (e.g., 'next.js', 'supabase').",
  }),
  query: Type.Optional(
    Type.String({
      description: "A specific question/topic to refine search results.",
    }),
  ),
});
export type Context7SearchInput = Static<typeof context7SearchSchema>;

const context7GetDocsSchema = Type.Object({
  libraryId: Type.String({
    description: "The Context7 Library ID (e.g., '/vercel/next.js').",
  }),
  query: Type.String({
    description: "The specific technical question or implementation pattern requested.",
  }),
});
export type Context7GetDocsInput = Static<typeof context7GetDocsSchema>;

// -- Helpers

function formatDocs(data: Context7DocsResponse, query: string): string {
  const { codeSnippets = [], infoSnippets = [] } = data;

  if (codeSnippets.length === 0 && infoSnippets.length === 0) {
    return `No documentation snippets found for ${query}.`;
  }

  const parts: string[] = [];

  if (codeSnippets.length > 0) {
    parts.push("--- CODE SNIPPETS ---");
    for (const snippet of codeSnippets) {
      if (snippet.codeTitle) {
        parts.push(`\n## ${snippet.codeTitle}`);
      }
      if (snippet.codeList && snippet.codeList.length > 0) {
        for (const item of snippet.codeList) {
          if (item.code) {
            const lang = item.language ?? "typescript";
            parts.push(`\`\`\`${lang}\n${item.code}\n\`\`\`\n`);
          }
        }
      }
    }
  }

  if (infoSnippets.length > 0) {
    parts.push("\n--- INFO SNIPPETS ---");
    for (const snippet of infoSnippets) {
      if (snippet.content) {
        parts.push(`\n${snippet.content}`);
      }
    }
  }

  return `Documentation for ${query}:\n\n${parts.join("\n")}`;
}

// -- Extension factory

export default function (pi: ExtensionAPI): void {
  // -- /context7_setup (user-facing command)
  pi.registerCommand("context7_setup", {
    description: "Set up or update your Context7 API key (never shown to the agent).",
    handler: async (_args, ctx) => {
      const result = await onboardSecret(ctx, { name: "context7", label: "Context7" });
      ctx.ui.notify(result.message, result.ok ? "info" : "warning");
    },
  });

  // -- context7_search
  pi.registerTool({
    name: "context7_search",
    label: "Context7: Find Library ID",
    description:
      "Use this tool to search Context7 for the correct library ID of a programming language, framework, or library. " +
      "Call this when the user needs up-to-date documentation, code examples, configuration guidance, or implementation details for something like Supabase, React, Rust, Tailwind, Prisma, or any other programming language, framework, or library. " +
      "Always prefer this tool over general web search when you need accurate, version-aware information for coding or development tasks.",
    parameters: context7SearchSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let apiKey = await resolveSecret("context7");
      if (!apiKey) {
        const r = await onboardSecret(ctx, { name: "context7", label: "Context7" });
        if (r.ok) {
          apiKey = await resolveSecret("context7");
        }
      }
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "Search cancelled: no Context7 API key provided.",
            },
          ],
          details: { error: "missing_api_key" },
        };
      }

      try {
        const url = new URL("/api/v2/libs/search", CONTEXT7_API_BASE);
        url.searchParams.set("libraryName", params.libraryName);
        if (params.query) {
          url.searchParams.set("query", params.query);
        }

        const response = await fetch(url.toString(), {
          signal,
          headers: { Authorization: `Bearer ${apiKey}` },
        });

        if (!response.ok) {
          if (response.status === 401) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Context7 API error: 401 Unauthorized. Your Context7 API key " +
                    "may be missing or invalid. Run /context7_setup to configure it.",
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
                    "Context7 API error: 429 Too Many Requests. You are being rate " +
                    "limited — please wait a moment and try again.",
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
                text:
                  "Context7 API error: " +
                  String(response.status) +
                  " " +
                  response.statusText +
                  "\n" +
                  errorText,
              },
            ],
            details: { status: response.status, body: errorText },
          };
        }

        const data = (await response.json()) as Context7SearchResponse;
        const libs = data.results ?? [];

        if (libs.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No libraries found matching ${params.libraryName}.`,
              },
            ],
            details: { libraryName: params.libraryName, raw: data },
          };
        }

        const formatted = libs
          .map((lib, i) => `${String(i + 1)}. ${lib.title} (ID: ${lib.id})`)
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text:
                "Context7 library search results for " +
                params.libraryName +
                ":\n\n" +
                formatted +
                "\n\nUse context7_get_docs with a Library ID to retrieve documentation.",
            },
          ],
          details: { libraryName: params.libraryName, raw: data },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error performing Context7 search: ${message}`,
            },
          ],
          details: { error: message },
        };
      }
    },
  });

  // -- context7_get_docs
  pi.registerTool({
    name: "context7_get_docs",
    label: "Context7: Query Documentation",
    description:
      "Use this tool to retrieve detailed, version-specific documentation and real code examples from Context7 for a programming language, framework, or library. " +
      "Call this when the user needs implementation details, code snippets, configuration examples, best practices, or answers to technical questions about a specific language, framework, or library. " +
      "You should usually call context7_search first to obtain the correct Library ID. Prefer this tool when you need reliable, current technical documentation rather than general explanations.",
    parameters: context7GetDocsSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let apiKey = await resolveSecret("context7");
      if (!apiKey) {
        const r = await onboardSecret(ctx, { name: "context7", label: "Context7" });
        if (r.ok) {
          apiKey = await resolveSecret("context7");
        }
      }
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "Documentation retrieval cancelled: no Context7 API key provided.",
            },
          ],
          details: { error: "missing_api_key" },
        };
      }

      try {
        const url = new URL("/api/v2/context", CONTEXT7_API_BASE);
        url.searchParams.set("libraryId", params.libraryId);
        url.searchParams.set("query", params.query);
        url.searchParams.set("type", "json");

        const response = await fetch(url.toString(), {
          signal,
          headers: { Authorization: `Bearer ${apiKey}` },
        });

        if (!response.ok) {
          if (response.status === 401) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Context7 API error: 401 Unauthorized. Your Context7 API key " +
                    "may be missing or invalid. Run /context7_setup to configure it.",
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
                    "Context7 API error: 429 Too Many Requests. You are being rate " +
                    "limited — please wait a moment and try again.",
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
                text:
                  "Context7 API error: " +
                  String(response.status) +
                  " " +
                  response.statusText +
                  "\n" +
                  errorText,
              },
            ],
            details: { status: response.status, body: errorText },
          };
        }

        const data = (await response.json()) as Context7DocsResponse;
        return {
          content: [{ type: "text", text: formatDocs(data, params.query) }],
          details: { libraryId: params.libraryId, query: params.query, raw: data },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching Context7 documentation: ${message}`,
            },
          ],
          details: { error: message },
        };
      }
    },
  });
}
