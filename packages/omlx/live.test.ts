/**
 * Real omlx only. Skipped unless OMLX_LIVE=1.
 *
 * The gate shell also exports OMLX_BASE_URL, OMLX_API_KEY, and OMLX_TEST_MODEL.
 * No fetch mocks and no local stand-in: catalog expectations come from a direct
 * status GET. The cached-window proof discovers a temporary model on this server.
 */

import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AnyModel,
  ApiKeyCredential,
  AssistantMessage,
  Model,
  Tool,
} from "@earendil-works/pi-ai";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it } from "vitest";
import { OmlxClient } from "./client.js";
import { createOmlxProvider } from "./provider.js";

const LIVE = process.env.OMLX_LIVE === "1";
const SERVER_URL = process.env.OMLX_BASE_URL?.trim() ?? "";
const API_KEY = process.env.OMLX_API_KEY?.trim() ?? "";
const TEST_MODEL = process.env.OMLX_TEST_MODEL?.trim() ?? "";
const LIVE_TIMEOUT_MS = 600_000;
const RELOAD_TIMEOUT_MS = 300_000;
const LOAD_TIMEOUT_MS = 600_000;
const CACHE_PROOF_TIMEOUT_MS = 1_200_000;
/** Discovered on the live server for this test, then deleted. Not a fixture row. */
const NULL_CONTEXT_ID = "omlx-phase2-null-context";
const CACHED_WINDOW = 424242;
const CONTEXT_KEYS = [
  "max_position_embeddings",
  "max_seq_len",
  "max_seq_length",
  "seq_length",
  "n_positions",
] as const;

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

function statusModels(payload: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error("live status payload is not an object with models");
  }
  return payload.models.filter(isRecord);
}

function statusRow(payload: unknown, id: string): Record<string, unknown> | undefined {
  return statusModels(payload).find((row) => row.id === id);
}

function loadedIds(payload: unknown): string[] {
  const ids: string[] = [];
  for (const row of statusModels(payload)) {
    if (row.loaded === true && typeof row.id === "string") ids.push(row.id);
  }
  return ids;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOpenAiChat(model: AnyModel): model is Model<"openai-completions"> {
  return (
    model.provider === "omlx" &&
    model.api === "openai-completions" &&
    "contextWindow" in model &&
    "maxTokens" in model &&
    "name" in model
  );
}

/** Smallest MLX llm directory on this server. The clone is deleted after the proof. */
function nullContextSource(payload: unknown): string {
  const preferred = statusRow(payload, "SmolLM-135M-Instruct-4bit");
  if (typeof preferred?.model_path === "string" && preferred.model_path.length > 0) {
    return preferred.model_path;
  }
  let best: { path: string; size: number } | undefined;
  for (const row of statusModels(payload)) {
    if (row.model_type !== "llm" || row.model_format === "gguf") continue;
    if (typeof row.model_path !== "string") continue;
    const size =
      typeof row.estimated_size === "number" ? row.estimated_size : Number.POSITIVE_INFINITY;
    if (!best || size < best.size) best = { path: row.model_path, size };
  }
  if (!best) throw new Error("live server has no MLX llm directory to clone");
  return best.path;
}

function stripDeclaredContext(filePath: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;
  for (const key of CONTEXT_KEYS) delete parsed[key];
  for (const nest of ["text_config", "language_config"]) {
    const nested = parsed[nest];
    if (!isRecord(nested)) continue;
    for (const key of CONTEXT_KEYS) delete nested[key];
  }
  if (filePath.endsWith("tokenizer_config.json")) delete parsed.model_max_length;
  writeFileSync(filePath, JSON.stringify(parsed));
}

function cloneWithoutDeclaredContext(sourcePath: string): string {
  const dest = join(dirname(sourcePath), NULL_CONTEXT_ID);
  rmSync(dest, { recursive: true, force: true });
  cpSync(sourcePath, dest, { recursive: true });
  stripDeclaredContext(join(dest, "config.json"));
  stripDeclaredContext(join(dest, "tokenizer_config.json"));
  return dest;
}

function restoreLoadConfigs(sourcePath: string, dest: string): void {
  for (const name of ["config.json", "tokenizer_config.json"]) {
    cpSync(join(sourcePath, name), join(dest, name));
  }
}

async function liveFetch(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${API_KEY}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${SERVER_URL}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  if (text.trim() === "") return undefined;
  return JSON.parse(text) as unknown;
}

function listedMaxModelLen(payload: unknown, id: string): number | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined;
  const row = payload.data.find((item) => isRecord(item) && item.id === id);
  if (!isRecord(row) || typeof row.max_model_len !== "number") return undefined;
  return row.max_model_len;
}

async function deleteNullContextModel(): Promise<void> {
  try {
    await liveFetch(
      `/admin/api/hf/models/${encodeURIComponent(NULL_CONTEXT_ID)}`,
      { method: "DELETE" },
      RELOAD_TIMEOUT_MS,
    );
  } catch (error) {
    if (!errorText(error).includes("HTTP 404")) throw error;
  }
}

