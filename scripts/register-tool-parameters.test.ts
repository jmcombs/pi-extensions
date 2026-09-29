/**
 * Loads each extension factory against a recording stub and asserts every
 * registerTool parameters value is a non-null non-array object schema.
 * Phase 3 adds the 1password factory to this file.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import template from "../packages/_template/index.js";
import onePassword from "../packages/1password/index.js";
import betterToolsy from "../packages/better-toolsy/index.js";
import bluePsl10k from "../packages/blue-psl-10k/index.js";
import context7 from "../packages/context7/index.js";
import grokSearch from "../packages/grok-search/index.js";
import headroom from "../packages/headroom/index.js";
import notify from "../packages/notify/index.js";
import promptEnhancer from "../packages/prompt-enhancer/index.js";
import relay from "../packages/relay/index.js";
import steward from "../packages/steward/index.js";
import tavilySearch from "../packages/tavily-search/index.js";

interface RecordedTool {
  name: string;
  parameters: unknown;
}

function createRecordingApi(): { api: ExtensionAPI; tools: RecordedTool[] } {
  const tools: RecordedTool[] = [];
  const api = {
    on: () => {},
    registerTool: (tool: RecordedTool) => {
      tools.push({ name: tool.name, parameters: tool.parameters });
    },
    registerCommand: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerProvider: () => {},
  } as unknown as ExtensionAPI;
  return { api, tools };
}

function assertObjectParameterSchema(parameters: unknown): void {
  expect(parameters !== null && typeof parameters === "object" && !Array.isArray(parameters)).toBe(
    true,
  );
  expect((parameters as { type?: unknown }).type).toBe("object");
}

async function loadFactory(
  factory: (pi: ExtensionAPI) => void | Promise<void>,
): Promise<RecordedTool[]> {
  const { api, tools } = createRecordingApi();
  await factory(api);
  return tools;
}

const cases: {
  dir: string;
  factory: (pi: ExtensionAPI) => void | Promise<void>;
  names: string[];
}[] = [
  {
    dir: "better-toolsy",
    factory: betterToolsy,
    names: ["ls", "read", "grep", "find", "edit", "write"],
  },
  { dir: "context7", factory: context7, names: ["context7_search", "context7_get_docs"] },
  { dir: "grok-search", factory: grokSearch, names: ["grok_search"] },
  { dir: "headroom", factory: headroom, names: ["headroom_retrieve"] },
  { dir: "tavily-search", factory: tavilySearch, names: ["tavily_search"] },
  { dir: "_template", factory: template, names: ["example_echo"] },
  { dir: "notify", factory: notify, names: [] },
  { dir: "blue-psl-10k", factory: bluePsl10k, names: [] },
  { dir: "prompt-enhancer", factory: promptEnhancer, names: [] },
  { dir: "steward", factory: steward, names: [] },
  { dir: "relay", factory: relay, names: [] },
];

describe("registerTool object parameter schemas", () => {
  for (const entry of cases) {
    it(`Type.Object parameters: ${entry.dir}`, async () => {
      const tools = await loadFactory(entry.factory);
      expect(tools.map((tool) => tool.name)).toEqual(entry.names);
      for (const tool of tools) {
        assertObjectParameterSchema(tool.parameters);
      }
    });
  }

  it("Type.Object parameters: 1password", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "1p-schema-"));
    const savedHome = process.env.HOME;
    const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = tmp;
    process.env.PI_CODING_AGENT_DIR = tmp;
    try {
      const tools = await loadFactory(onePassword);
      expect(tools.map((tool) => tool.name)).toEqual(["bash", "1p_diagnose"]);
      for (const tool of tools) {
        assertObjectParameterSchema(tool.parameters);
      }
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    }
  }, 30000);
});
