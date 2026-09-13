/**
 * Credential resolution tests — no mocks of xAI.
 *
 * Exercises real auth.json / settings.json I/O under a temporary
 * `PI_CODING_AGENT_DIR`. API-key resolution uses `!echo` sentinels so no
 * 1Password session is required. OAuth refresh against auth.x.ai is not
 * covered here (that needs a live token); unexpired OAuth is read from disk.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasXaiOAuth,
  isOAuthExpired,
  isXaiOAuthEntry,
  readCredentialPreference,
  resolveGrokAuth,
  writeCredentialPreference,
} from "./auth.js";

let dir: string;
let prevAgentDir: string | undefined;

async function writeAuth(obj: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, "auth.json"), `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

async function writeSettings(obj: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, "settings.json"), `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

async function readSettings(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grok-search-auth-"));
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  await rm(dir, { recursive: true, force: true });
});

describe("isXaiOAuthEntry", () => {
  it("accepts a well-formed oauth credential", () => {
    expect(
      isXaiOAuthEntry({
        type: "oauth",
        access: "tok",
        refresh: "ref",
        expires: Date.now() + 60_000,
      }),
    ).toBe(true);
  });

  it("rejects an api_key entry and a malformed oauth entry", () => {
    expect(isXaiOAuthEntry({ type: "api_key", key: "xai-..." })).toBe(false);
    expect(isXaiOAuthEntry({ type: "oauth", access: "tok" })).toBe(false);
    expect(isXaiOAuthEntry(undefined)).toBe(false);
  });
});

describe("isOAuthExpired", () => {
  it("is expired at or after `expires`, not before", () => {
    expect(isOAuthExpired(100, 99)).toBe(false);
    expect(isOAuthExpired(100, 100)).toBe(true);
    expect(isOAuthExpired(100, 101)).toBe(true);
  });
});

describe("resolveGrokAuth", () => {
  const future = Date.now() + 60 * 60 * 1000;

  it("uses unexpired xAI OAuth when no preference is set", async () => {
    await writeAuth({
      xai: { type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: future },
      grok: { type: "api_key", key: "!echo grok-api-key" },
    });
    await expect(resolveGrokAuth()).resolves.toEqual({ token: "oauth-access", source: "oauth" });
    await expect(hasXaiOAuth()).resolves.toBe(true);
  });

  it("uses the API-key chain when preference is api_key even if OAuth exists", async () => {
    await writeAuth({
      xai: { type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: future },
      grok: { type: "api_key", key: "!echo grok-api-key" },
    });
    await writeCredentialPreference("api_key");
    await expect(resolveGrokAuth()).resolves.toEqual({ token: "grok-api-key", source: "api_key" });
  });

  it("does not fall through to an API key when preference is oauth but OAuth is missing", async () => {
    await writeAuth({ grok: { type: "api_key", key: "!echo grok-api-key" } });
    await writeCredentialPreference("oauth");
    await expect(resolveGrokAuth()).resolves.toBeUndefined();
  });

  it("falls through to xai_search / xai / grok API keys when OAuth is absent", async () => {
    await writeAuth({
      xai_search: { type: "api_key", key: "!echo dedicated-search-key" },
      grok: { type: "api_key", key: "!echo grok-api-key" },
    });
    await expect(resolveGrokAuth()).resolves.toEqual({
      token: "dedicated-search-key",
      source: "api_key",
    });
  });

  it("returns undefined when nothing is configured", async () => {
    await writeAuth({});
    await expect(resolveGrokAuth()).resolves.toBeUndefined();
    await expect(hasXaiOAuth()).resolves.toBe(false);
  });
});

describe("credential preference persistence", () => {
  it("round-trips oauth / api_key and preserves unrelated settings.json keys", async () => {
    await writeSettings({ theme: "keep-me", grokSearch: { extra: true } });
    await writeCredentialPreference("oauth");
    expect(await readCredentialPreference()).toBe("oauth");
    await writeCredentialPreference("api_key");
    expect(await readCredentialPreference()).toBe("api_key");
    const stored = await readSettings();
    expect(stored.theme).toBe("keep-me");
    expect(stored.grokSearch).toEqual({ extra: true, credential: "api_key" });
  });
});