async function restoreLoaded(ids: readonly string[]): Promise<void> {
  const failures: string[] = [];
  for (const id of ids) {
    try {
      await liveFetch(
        `/v1/models/${encodeURIComponent(id)}/load`,
        { method: "POST" },
        LOAD_TIMEOUT_MS,
      );
    } catch (error) {
      failures.push(`${id}: ${errorText(error)}`);
    }
  }
  const status = await fetchJson("/v1/models/status");
  for (const id of ids) {
    if (statusRow(status, id)?.loaded !== true) failures.push(`${id} is not loaded after restore`);
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
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

  it(
    "applies a stored context window when the live status length is null",
    async () => {
      requireLiveEnv();
      const before = await fetchJson("/v1/models/status");
      const previouslyLoaded = loadedIds(before);
      const sourcePath = nullContextSource(before);
      const clonedDir = join(dirname(sourcePath), NULL_CONTEXT_ID);
      let testError: unknown;
      let restoreError: unknown;
      try {
        // Discovery freezes model_context_length. Strip it, rescan, then put the
        // real config back so the engine can load without a second rescan.
        cloneWithoutDeclaredContext(sourcePath);
        await liveFetch("/admin/api/reload", { method: "POST" }, RELOAD_TIMEOUT_MS);
        const discovered = statusRow(await fetchJson("/v1/models/status"), NULL_CONTEXT_ID);
        if (!discovered) throw new Error("rescan did not discover the null-context model");
        if (discovered.model_context_length !== null) {
          throw new Error("discovered model still has a context length");
        }
        restoreLoadConfigs(sourcePath, clonedDir);
        await liveFetch(
          `/v1/models/${encodeURIComponent(NULL_CONTEXT_ID)}/load`,
          { method: "POST" },
          LOAD_TIMEOUT_MS,
        );
        await liveFetch(
          `/admin/api/models/${encodeURIComponent(NULL_CONTEXT_ID)}/settings`,
          { method: "PUT", body: JSON.stringify({ max_context_window: 0 }) },
          30_000,
        );

        const loaded = statusRow(await fetchJson("/v1/models/status"), NULL_CONTEXT_ID);
        expect(loaded?.loaded).toBe(true);
        expect(loaded?.model_context_length).toBeNull();
        expect(loaded?.is_loading).toBe(false);
        expect(loaded?.is_hidden).toBe(false);
        expect(loaded?.model_type).toBe("llm");
        expect(loaded?.model_format).not.toBe("gguf");
        const maxLen = listedMaxModelLen(await fetchJson("/v1/models"), NULL_CONTEXT_ID);
        if (typeof maxLen === "number" && maxLen > 0) {
          throw new Error(`live max_model_len ${maxLen} would hide the cached window`);
        }

        const { provider: fresh } = createOmlxProvider();
        const refresh = fresh.refreshModels;
        if (!refresh) throw new Error("omlx provider is missing refreshModels");
        const stored: Model<"openai-completions"> = {
          id: NULL_CONTEXT_ID,
          name: "stale-name",
          api: "openai-completions",
          provider: "omlx",
          baseUrl: `${SERVER_URL}/v1`,
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: CACHED_WINDOW,
          maxTokens: 999,
        };
        const foreign: Model<"openai-completions"> = {
          ...stored,
          provider: "other",
          contextWindow: 111,
          maxTokens: 111,
        };
        const credential: ApiKeyCredential = {
          type: "api_key",
          key: API_KEY,
          env: { OMLX_BASE_URL: SERVER_URL },
        };
        const persisted: Model<"openai-completions">[] = [];
        await refresh({
          credential,
          allowNetwork: true,
          signal: AbortSignal.timeout(30_000),
          stored: { models: [stored, foreign] },
          publish: (publication) => {
            publication.update?.();
            if (publication.persist) {
              for (const model of publication.persist.models) {
                if (isOpenAiChat(model)) persisted.push(model);
              }
            }
            return Promise.resolve(true);
          },
        });
        const published = persisted.find((model) => model.id === NULL_CONTEXT_ID);
        // Dropping the cached argument publishes 128000. Copying the stored model
        // keeps the stale name. A foreign window must not win.
        expect(published?.name).toBe(NULL_CONTEXT_ID);
        expect(published?.contextWindow).toBe(CACHED_WINDOW);
        expect(published?.maxTokens).toBe(CACHED_WINDOW);
        expect(fresh.getModels().find((model) => model.id === NULL_CONTEXT_ID)?.contextWindow).toBe(
          CACHED_WINDOW,
        );
      } catch (error) {
        testError = error;
      } finally {
        try {
          await deleteNullContextModel();
          rmSync(clonedDir, { recursive: true, force: true });
          await restoreLoaded(previouslyLoaded);
        } catch (error) {
          restoreError = error;
        }
      }
      if (testError && restoreError) {
        throw new Error(`${errorText(testError)}; restore failed: ${errorText(restoreError)}`, {
          cause: testError,
        });
      }
      if (restoreError) throw restoreError;
      if (testError) throw testError;
    },
    CACHE_PROOF_TIMEOUT_MS,
  );
});
