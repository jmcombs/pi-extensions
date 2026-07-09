/**
 * Tests for @jmcombs/pi-better-toolsy.
 *
 * Smoke tests verify the extension registers the correct built-in tool
 * overrides.  Integration tests exercise the core implementations with real
 * temp files.
 */

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the makeGhBodySafe fixtures embed literal shell syntax (${VAR}, $(cmd)) on purpose.

import { execFile } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import factory, { editTool, makeGhBodySafe, readTool, safeResolve } from "./index.js";

const execFileAsync = promisify(execFile);

interface RegistrationLog {
  tools: string[];
  commands: string[];
  shortcuts: string[];
  flags: string[];
  events: string[];
}

function createApiStub(): { api: ExtensionAPI; log: RegistrationLog } {
  const log: RegistrationLog = {
    tools: [],
    commands: [],
    shortcuts: [],
    flags: [],
    events: [],
  };

  const notImplemented =
    (method: string): (() => never) =>
    (): never => {
      throw new Error(`ExtensionAPI.${method} not implemented in test stub`);
    };

  const api = {
    on: ((_event: string) => {
      log.events.push(_event);
    }) as unknown as ExtensionAPI["on"],
    registerTool: ((_tool: { name: string }) => {
      log.tools.push(_tool.name);
    }) as unknown as ExtensionAPI["registerTool"],
    registerCommand: ((_name: string) => {
      log.commands.push(_name);
    }) as unknown as ExtensionAPI["registerCommand"],
    registerShortcut: ((_shortcut: string) => {
      log.shortcuts.push(_shortcut);
    }) as unknown as ExtensionAPI["registerShortcut"],
    registerFlag: ((_name: string) => {
      log.flags.push(_name);
    }) as unknown as ExtensionAPI["registerFlag"],
    getFlag: notImplemented("getFlag"),
    registerMessageRenderer: notImplemented("registerMessageRenderer"),
    sendMessage: notImplemented("sendMessage"),
    sendUserMessage: notImplemented("sendUserMessage"),
    appendEntry: notImplemented("appendEntry"),
    setSessionName: notImplemented("setSessionName"),
    getSessionName: notImplemented("getSessionName"),
    setLabel: notImplemented("setLabel"),
    exec: notImplemented("exec"),
    getActiveTools: notImplemented("getActiveTools"),
    getAllTools: notImplemented("getAllTools"),
    setActiveTools: notImplemented("setActiveTools"),
    getCommands: notImplemented("getCommands"),
    setModel: notImplemented("setModel"),
  } as unknown as ExtensionAPI;

  return { api, log };
}

describe("@jmcombs/pi-better-toolsy", () => {
  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("overrides all 6 built-in Pi tools", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.tools).toContain("ls");
    expect(log.tools).toContain("read");
    expect(log.tools).toContain("grep");
    expect(log.tools).toContain("find");
    expect(log.tools).toContain("edit");
    expect(log.tools).toContain("write");
    expect(log.tools).toHaveLength(6);
  });

  it("registers no flags, commands, or shortcuts", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.flags).toHaveLength(0);
    expect(log.commands).toHaveLength(0);
    expect(log.shortcuts).toHaveLength(0);
  });

  it("registers a tool_call listener for gh-body sanitization", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.events).toContain("tool_call");
  });
});

describe("safeResolve", () => {
  it("blocks path traversal (../../..)", () => {
    expect(() => safeResolve("../../../etc/passwd")).toThrow("Path traversal blocked");
  });

  it("blocks sibling directory bypass (shared name prefix)", () => {
    expect(() => safeResolve("../project-other/evil", "/home/user/project")).toThrow(
      "Path traversal blocked",
    );
  });

  it("allows valid paths within root", () => {
    expect(() => safeResolve("packages/foo", "/home/user/project")).not.toThrow();
  });
});

describe("readTool — line numbering at offset", () => {
  it("prefixes lines with their true file line number when offset is given", async () => {
    const filePath = join(
      process.cwd(),
      "packages",
      "better-toolsy",
      `test-read-${String(Date.now())}.txt`,
    );
    const lines = Array.from({ length: 20 }, (_, i) => `content ${String(i + 1)}`);
    await fsPromises.writeFile(filePath, lines.join("\n"), "utf-8");

    try {
      const result = await readTool("id", { path: filePath, offset: 6, limit: 3 });
      const text = result.content[0]?.text ?? "";
      expect(text.startsWith("6|")).toBe(true);
      expect(text).toContain("7|");
      expect(text).toContain("8|");
    } finally {
      await fsPromises.unlink(filePath);
    }
  });
});

