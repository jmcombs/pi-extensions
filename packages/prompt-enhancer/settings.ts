/**
 * User-level Prompt Enhancer model preference.
 *
 * Lives in the agent-dir settings.json (the file Pi's model picker writes),
 * not in merged project settings. A project key would shadow a save this
 * picker cannot clear.
 */

import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const PROMPT_ENHANCER_MODEL_KEY = "promptEnhancerModel";

export type StoredEnhancerModel =
  | { readonly kind: "inherit" }
  | { readonly kind: "model"; readonly id: string }
  | { readonly kind: "invalid" };

export function interpretPromptEnhancerModel(
  present: boolean,
  value: unknown,
): StoredEnhancerModel {
  if (!present || value === null || value === "") return { kind: "inherit" };
  if (typeof value === "string") return { kind: "model", id: value };
  return { kind: "invalid" };
}

function settingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or invalid JSON is inherit, not an error.
  }
  return undefined;
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
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (Date.now() - start > timeoutMs) {
        try {
          await unlink(lockPath);
        } catch {
          // Someone else cleared it.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function mutateSettings(
  mutator: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const path = settingsPath();
  await mkdir(getAgentDir(), { recursive: true });
  const release = await acquireLock(`${path}.lock`);
  try {
    const current = (await readJsonObject(path)) ?? {};
    const next = mutator(current);
    const tmpPath = `${path}.tmp.${String(process.pid)}`;
    try {
      await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, path);
    } catch (error) {
      try {
        await unlink(tmpPath);
      } catch {
        // Temp may not exist.
      }
      throw error;
    }
  } finally {
    await release();
  }
}

export async function readPromptEnhancerModel(): Promise<StoredEnhancerModel> {
  const parsed = await readJsonObject(settingsPath());
  if (!parsed || !Object.hasOwn(parsed, PROMPT_ENHANCER_MODEL_KEY)) return { kind: "inherit" };
  return interpretPromptEnhancerModel(true, parsed[PROMPT_ENHANCER_MODEL_KEY]);
}

export async function writePromptEnhancerModel(id: string): Promise<void> {
  await mutateSettings((current) => ({ ...current, [PROMPT_ENHANCER_MODEL_KEY]: id }));
}

export async function clearPromptEnhancerModel(): Promise<void> {
  await mutateSettings((current) => {
    if (!Object.hasOwn(current, PROMPT_ENHANCER_MODEL_KEY)) return current;
    const next = { ...current };
    delete next[PROMPT_ENHANCER_MODEL_KEY];
    return next;
  });
}
