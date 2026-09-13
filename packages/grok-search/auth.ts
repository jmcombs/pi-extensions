/**
 * Grok Search credential resolution.
 *
 * Preference (`oauth` vs `api_key`) lives in settings.json so it can coexist
 * with both an xAI OAuth entry and a grok API key in auth.json. Pi's
 * AuthStorage only accepts `api_key` / `oauth` credential shapes, so a custom
 * auth.json type is not safe.
 *
 * OAuth access tokens are short-lived; this module refreshes them the same way
 * Pi does (`auth.x.ai` device-code client) and writes the rotated tokens back
 * to the existing `xai` oauth entry — never converting it to `api_key`.
 */

import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readAuthJson, resolveSecret } from "@jmcombs/pi-1password";

export type CredentialSource = "oauth" | "api_key";

export interface ResolvedGrokAuth {
  readonly token: string;
  readonly source: CredentialSource;
}

export interface XaiOAuthCredential {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
}

const SETTINGS_KEY = "grokSearch";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

function authPath(): string {
  return join(getAgentDir(), "auth.json");
}

function settingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

export function isXaiOAuthEntry(entry: unknown): entry is XaiOAuthCredential {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const value = entry as Record<string, unknown>;
  return (
    value.type === "oauth" &&
    typeof value.access === "string" &&
    value.access.length > 0 &&
    typeof value.refresh === "string" &&
    value.refresh.length > 0 &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires)
  );
}

export function isOAuthExpired(expires: number, now: number = Date.now()): boolean {
  return now >= expires;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or invalid → empty object.
  }
  return {};
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const timeoutMs = 5000;
  const start = Date.now();
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      return async (): Promise<void> => {
        try {
          await unlink(lockPath);
        } catch {
          // Already gone.
        }
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
      if (Date.now() - start > timeoutMs) {
        try {
          await unlink(lockPath);
        } catch {
          // Someone else cleared it.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 25)));
    }
  }
}

async function mutateJsonFile(
  path: string,
  mutator: (current: Record<string, unknown>) => Record<string, unknown>,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = getAgentDir();
  await mkdir(dir, { recursive: true });
  const release = await acquireLock(`${path}.lock`);
  try {
    const current = await readJsonObject(path);
    const next = mutator(current);
    const content = `${JSON.stringify(next, null, 2)}\n`;
    const tmpPath = `${path}.tmp.${String(process.pid)}.${Math.random().toString(36).slice(2)}`;
    try {
      await writeFile(tmpPath, content, {
        encoding: "utf8",
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
      });
      if (options.mode !== undefined) await chmod(tmpPath, options.mode);
      await rename(tmpPath, path);
      if (options.mode !== undefined) await chmod(path, options.mode);
    } catch (e) {
      try {
        await unlink(tmpPath);
      } catch {
        // Temp may not exist.
      }
      throw e;
    }
  } finally {
    await release();
  }
}

export async function readCredentialPreference(): Promise<CredentialSource | undefined> {
  const parsed = await readJsonObject(settingsPath());
  const grokSearch = parsed[SETTINGS_KEY];
  if (grokSearch === null || typeof grokSearch !== "object" || Array.isArray(grokSearch)) {
    return undefined;
  }
  const credential = (grokSearch as { credential?: unknown }).credential;
  if (credential === "oauth" || credential === "api_key") return credential;
  return undefined;
}

export async function writeCredentialPreference(source: CredentialSource): Promise<void> {
  await mutateJsonFile(settingsPath(), (current) => {
    const existing =
      current[SETTINGS_KEY] &&
      typeof current[SETTINGS_KEY] === "object" &&
      !Array.isArray(current[SETTINGS_KEY])
        ? (current[SETTINGS_KEY] as Record<string, unknown>)
        : {};
    return { ...current, [SETTINGS_KEY]: { ...existing, credential: source } };
  });
}

