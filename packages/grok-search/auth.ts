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

import { readFile } from "node:fs/promises";
import { readAuthJson, resolveSecret } from "@jmcombs/pi-1password";
import { agentSettingsPath, updateAuthJson, updateSettingsJson } from "@jmcombs/pi-agent-files";

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

function settingsPath(): string {
  return agentSettingsPath();
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
  await updateSettingsJson((current) => {
    const base = current ?? {};
    const existing =
      base[SETTINGS_KEY] &&
      typeof base[SETTINGS_KEY] === "object" &&
      !Array.isArray(base[SETTINGS_KEY])
        ? (base[SETTINGS_KEY] as Record<string, unknown>)
        : {};
    return { ...base, [SETTINGS_KEY]: { ...existing, credential: source } };
  });
}

export async function hasXaiOAuth(): Promise<boolean> {
  const parsed = await readAuthJson();
  return isXaiOAuthEntry(parsed.xai);
}

async function persistOAuthCredential(next: XaiOAuthCredential): Promise<void> {
  await updateAuthJson((current) => ({
    ...(current ?? {}),
    xai: next,
  }));
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
