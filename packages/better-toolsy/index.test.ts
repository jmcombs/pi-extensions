/**
 * Tests for @jmcombs/pi-better-toolsy.
 *
 * Smoke tests verify the extension registers the correct built-in tool
 * overrides.  Integration tests exercise the core implementations with real
 * temp files.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { promises as fsPromises } from "node:fs";
import { join } from "node:path";
import factory, { safeResolve, readTool, editTool } from "./index.js";

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
