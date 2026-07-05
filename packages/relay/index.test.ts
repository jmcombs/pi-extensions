/**
 * Unit tests — provider registration surface (index.ts), the driver tool-name map
 * (D10, now in drivers/claude.ts), and the roles resolver (frontmatter parse,
 * persona+skills assembly, and skill-reference → full-content inlining).
 *
 * These are meaningful, network-free tests. The live end-to-end path (a real
 * `claude -p` run through pi's subagent system) is proven separately by Gate 3.1.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import {
  claudeDriver,
  isReadOnlyPosture,
  mapToolName,
  mapToolNames,
  readOnlySandboxSettings,
} from "./drivers/claude.js";
import factory from "./index.js";
import { expandSkillReferences, parseRoleFile, resolveRole } from "./roles/resolver.js";

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

describe("claudeDriver — tool-name map (D10, in the driver)", () => {
  it("maps pi tool names to Claude tool names", () => {
    expect(mapToolName("read")).toBe("Read");
    expect(mapToolName("BASH")).toBe("Bash");
    expect(mapToolName("edit")).toBe("Edit");
    expect(mapToolName("write")).toBe("Write");
    expect(mapToolName("grep")).toBe("Grep");
    // pi has no `glob`; its glob-style tool is `find` → Claude `Glob`.
    expect(mapToolName("find")).toBe("Glob");
  });

  it("drops the phantom `glob` and other pi-only tools (`ls`, `subagent`)", () => {
    expect(mapToolName("glob")).toBeUndefined();
    expect(mapToolName("ls")).toBeUndefined();
    expect(mapToolName("subagent")).toBeUndefined();
    expect(mapToolNames(["read", "bash", "subagent", "read"])).toEqual(["Read", "Bash"]);
  });

  it("buildArgs emits `--allowedTools` from the neutral pi tool list", () => {
    const args = claudeDriver.buildArgs({
      task: "t",
      model: "opus",
      tools: ["read", "bash", "grep", "find", "subagent"],
    });
    const idx = args.indexOf("--allowedTools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("Read Bash Grep Glob");
    // D2: never a permission-skip flag.
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
});

describe("claudeDriver — per-role execution posture (D12)", () => {
  it("derives read-only from a scoped tool set that omits edit/write", () => {
    expect(isReadOnlyPosture(["read", "bash", "grep", "find"])).toBe(true);
    expect(isReadOnlyPosture(["Read", "BASH"])).toBe(true);
  });

  it("derives a write posture when edit or write is present", () => {
    expect(isReadOnlyPosture(["read", "bash", "edit"])).toBe(false);
    expect(isReadOnlyPosture(["read", "write"])).toBe(false);
    expect(isReadOnlyPosture(["read", "WRITE"])).toBe(false);
  });

  it("treats an empty/undefined tool set as a write posture (no scoped allowlist)", () => {
    // With no declared allowlist the backend runs its full default (write-capable)
    // tool set, so the driver must NOT claim read-only.
    expect(isReadOnlyPosture(undefined)).toBe(false);
    expect(isReadOnlyPosture([])).toBe(false);
  });

  it("read-only sandbox settings deny writes to the working tree but keep the sandbox on", () => {
    const parsed = JSON.parse(readOnlySandboxSettings("/work/tree"));
    expect(parsed.sandbox.enabled).toBe(true);
    expect(parsed.sandbox.failIfUnavailable).toBe(true);
    expect(parsed.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(parsed.sandbox.filesystem.denyWrite).toEqual(["/work/tree"]);
  });

  it("buildArgs enforces the sandbox + disallowed mutation tools for a read-only role", () => {
    const args = claudeDriver.buildArgs({
      task: "t",
      model: "opus",
      cwd: "/work/tree",
      tools: ["read", "bash", "grep", "find"],
    });
    expect(args).toContain("--disallowedTools");
    expect(args).toContain("Edit Write NotebookEdit");
    const sIdx = args.indexOf("--settings");
    expect(sIdx).toBeGreaterThanOrEqual(0);
    const settings = JSON.parse(args[sIdx + 1] ?? "{}");
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.filesystem.denyWrite).toEqual(["/work/tree"]);
    // D2 still holds: no permission-skip flag.
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("buildArgs adds NO sandbox for a write-capable role", () => {
    const args = claudeDriver.buildArgs({
      task: "t",
      model: "opus",
      cwd: "/work/tree",
      tools: ["read", "bash", "edit", "write"],
    });
    expect(args).not.toContain("--settings");
    expect(args).not.toContain("--disallowedTools");
  });
});

describe("roles resolver — frontmatter + assembly (backend-neutral)", () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
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

  it("assembles persona body + full skill bodies and keeps tools pi-neutral", () => {
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
    // Resolver is backend-neutral (D10): tools are pi names, unmapped/undropped.
    expect(role.tools).toEqual(["read", "bash", "subagent"]);
    expect(role.systemPrompt).toContain("You are the tester persona.");
    expect(role.systemPrompt).toContain("Alpha skill body.");
    expect(role.systemPrompt).toContain("Beta skill body.");
  });
});

describe("roles resolver — expandSkillReferences (fidelity)", () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  it("inlines each referenced SKILL.md's full body into the system prompt", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-relay-skills-"));
    roots.push(root);
    const skillFile = path.join(root, "phase-verify", "SKILL.md");
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, "PHASE VERIFY METHODOLOGY BODY.");

    const systemPrompt = [
      "You are `verifier`. Persona body.",
      "",
      "<available_skills>",
      "  <skill>",
      "    <name>phase-verify</name>",
      "    <description>Adversarial verification.</description>",
      `    <location>${skillFile}</location>`,
      "  </skill>",
      "</available_skills>",
    ].join("\n");

    const expanded = expandSkillReferences(systemPrompt);
    // References preserved AND full body inlined (not just the pointer).
    expect(expanded).toContain("<available_skills>");
    expect(expanded).toContain("<skill_contents>");
    expect(expanded).toContain("PHASE VERIFY METHODOLOGY BODY.");
  });

  it("returns the prompt unchanged when there is no <available_skills> block", () => {
    expect(expandSkillReferences("just a persona, no skills")).toBe("just a persona, no skills");
    expect(expandSkillReferences(undefined)).toBe("");
  });
});
