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
import { type AgentDriver, claudeDriver, mapToolName, mapToolNames } from "./drivers/claude.js";
import factory from "./index.js";
import { streamViaDriver } from "./provider.js";
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

describe("streamViaDriver — heartbeat keeps a long run visibly active", () => {
  // A single `claude -p` completion emits nothing until it finishes, so without a
  // heartbeat pi-subagents' parent run flips the child to `needs_attention` at 60s
  // (a FALSE stall). streamViaDriver now opens the stream with `start` and pushes
  // periodic `text_delta` beats; each becomes a pi `message_update` that advances
  // the parent's `lastActivityAt`. This proves beats arrive BEFORE `done` and that
  // the terminal result still rides only on `done` (unaffected by the no-op beats).
  type StreamEvent = {
    type: string;
    message?: { content?: { type: string; text?: string }[] };
  };

  const model = {
    api: "relay-claude",
    provider: "relay-claude",
    id: "opus",
  } as unknown as Parameters<typeof streamViaDriver>[1];

  // Fake backend: a `node -e` child that stays silent ~250ms, then prints one JSON
  // envelope. The wall-clock silence is exactly the window a real verify spends
  // inside `claude -p`; the parent-side heartbeat interval must fill it.
  const fakeDriver: AgentDriver = {
    name: "fake",
    bin: "node",
    buildArgs: () => [
      "-e",
      "setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', result: 'HEARTBEAT_OK', is_error: false })), 250)",
    ],
    parseResult: (stdout: string) => {
      const envelope = JSON.parse(stdout) as { result?: string; is_error?: boolean };
      return { result: String(envelope.result ?? ""), isError: envelope.is_error === true };
    },
  };

  it("pushes `start` then periodic `text_delta` beats before the final `done`", async () => {
    const context = {
      messages: [{ role: "user", content: "verify the phase" }],
      systemPrompt: undefined,
      tools: [],
    } as unknown as Parameters<typeof streamViaDriver>[2];

    const previous = process.env.PI_RELAY_HEARTBEAT_MS;
    process.env.PI_RELAY_HEARTBEAT_MS = "40";
    try {
      const stream = streamViaDriver(
        fakeDriver,
        model,
        context,
      ) as unknown as AsyncIterable<StreamEvent>;
      const types: string[] = [];
      let finalText = "";
      for await (const event of stream) {
        types.push(event.type);
        if (event.type === "done") finalText = event.message?.content?.[0]?.text ?? "";
      }

      // Opens with a single `start`, ends with a single terminal `done`.
      expect(types[0]).toBe("start");
      expect(types[types.length - 1]).toBe("done");
      expect(types.filter((t) => t === "start")).toHaveLength(1);
      expect(types.filter((t) => t === "done")).toHaveLength(1);
      // At least one heartbeat beat arrived, and every beat precedes `done`.
      const beats = types.filter((t) => t === "text_delta");
      expect(beats.length).toBeGreaterThanOrEqual(1);
      expect(types.lastIndexOf("text_delta")).toBeLessThan(types.indexOf("done"));
      // The verdict rides only on `done` — beats do not corrupt the final text.
      expect(finalText).toBe("HEARTBEAT_OK");
    } finally {
      if (previous === undefined) delete process.env.PI_RELAY_HEARTBEAT_MS;
      else process.env.PI_RELAY_HEARTBEAT_MS = previous;
    }
  });

  it("emits no heartbeat beats when disabled with PI_RELAY_HEARTBEAT_MS=0", async () => {
    const context = {
      messages: [{ role: "user", content: "verify the phase" }],
      systemPrompt: undefined,
      tools: [],
    } as unknown as Parameters<typeof streamViaDriver>[2];

    const previous = process.env.PI_RELAY_HEARTBEAT_MS;
    process.env.PI_RELAY_HEARTBEAT_MS = "0";
    try {
      const stream = streamViaDriver(
        fakeDriver,
        model,
        context,
      ) as unknown as AsyncIterable<StreamEvent>;
      const types: string[] = [];
      for await (const event of stream) types.push(event.type);
      // Opt-out preserves the pre-fix shape: just `start` then `done`, no beats.
      expect(types).toEqual(["start", "done"]);
    } finally {
      if (previous === undefined) delete process.env.PI_RELAY_HEARTBEAT_MS;
      else process.env.PI_RELAY_HEARTBEAT_MS = previous;
    }
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

describe("claudeDriver — read-only by declaration, NO OS sandbox (D12)", () => {
  // D12 (revised): relay expresses a read-only posture by DECLARATION — it maps
  // only the role's declared read-only tools to `--allowedTools` and withholds
  // Edit/Write. It does NOT OS-sandbox the backend: a filesystem sandbox broke the
  // verifier's own mandated `npm run check` (vitest writes scratch under `cwd`) and
  // buys no verdict integrity. Tree-hygiene is enforced by detection (orchestrator
  // diffs the tree after verify), not by prevention. The driver therefore emits NO
  // `--settings` sandbox and NO `--disallowedTools`, even for a read-only role.
  it("emits no sandbox `--settings` and no `--disallowedTools` for a read-only role", () => {
    const args = claudeDriver.buildArgs({
      task: "t",
      model: "opus",
      tools: ["read", "bash", "grep", "find"],
    });
    expect(args).not.toContain("--settings");
    expect(args).not.toContain("--disallowedTools");
    // Read-only is by declaration: only the mapped read-only tools are allowed.
    const idx = args.indexOf("--allowedTools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("Read Bash Grep Glob");
    // D2 still holds: never a permission-skip flag.
    expect(args).not.toContain("--dangerously-skip-permissions");
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
