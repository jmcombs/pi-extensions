/**
 * User-level Prompt Enhancer model preference.
 *
 * Lives in the agent-dir settings.json (the file Pi's model picker writes),
 * not in merged project settings. A project key would shadow a save this
 * picker cannot clear.
 */

import { readFile } from "node:fs/promises";
import { agentSettingsPath, updateSettingsJson } from "@jmcombs/pi-agent-files";

export const PROMPT_ENHANCER_MODEL_KEY = "promptEnhancerModel";
export const PROMPT_ENHANCER_THINKING_KEY = "promptEnhancerThinking";

export const ENHANCER_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type EnhancerThinkingLevel = (typeof ENHANCER_THINKING_LEVELS)[number];

export function isEnhancerThinkingLevel(value: unknown): value is EnhancerThinkingLevel {
  return (
    typeof value === "string" && (ENHANCER_THINKING_LEVELS as readonly string[]).includes(value)
  );
}

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
  return agentSettingsPath();
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

export async function readPromptEnhancerModel(): Promise<StoredEnhancerModel> {
  const parsed = await readJsonObject(settingsPath());
  if (!parsed || !Object.hasOwn(parsed, PROMPT_ENHANCER_MODEL_KEY)) return { kind: "inherit" };
  return interpretPromptEnhancerModel(true, parsed[PROMPT_ENHANCER_MODEL_KEY]);
}

export async function writePromptEnhancerModel(id: string): Promise<void> {
  await updateSettingsJson((current) => ({
    ...(current ?? {}),
    [PROMPT_ENHANCER_MODEL_KEY]: id,
  }));
}

export async function clearPromptEnhancerModel(): Promise<void> {
  await clearSettingsKey(PROMPT_ENHANCER_MODEL_KEY);
}

export function interpretPromptEnhancerThinking(
  present: boolean,
  value: unknown,
): StoredEnhancerModel {
  if (!present || value === null || value === "") return { kind: "inherit" };
  if (isEnhancerThinkingLevel(value)) return { kind: "model", id: value };
  return { kind: "invalid" };
}

export async function readPromptEnhancerThinking(): Promise<StoredEnhancerModel> {
  const parsed = await readJsonObject(settingsPath());
  if (!parsed || !Object.hasOwn(parsed, PROMPT_ENHANCER_THINKING_KEY)) {
    return { kind: "inherit" };
  }
  return interpretPromptEnhancerThinking(true, parsed[PROMPT_ENHANCER_THINKING_KEY]);
}

export async function writePromptEnhancerThinking(level: EnhancerThinkingLevel): Promise<void> {
  await updateSettingsJson((current) => ({
    ...(current ?? {}),
    [PROMPT_ENHANCER_THINKING_KEY]: level,
  }));
}

export async function clearPromptEnhancerThinking(): Promise<void> {
  await clearSettingsKey(PROMPT_ENHANCER_THINKING_KEY);
}

async function clearSettingsKey(key: string): Promise<void> {
  await updateSettingsJson((current) => {
    if (!current || !Object.hasOwn(current, key)) return undefined;
    const next = { ...current };
    delete next[key];
    return next;
  });
}
