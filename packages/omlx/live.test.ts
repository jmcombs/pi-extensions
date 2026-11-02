/**
 * Real omlx only. Skipped unless OMLX_LIVE=1.
 *
 * The gate shell also exports OMLX_BASE_URL, OMLX_API_KEY, and OMLX_TEST_MODEL.
 * No fetch mocks: catalog expectations come from a direct status GET.
 */

import type { ApiKeyCredential, AssistantMessage, Tool } from "@earendil-works/pi-ai";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it } from "vitest";
import { OmlxClient } from "./client.js";
import { createOmlxProvider } from "./provider.js";

const LIVE = process.env.OMLX_LIVE === "1";
const SERVER_URL = process.env.OMLX_BASE_URL?.trim() ?? "";
const API_KEY = process.env.OMLX_API_KEY?.trim() ?? "";
const TEST_MODEL = process.env.OMLX_TEST_MODEL?.trim() ?? "";
const LIVE_TIMEOUT_MS = 600_000;

const getTime = {
  name: "get_time",
  description: "Return the current time",
  parameters: Type.Object({}),
} satisfies Tool;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireLiveEnv(): void {
  if (!SERVER_URL || !API_KEY || !TEST_MODEL) {
    throw new Error("OMLX_LIVE=1 requires OMLX_BASE_URL, OMLX_API_KEY, and OMLX_TEST_MODEL");
  }
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Phase 2 `/model` filter, computed from the raw status body rather than the client. */
function expectedChatIds(payload: unknown): Set<string> {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error("live status payload is not an object with models");
  }
  const ids = new Set<string>();
  for (const row of payload.models) {
    if (!isRecord(row)) continue;
    if (row.loaded !== true || row.is_loading === true || row.is_hidden === true) continue;
    if (row.model_format === "gguf") continue;
    if (row.model_type !== "llm" && row.model_type !== "vlm") continue;
    const alias = typeof row.model_alias === "string" ? row.model_alias.trim() : "";
    const id = alias || (typeof row.id === "string" ? row.id : "");
    if (!id) throw new Error("selectable live row is missing an id");
    ids.add(id);
  }
  return ids;
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(`${SERVER_URL}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

function maxModelLen(payload: unknown, id: string): number {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("live model list is invalid");
  }
  const row = payload.data.find((item) => isRecord(item) && item.id === id);
  if (!isRecord(row) || typeof row.max_model_len !== "number") {
    throw new Error(`${id} has no numeric max_model_len`);
  }
  return row.max_model_len;
}

describe.skipIf(!LIVE)("omlx live catalog and chat", () => {
  const client = new OmlxClient(SERVER_URL || "http://127.0.0.1:8000", API_KEY || undefined);
  const { provider } = createOmlxProvider();

  afterAll(async () => {
    if (!LIVE || !TEST_MODEL || !API_KEY) return;
    await client.load(TEST_MODEL).catch(() => undefined);
  }, LIVE_TIMEOUT_MS);

  it(
    "loads, refreshes, chats, calls a tool, reports zero cost, and aborts",
    async () => {
      requireLiveEnv();
      const credential: ApiKeyCredential = {
        type: "api_key",
        key: API_KEY,
        env: { OMLX_BASE_URL: SERVER_URL },
      };
      const refresh = provider.refreshModels;
      if (!refresh) throw new Error("omlx provider is missing refreshModels");

      await client.load(TEST_MODEL);
      await refresh({
        credential,
        allowNetwork: true,
        signal: AbortSignal.timeout(30_000),
        publish: (publication) => {
          publication.update?.();
          return Promise.resolve(true);
        },
      });

      const expected = expectedChatIds(await fetchJson("/v1/models/status"));
      const published = provider.getModels();
      expect(new Set(published.map((model) => model.id))).toEqual(expected);
      expect(expected.has(TEST_MODEL)).toBe(true);
      const listed = await fetchJson("/v1/models");
      const loaded = published.find((model) => model.id === TEST_MODEL);
      expect(loaded?.contextWindow).toBe(maxModelLen(listed, TEST_MODEL));
      expect(loaded?.baseUrl.endsWith("/v1")).toBe(true);

      await client.unloadAndWait(TEST_MODEL, AbortSignal.timeout(120_000));
      await refresh({
        credential,
        allowNetwork: true,
        signal: AbortSignal.timeout(30_000),
        publish: (publication) => {
          publication.update?.();
          return Promise.resolve(true);
        },
      });
      expect(provider.getModels().some((model) => model.id === TEST_MODEL)).toBe(false);

      await client.load(TEST_MODEL);
      await refresh({
        credential,
        allowNetwork: true,
        signal: AbortSignal.timeout(30_000),
        publish: (publication) => {
          publication.update?.();
          return Promise.resolve(true);
        },
      });
      const model = provider.getModels().find((item) => item.id === TEST_MODEL);
      if (!model) throw new Error(`${TEST_MODEL} was not published after reload`);

      const reply = await provider
        .streamSimple(
          model,
          normalizeContext({
            messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: Date.now() }],
          }),
          { apiKey: API_KEY },
        )
        .result();
      expect(reply.stopReason).toBe("stop");
      expect(textOf(reply)).toContain("OK");
      expect(reply.usage.input).toBeGreaterThan(0);
      expect(reply.usage.cost.total).toBe(0);

      const toolReply = await provider
        .streamSimple(
          model,
          normalizeContext({
            messages: [{ role: "user", content: "Call get_time.", timestamp: Date.now() }],
            tools: [getTime],
          }),
          { apiKey: API_KEY },
        )
        .result();
      const toolCalls = toolReply.content.filter((block) => block.type === "toolCall");
      expect(toolReply.stopReason).toBe("toolUse");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]?.name).toBe("get_time");

      const controller = new AbortController();
      const abortedStream = provider.streamSimple(
        model,
        normalizeContext({
          messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: Date.now() }],
        }),
        { apiKey: API_KEY, signal: controller.signal },
      );
      try {
        for await (const _event of abortedStream) {
          controller.abort();
          break;
        }
      } catch {
        // Aborting the iterator can reject; the message still records the stop.
      }
      const aborted = await abortedStream.result();
      expect(aborted.stopReason).toBe("aborted");
    },
    LIVE_TIMEOUT_MS,
  );
});
