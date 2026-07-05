/**
 * Unit tests — provider registration surface (index.ts) + the roles resolver
 * (tool-name map, frontmatter parse, persona+skills assembly).
 *
 * These are meaningful, network-free tests: they assert the factory registers the
 * `relay-claude` provider with a custom `streamSimple` and an `opus` model, and
 * that the resolver maps/drops tools and assembles a role's system prompt from
 * disk fixtures. The live end-to-end path (a real `claude -p` run through pi's
 * subagent system) is proven separately by Gate 3.1.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import factory from "./index.js";
import { mapToolName, mapToolNames, parseRoleFile, resolveRole } from "./roles/resolver.js";

interface CapturedProvider {
  name: string;
  config: {
    api?: string;
    baseUrl?: string;
    apiKey?: string;
    streamSimple?: unknown;
    models?: { id: string; name: string }[];
  };
}

function createApiStub(): { api: ExtensionAPI; providers: CapturedProvider[] } {
  const providers: CapturedProvider[] = [];
  const notImplemented = (method: string) => () => {
    throw new Error(`ExtensionAPI.${method} not implemented in test stub`);
  };
  const api = {
    registerProvider: ((name: string, config: CapturedProvider["config"]) => {
      providers.push({ name, config });
    }) as unknown as ExtensionAPI["registerProvider"],
    unregisterProvider: notImplemented("unregisterProvider"),
    registerTool: notImplemented("registerTool"),
    on: notImplemented("on"),
    events: { emit: notImplemented("events.emit") },
  } as unknown as ExtensionAPI;
  return { api, providers };
}

describe("@jmcombs/pi-relay — provider registration", () => {
  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers the relay-claude provider with a custom streamSimple and opus model", () => {
    const { api, providers } = createApiStub();
    factory(api);

    expect(providers).toHaveLength(1);
    const provider = providers[0];
    if (!provider) throw new Error("no provider registered");
    expect(provider.name).toBe("relay-claude");
    expect(provider.config.api).toBe("relay-claude");
    expect(typeof provider.config.streamSimple).toBe("function");
    // baseUrl + apiKey are required by pi's provider validation but unused.
    expect(provider.config.baseUrl).toBeTruthy();
    expect(provider.config.apiKey).toBeTruthy();
    const modelIds = (provider.config.models ?? []).map((m) => m.id);
    expect(modelIds).toContain("opus");
  });
});

describe("roles resolver — tool-name map", () => {
  it("maps known pi tool names to external names", () => {
    expect(mapToolName("read")).toBe("Read");
    expect(mapToolName("BASH")).toBe("Bash");
    expect(mapToolName("edit")).toBe("Edit");
    expect(mapToolName("write")).toBe("Write");
    expect(mapToolName("grep")).toBe("Grep");
    expect(mapToolName("glob")).toBe("Glob");
  });

  it("drops pi-only tools with no external equivalent and de-duplicates", () => {
    expect(mapToolNames(["read", "bash", "subagent", "read"])).toEqual(["Read", "Bash"]);
  });
});

describe("roles resolver — frontmatter + assembly", () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    // no shared state
  });

  it("parses frontmatter fields and strips the block from the body", () => {
    const { frontmatter, body } = parseRoleFile(
      "---\nname: r\nskills: a, b\ntools: read, bash\nsystemPromptMode: replace\nmodel: relay-claude/opus\n---\nPersona body here.",
    );
    expect(frontmatter.skills).toEqual(["a", "b"]);
    expect(frontmatter.tools).toEqual(["read", "bash"]);
    expect(frontmatter.systemPromptMode).toBe("replace");
    expect(frontmatter.model).toBe("relay-claude/opus");
    expect(body).toBe("Persona body here.");
  });

  it("assembles persona body + skill bodies and maps declared tools", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-relay-test-"));
    roots.push(root);
    const agentsDir = path.join(root, "agents");
    const skillsDir = path.join(root, "skills");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(path.join(skillsDir, "alpha"), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, "beta"), { recursive: true });

    fs.writeFileSync(
      path.join(agentsDir, "tester.md"),
      "---\nname: tester\nskills: alpha, beta\ntools: read, bash, subagent\nsystemPromptMode: replace\n---\nYou are the tester persona.",
    );
    fs.writeFileSync(path.join(skillsDir, "alpha", "SKILL.md"), "Alpha skill body.");
    fs.writeFileSync(path.join(skillsDir, "beta", "SKILL.md"), "Beta skill body.");

    const role = resolveRole("tester", { agentsDir, skillsDir });

    expect(role.name).toBe("tester");
    expect(role.skills).toEqual(["alpha", "beta"]);
    // subagent (pi-only) is dropped from the external allowlist.
    expect(role.allowedTools).toEqual(["Read", "Bash"]);
    expect(role.systemPrompt).toContain("You are the tester persona.");
    expect(role.systemPrompt).toContain("Alpha skill body.");
    expect(role.systemPrompt).toContain("Beta skill body.");
  });
});
