/**
 * Locked read-modify-write helpers for the Pi agent directory's auth.json and
 * settings.json.
 *
 * Writes go through `writeFile` on the exact path (so an existing symlink stays
 * a symlink and its target is updated). A new auth.json is mode 0o600 and a new
 * auth parent directory is 0o700. Existing paths are never chmod'd, and a
 * settings parent is created with no mode, only when a write actually happens.
 * This module does not migrate settings, reject top-level strings, or run
 * `!op read`.
 */

import { mkdir, readFile, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { lock } from "proper-lockfile";

export type AgentJsonObject = Record<string, unknown>;

/** `undefined` means the file is missing. Return `undefined` to skip the write. */
export type AgentJsonMutate = (current: AgentJsonObject | undefined) => AgentJsonObject | undefined;

export interface AgentFileUpdateOptions {
  readonly agentDir?: string;
}

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_DEADLINE_MS = LOCK_STALE_MS + 15_000;

interface WritePolicy {
  readonly kind: "auth.json" | "settings.json";
  readonly emptyIsObject: boolean;
  readonly parentMode: number | undefined;
  readonly createMode: number | undefined;
}

const AUTH_POLICY: WritePolicy = {
  kind: "auth.json",
  emptyIsObject: true,
  parentMode: 0o700,
  createMode: 0o600,
};

const SETTINGS_POLICY: WritePolicy = {
  kind: "settings.json",
  emptyIsObject: false,
  parentMode: undefined,
  createMode: undefined,
};

export function agentAuthPath(agentDir?: string): string {
  return join(agentDir ?? getAgentDir(), "auth.json");
}

export function agentSettingsPath(agentDir?: string): string {
  return join(agentDir ?? getAgentDir(), "settings.json");
}

export async function updateAuthJson(
  mutate: AgentJsonMutate,
  options?: AgentFileUpdateOptions,
): Promise<void> {
  await updateAgentJson(AUTH_POLICY, agentAuthPath(options?.agentDir), mutate);
}

export async function updateSettingsJson(
  mutate: AgentJsonMutate,
  options?: AgentFileUpdateOptions,
): Promise<void> {
  await updateAgentJson(SETTINGS_POLICY, agentSettingsPath(options?.agentDir), mutate);
}

async function updateAgentJson(
  policy: WritePolicy,
  filePath: string,
  mutate: AgentJsonMutate,
): Promise<void> {
  const parent = dirname(filePath);
  const parentExisted = await directoryExists(parent);
  // proper-lockfile creates `<path>.lock` beside the file, so the parent has to
  // exist before the lock. A skipped write removes a parent this call created.
  if (!parentExisted) await ensureParent(parent, policy.parentMode);

  const release = await acquireLock(filePath);
  let wrote = false;
  try {
    const current = await readCurrent(filePath, policy);
    const next = mutate(current);
    if (next === undefined) return;
    await writeNext(filePath, next, policy, current === undefined);
    wrote = true;
  } finally {
    await release();
    if (!parentExisted && !wrote) await removeDirIfEmpty(parent);
  }
}

function retryableLockCodes(): ReadonlySet<string> {
  // Windows mkdir reports an existing lock directory as EPERM, not EEXIST, so
  // proper-lockfile surfaces EPERM instead of ELOCKED. Retry only that case.
  if (process.platform === "win32") return new Set(["ELOCKED", "EPERM"]);
  return new Set(["ELOCKED"]);
}

async function acquireLock(filePath: string): Promise<() => Promise<void>> {
  const retryable = retryableLockCodes();
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    try {
      return await lock(filePath, {
        realpath: false,
        stale: LOCK_STALE_MS,
        retries: 0,
      });
    } catch (error) {
      const code = errnoCode(error);
      if (code === undefined || !retryable.has(code)) throw error;
      if (Date.now() - started >= LOCK_RETRY_DEADLINE_MS) throw error;
      attempt += 1;
      await delay(Math.min(20 + (attempt % 30), 200));
    }
  }
}

async function readCurrent(
  filePath: string,
  policy: WritePolicy,
): Promise<AgentJsonObject | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
  const text = stripUtf8Bom(raw);
  if (text.trim().length === 0) {
    if (policy.emptyIsObject) return {};
    throw new Error(`${policy.kind} is not valid JSON: file is empty`);
  }
  return parseJsonObject(text, policy.kind);
}

async function writeNext(
  filePath: string,
  next: AgentJsonObject,
  policy: WritePolicy,
  creating: boolean,
): Promise<void> {
  await ensureParent(dirname(filePath), policy.parentMode);
  const payload = JSON.stringify(next, null, 2);
  if (creating && policy.createMode !== undefined) {
    await writeFile(filePath, payload, { encoding: "utf8", mode: policy.createMode });
    return;
  }
  await writeFile(filePath, payload, "utf8");
}

async function ensureParent(dir: string, mode: number | undefined): Promise<void> {
  if (mode === undefined) {
    await mkdir(dir, { recursive: true });
    return;
  }
  await mkdir(dir, { recursive: true, mode });
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function removeDirIfEmpty(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return;
    throw error;
  }
}

function parseJsonObject(text: string, kind: string): AgentJsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${kind} is not valid JSON: ${detail}`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`${kind} is not valid JSON: expected an object`);
  }
  return parsed;
}

function isJsonObject(value: unknown): value is AgentJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripUtf8Bom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1);
  return text;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