export async function hasXaiOAuth(): Promise<boolean> {
  const parsed = await readAuthJson();
  return isXaiOAuthEntry(parsed.xai);
}

async function persistOAuthCredential(next: XaiOAuthCredential): Promise<void> {
  await mutateJsonFile(
    authPath(),
    (current) => ({
      ...current,
      xai: next,
    }),
    { mode: 0o600 },
  );
}

function credentialsFromTokenResponse(
  body: Record<string, unknown>,
  previousRefreshToken: string,
): XaiOAuthCredential {
  const access = body.access_token;
  if (typeof access !== "string" || access.length === 0) {
    throw new Error("Invalid xAI OAuth response field: access_token");
  }
  const refresh =
    body.refresh_token === undefined && previousRefreshToken
      ? previousRefreshToken
      : typeof body.refresh_token === "string" && body.refresh_token.length > 0
        ? body.refresh_token
        : undefined;
  if (!refresh) {
    throw new Error("Invalid xAI OAuth response field: refresh_token");
  }
  const expiresInSeconds =
    body.expires_in === undefined
      ? DEFAULT_TOKEN_LIFETIME_SECONDS
      : typeof body.expires_in === "number" &&
          Number.isFinite(body.expires_in) &&
          body.expires_in > 0
        ? body.expires_in
        : undefined;
  if (expiresInSeconds === undefined) {
    throw new Error("Invalid xAI OAuth response field: expires_in");
  }
  return {
    type: "oauth",
    access,
    refresh,
    expires: Date.now() + expiresInSeconds * 1000 - REFRESH_SKEW_MS,
  };
}

async function refreshXaiToken(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<XaiOAuthCredential> {
  const response = await fetch(XAI_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: XAI_CLIENT_ID,
      refresh_token: refreshToken,
    }),
    signal,
  });
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    throw new Error(`xAI OAuth returned invalid JSON (HTTP ${String(response.status)})`);
  }
  if (!response.ok) {
    const error = typeof body.error === "string" ? body.error : undefined;
    const description =
      typeof body.error_description === "string" ? body.error_description : undefined;
    const detail = [error, description].filter(Boolean).join(": ");
    throw new Error(
      `xAI OAuth token refresh failed (HTTP ${String(response.status)})${detail ? `: ${detail}` : ""}`,
    );
  }
  return credentialsFromTokenResponse(body, refreshToken);
}

/**
 * Return a usable xAI OAuth access token, refreshing and persisting if expired.
 * Fails closed (`undefined`) on a missing/malformed entry or a failed refresh.
 */
export async function resolveOAuthAccessToken(signal?: AbortSignal): Promise<string | undefined> {
  try {
    const parsed = await readAuthJson();
    if (!isXaiOAuthEntry(parsed.xai)) return undefined;
    if (!isOAuthExpired(parsed.xai.expires)) return parsed.xai.access;
    const next = await refreshXaiToken(parsed.xai.refresh, signal);
    await persistOAuthCredential(next);
    return next.access;
  } catch {
    return undefined;
  }
}

async function resolveApiKey(): Promise<string | undefined> {
  return (
    (await resolveSecret("xai_search")) ??
    (await resolveSecret("xai")) ??
    (await resolveSecret("grok"))
  );
}

/**
 * Resolve the Bearer token grok_search should send.
 *
 * - Preference `api_key` → dedicated / provider / grok API key only.
 * - Preference `oauth` → OAuth only (no silent fallthrough to an API key).
 * - Unset → OAuth if present, else API key chain.
 */
export async function resolveGrokAuth(signal?: AbortSignal): Promise<ResolvedGrokAuth | undefined> {
  const preference = await readCredentialPreference();

  if (preference !== "api_key") {
    const oauth = await resolveOAuthAccessToken(signal);
    if (oauth) return { token: oauth, source: "oauth" };
    if (preference === "oauth") return undefined;
  }

  const apiKey = await resolveApiKey();
  if (apiKey) return { token: apiKey, source: "api_key" };
  return undefined;
}
