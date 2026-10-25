import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPromptEnhancerModel,
  clearPromptEnhancerThinking,
  interpretPromptEnhancerModel,
  interpretPromptEnhancerThinking,
  PROMPT_ENHANCER_MODEL_KEY,
  PROMPT_ENHANCER_THINKING_KEY,
  readPromptEnhancerModel,
  readPromptEnhancerThinking,
  writePromptEnhancerModel,
  writePromptEnhancerThinking,
} from "./settings.js";

let dir: string;
let prevAgentDir: string | undefined;

async function writeSettings(obj: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, "settings.json"), `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

async function readSettings(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "prompt-enhancer-settings-"));
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  await rm(dir, { recursive: true, force: true });
});

describe("interpretPromptEnhancerModel", () => {
  it("treats a missing, null, or empty value as inherit and a non-string as invalid", () => {
    expect(interpretPromptEnhancerModel(false, undefined)).toEqual({ kind: "inherit" });
    expect(interpretPromptEnhancerModel(true, null)).toEqual({ kind: "inherit" });
    expect(interpretPromptEnhancerModel(true, "")).toEqual({ kind: "inherit" });
    expect(interpretPromptEnhancerModel(true, "relay-claude/opus-5-5")).toEqual({
      kind: "model",
      id: "relay-claude/opus-5-5",
    });
    expect(interpretPromptEnhancerModel(true, { provider: "x" })).toEqual({ kind: "invalid" });
  });
});

describe("promptEnhancerModel settings.json", () => {
  it("writes the key, preserves unrelated settings, and deletes the key on clear", async () => {
    await writeSettings({ defaultModel: "keep-me", [PROMPT_ENHANCER_MODEL_KEY]: 12 });
    expect(await readPromptEnhancerModel()).toEqual({ kind: "invalid" });
    expect(await readSettings()).toMatchObject({ [PROMPT_ENHANCER_MODEL_KEY]: 12 });

    await writePromptEnhancerModel("owner/name/model");
    expect(await readPromptEnhancerModel()).toEqual({ kind: "model", id: "owner/name/model" });
    expect(await readSettings()).toMatchObject({
      defaultModel: "keep-me",
      [PROMPT_ENHANCER_MODEL_KEY]: "owner/name/model",
    });

    await clearPromptEnhancerModel();
    const cleared = await readSettings();
    expect(cleared.defaultModel).toBe("keep-me");
    expect(Object.hasOwn(cleared, PROMPT_ENHANCER_MODEL_KEY)).toBe(false);
    expect(await readPromptEnhancerModel()).toEqual({ kind: "inherit" });
  });

  it("inherits when settings.json is missing", async () => {
    expect(await readPromptEnhancerModel()).toEqual({ kind: "inherit" });
    expect(await readPromptEnhancerThinking()).toEqual({ kind: "inherit" });
  });

  it("stores a thinking level without removing the model key", async () => {
    await writePromptEnhancerModel("anthropic/claude-sonnet-5");
    await writePromptEnhancerThinking("high");
    expect(await readPromptEnhancerThinking()).toEqual({ kind: "model", id: "high" });
    expect(await readPromptEnhancerModel()).toEqual({
      kind: "model",
      id: "anthropic/claude-sonnet-5",
    });
    expect(interpretPromptEnhancerThinking(true, "nope")).toEqual({ kind: "invalid" });

    await clearPromptEnhancerThinking();
    const cleared = await readSettings();
    expect(cleared[PROMPT_ENHANCER_MODEL_KEY]).toBe("anthropic/claude-sonnet-5");
    expect(Object.hasOwn(cleared, PROMPT_ENHANCER_THINKING_KEY)).toBe(false);
  });
});