describe("editTool", () => {
  it("inserts $ literally without treating it as a replacement pattern", async () => {
    const filePath = join(
      process.cwd(),
      "packages",
      "better-toolsy",
      `test-edit-${String(Date.now())}.txt`,
    );
    const original = "function foo() { return x; }";
    const oldText = "return x;";
    const newText = "return $`;";
    await fsPromises.writeFile(filePath, original, "utf-8");

    try {
      await editTool("id", { path: filePath, edits: [{ oldText, newText }] });
      const written = await fsPromises.readFile(filePath, "utf-8");
      expect(written).toBe(`function foo() { ${newText} }`);
    } finally {
      await fsPromises.unlink(filePath);
    }
  });

  it("applies multiple edits in sequence within one call", async () => {
    const filePath = join(
      process.cwd(),
      "packages",
      "better-toolsy",
      `test-multi-${String(Date.now())}.txt`,
    );
    await fsPromises.writeFile(filePath, "alpha beta gamma", "utf-8");

    try {
      await editTool("id", {
        path: filePath,
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "gamma", newText: "GAMMA" },
        ],
      });
      const written = await fsPromises.readFile(filePath, "utf-8");
      expect(written).toBe("ALPHA beta GAMMA");
    } finally {
      await fsPromises.unlink(filePath);
    }
  });
});

describe("makeGhBodySafe", () => {
  describe("rewrites shell-unsafe values", () => {
    it("single-quotes a --body containing backticks", () => {
      const { command, changed } = makeGhBodySafe(
        'gh pr create --title "T" --body "## Phase 2 uses `ci.yml`"',
      );
      expect(changed).toBe(true);
      expect(command).toBe("gh pr create --title \"T\" --body '## Phase 2 uses `ci.yml`'");
    });

    it("single-quotes a --body containing $(…)", () => {
      const { command, changed } = makeGhBodySafe('gh pr create --body "built by $(whoami)"');
      expect(changed).toBe(true);
      expect(command).toBe("gh pr create --body 'built by $(whoami)'");
    });

    it("single-quotes a --body containing ${VAR}", () => {
      const { command, changed } = makeGhBodySafe('gh issue create --body "home is ${HOME}"');
      expect(changed).toBe(true);
      expect(command).toBe("gh issue create --body 'home is ${HOME}'");
    });

    it("single-quotes a --body containing a bare $VAR", () => {
      const { command, changed } = makeGhBodySafe('gh pr edit 1 --body "path is $PATH now"');
      expect(changed).toBe(true);
      expect(command).toBe("gh pr edit 1 --body 'path is $PATH now'");
    });

    it("rewrites --title (same exposure as --body)", () => {
      const { command, changed } = makeGhBodySafe(
        'gh pr create --title "release `v2`" --body "ok"',
      );
      expect(changed).toBe(true);
      // --body "ok" has no shell-active chars and is left untouched.
      expect(command).toBe("gh pr create --title 'release `v2`' --body \"ok\"");
    });

    it("rewrites gh release --notes (not --body)", () => {
      const { command, changed } = makeGhBodySafe('gh release create v1 --notes "see `CHANGELOG`"');
      expect(changed).toBe(true);
      expect(command).toBe("gh release create v1 --notes 'see `CHANGELOG`'");
    });

    it('handles the attached --body="…" form', () => {
      const { command, changed } = makeGhBodySafe('gh pr create --body="uses `x`"');
      expect(changed).toBe(true);
      expect(command).toBe("gh pr create --body='uses `x`'");
    });

    it("escapes embedded single quotes via '\\''", () => {
      const { command, changed } = makeGhBodySafe(`gh pr create --body "it's $(date)"`);
      expect(changed).toBe(true);
      expect(command).toBe(`gh pr create --body 'it'\\''s $(date)'`);
    });

    it("rewrites only the unsafe flag, leaving the rest byte-identical", () => {
      const input = 'gh pr create --draft --title "T" --body "has `tick`" --label bug';
      const { command, changed } = makeGhBodySafe(input);
      expect(changed).toBe(true);
      expect(command).toBe("gh pr create --draft --title \"T\" --body 'has `tick`' --label bug");
    });
  });

  describe("leaves safe or unrelated commands untouched", () => {
    const unchanged = [
      // Plain body, no shell-active characters.
      'gh pr create --body "just plain prose"',
      // Already single-quoted — nothing to do.
      "gh pr create --body 'already `safe`'",
      // Body sourced from a file is inherently expansion-safe.
      "gh pr create --body-file body.md",
      // Backticks already escaped inside the double quotes → bash won't expand.
      'gh pr create --body "escaped \\`tick\\`"',
      // Not a gh command: generic -n/-b/-t must never be touched.
      'grep -rn "foo$BAR" .',
      "sort -n data.txt",
      'git commit -m "fix: uses `x`"',
      // gh, but a subcommand without a body flag involved.
      "gh pr view 1 --json body",
    ];

    for (const input of unchanged) {
      it(`no-op: ${input}`, () => {
        const { command, changed } = makeGhBodySafe(input);
        expect(changed).toBe(false);
        expect(command).toBe(input);
      });
    }

    it("bails on nested quotes inside $(…) rather than corrupt the command", () => {
      const input = 'gh pr create --body "text $(echo "hi") end"';
      const { command, changed } = makeGhBodySafe(input);
      expect(changed).toBe(false);
      expect(command).toBe(input);
    });
  });

  describe("round-trips through a real shell verbatim", () => {
    // Prove that after rewriting, bash reproduces the intended body exactly —
    // no command substitution. We run the rewritten value token through
    // `printf %s`, which is what gh does with the argument minus the network.
    const bodies = [
      "## Phase 2 edits `.github/workflows/ci.yml`",
      "built by $(whoami) at ${PWD}",
      "mix `a` and $(b) and $PATH and ${X}",
    ];

    for (const body of bodies) {
      it(`preserves: ${body}`, async () => {
        const { command, changed } = makeGhBodySafe(`gh pr create --body "${body}"`);
        expect(changed).toBe(true);
        const valueToken = command.slice(command.indexOf("--body ") + "--body ".length);
        const { stdout } = await execFileAsync("bash", ["-c", `printf %s ${valueToken}`]);
        expect(stdout).toBe(body);
      });
    }

    it("the original double-quoted form would have been garbled (control)", async () => {
      const body = "uses `echo GARBLE`";
      const { stdout } = await execFileAsync("bash", ["-c", `printf %s "${body}"`]);
      // Command substitution ran — proving the bug the rewrite prevents.
      expect(stdout).not.toBe(body);
      expect(stdout).toContain("GARBLE");
    });
  });

  describe("reports which flags were normalized", () => {
    it("names --body and --title when both are rewritten", () => {
      const { flags } = makeGhBodySafe('gh pr create --title "T `x`" --body "b `y`"');
      expect(flags).toEqual(["--body", "--title"]);
    });

    it("canonicalizes short flags (-n → --notes)", () => {
      const { flags } = makeGhBodySafe('gh release create v1 -n "see `CHANGELOG`"');
      expect(flags).toEqual(["--notes"]);
    });

    it("returns no flags for a pass-through command", () => {
      const { changed, flags } = makeGhBodySafe("gh pr view 1");
      expect(changed).toBe(false);
      expect(flags).toEqual([]);
    });
  });
});

describe("gh-body tool_call hook", () => {
  function loadHook(): (event: unknown, ctx: unknown) => unknown {
    let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
    const api = {
      registerTool: () => {},
      on: (event: string, h: (event: unknown, ctx: unknown) => unknown) => {
        if (event === "tool_call") handler = h;
      },
    } as unknown as ExtensionAPI;
    factory(api);
    if (!handler) throw new Error("tool_call handler not registered");
    return handler;
  }

  function uiCtx(): { ctx: unknown; notes: { message: string; type?: string }[] } {
    const notes: { message: string; type?: string }[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify: (message: string, type?: string) => {
          notes.push({ message, type });
        },
      },
    };
    return { ctx, notes };
  }

  it("mutates the command and emits a 🔧 bt notification naming the flags", () => {
    const handler = loadHook();
    const { ctx, notes } = uiCtx();
    const event = {
      toolName: "bash",
      input: { command: 'gh pr create --title "T `x`" --body "uses `y`"' },
    };
    handler(event, ctx);

    expect(event.input.command).toBe("gh pr create --title 'T `x`' --body 'uses `y`'");
    expect(notes).toHaveLength(1);
    const message = notes[0]?.message ?? "";
    expect(message).toContain("🔧 bt"); // same signature as every other tool
    expect(message).toContain("--body");
    expect(message).toContain("--title");
    expect(notes[0]?.type).toBe("info");
  });

  it("does not notify on a pass-through command", () => {
    const handler = loadHook();
    const { ctx, notes } = uiCtx();
    const event = { toolName: "bash", input: { command: "gh pr view 1" } };
    handler(event, ctx);

    expect(event.input.command).toBe("gh pr view 1");
    expect(notes).toHaveLength(0);
  });

  it("ignores non-bash tool calls", () => {
    const handler = loadHook();
    const { ctx, notes } = uiCtx();
    const event = { toolName: "read", input: { path: "x" } };
    handler(event, ctx);

    expect(notes).toHaveLength(0);
  });

  it("still rewrites without a UI (no throw, no toast)", () => {
    const handler = loadHook();
    const event = { toolName: "bash", input: { command: 'gh pr create --body "uses `z`"' } };
    // ctx.hasUI is false → skip the toast, but the command must still be fixed.
    handler(event, { hasUI: false });
    expect(event.input.command).toBe("gh pr create --body 'uses `z`'");
  });
});
