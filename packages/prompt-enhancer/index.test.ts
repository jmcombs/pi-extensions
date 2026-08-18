/**
 * Smoke tests for @jmcombs/pi-prompt-enhancer.
 *
 * Verifies the registration surface (commands + shortcut) plus the pure
 * helpers (file mention extraction, message assembly). The end-to-end
 * enhancer flow involves a real LLM call and editor mutation; per the
 * project's testing policy we do **not** mock the LLM. End-to-end is
 * exercised manually with `pi -e ./packages/prompt-enhancer`.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import factory, {
  buildEnhancerUserMessage,
  computePickerMaxVisible,
  createEnhancerModelSelector,
  type EnhancerContext,
  filterPickerItems,
  SYSTEM_PROMPT,
} from "./index.js";

interface RegistrationLog {
  commands: string[];
  shortcuts: string[];
  events: string[];
  tools: string[];
}

function createApiStub(): { api: ExtensionAPI; log: RegistrationLog } {
  const log: RegistrationLog = { commands: [], shortcuts: [], events: [], tools: [] };
  const notImplemented = (method: string) => () => {
    throw new Error(`ExtensionAPI.${method} not implemented in test stub`);
  };

  const api = {
    on: ((event: string) => {
      log.events.push(event);
    }) as unknown as ExtensionAPI["on"],
    registerTool: ((tool: { name: string }) => {
      log.tools.push(tool.name);
    }) as unknown as ExtensionAPI["registerTool"],
    registerCommand: ((name: string) => {
      log.commands.push(name);
    }) as unknown as ExtensionAPI["registerCommand"],
    registerShortcut: ((shortcut: string) => {
      log.shortcuts.push(shortcut);
    }) as unknown as ExtensionAPI["registerShortcut"],
    registerFlag: notImplemented("registerFlag"),
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

describe("@jmcombs/pi-prompt-enhancer", () => {
  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers exactly the documented commands and shortcuts", () => {
    const { api, log } = createApiStub();
    factory(api);

    expect(log.commands.sort()).toEqual([
      "prompt-enhance",
      "prompt-enhance-model",
      "prompt-enhance-revert",
    ]);
    expect(log.shortcuts.sort()).toEqual(["ctrl+shift+e", "ctrl+shift+z"]);
    expect(log.tools).toEqual([]);
  });

  it("subscribes to all events needed for footer + widget lifecycle", () => {
    const { api, log } = createApiStub();
    factory(api);

    // session_start paints the persistent widget and clears a stale revert
    // chip. session_shutdown cancels the pending auto-clear timer.
    // model_select refreshes the widget's Model line when the user changes
    // pi models. input clears the revert chip when the user submits a
    // non-command prompt.
    expect(log.events).toContain("session_start");
    expect(log.events).toContain("session_shutdown");
    expect(log.events).toContain("model_select");
    expect(log.events).toContain("input");
  });
});

describe("buildEnhancerUserMessage", () => {
  const baseContext: EnhancerContext = {
    cwd: "/tmp/example",
    mentionedFiles: [],
  };

  it("always includes the working directory and the original prompt", () => {
    const out = buildEnhancerUserMessage("fix the bug", baseContext);
    expect(out).toContain("## Working directory\n/tmp/example");
    expect(out).toContain("## Original prompt\nfix the bug");
  });

  it("leads with a do-not-answer task so the model rewrites instead of solving", () => {
    const out = buildEnhancerUserMessage("fix the bug", baseContext);
    expect(out).toMatch(/^## Task\n/);
    expect(out).toContain("Do not answer, solve, implement, or explain");
  });

  it("omits the project tree section when no tree was gathered", () => {
    const out = buildEnhancerUserMessage("hi", baseContext);
    expect(out).not.toMatch(/## Project tree/);
  });

  it("includes the project tree when present", () => {
    const out = buildEnhancerUserMessage("hi", { ...baseContext, tree: "src/\n  index.ts" });
    expect(out).toMatch(/## Project tree.*\n.*src\//s);
  });

  it("omits git section when no git context was gathered", () => {
    const out = buildEnhancerUserMessage("hi", baseContext);
    expect(out).not.toMatch(/## Git/);
  });

  it("includes git context when present", () => {
    const out = buildEnhancerUserMessage("hi", {
      ...baseContext,
      git: "branch: main\nstatus: clean",
    });
    expect(out).toContain("## Git\nbranch: main\nstatus: clean");
  });

  it("formats mentioned files as fenced code blocks under their relative paths", () => {
    const out = buildEnhancerUserMessage("see README", {
      ...baseContext,
      mentionedFiles: [
        { path: "README.md", content: "# hello" },
        { path: "src/index.ts", content: "export {};" },
      ],
    });
    expect(out).toContain("## Files referenced in the prompt");
    expect(out).toContain("### README.md\n```\n# hello\n```");
    expect(out).toContain("### src/index.ts\n```\nexport {};\n```");
  });
});

describe("computePickerMaxVisible", () => {
  it("sizes the viewport to 70% of terminal rows minus chrome", () => {
    // 24 rows → floor(24 * 0.7) = 16, minus 6 chrome = 10.
    expect(computePickerMaxVisible(24, 50)).toBe(10);
  });

  it("clamps to the item count when the list is shorter than the budget", () => {
    expect(computePickerMaxVisible(24, 4)).toBe(4);
  });

  it("clamps to a minimum of 3 visible rows on a short terminal", () => {
    expect(computePickerMaxVisible(10, 50)).toBe(3);
  });

  it("falls back to 24 rows when the terminal size is missing or invalid", () => {
    expect(computePickerMaxVisible(Number.NaN, 50)).toBe(10);
    expect(computePickerMaxVisible(0, 50)).toBe(10);
    expect(computePickerMaxVisible(-4, 50)).toBe(10);
  });
});

describe("createEnhancerModelSelector", () => {
  const identityTheme: Pick<Theme, "fg" | "bold"> = {
    fg: (_color, text) => text,
    bold: (text) => text,
  };

  it("instantiates and renders without throwing", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      value: `provider/model-${String(i)}`,
      label: i === 0 ? `provider/model-${String(i)} (current)` : `provider/model-${String(i)}`,
    }));
    const picker = createEnhancerModelSelector(
      { terminal: { rows: 24 }, requestRender: () => {} },
      identityTheme,
      items,
      () => {},
    );
    const lines = picker.render(80);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes("Pick Prompt Enhancer model"))).toBe(true);
    expect(lines.some((line) => line.includes("(current)"))).toBe(true);
    expect(lines.some((line) => /\(\d+\/\d+\)/.test(line))).toBe(true);
    expect(lines.some((line) => line.includes("> "))).toBe(true);
    expect(lines.some((line) => line.includes("type to filter"))).toBe(true);
  });

  it("narrows the list as you type, like /model", () => {
    const items = [
      { value: "anthropic/claude-sonnet-4", label: "anthropic/claude-sonnet-4 (current)" },
      { value: "openai/gpt-4o", label: "openai/gpt-4o" },
      { value: "google/gemini-2.5-pro", label: "google/gemini-2.5-pro" },
    ];
    const picker = createEnhancerModelSelector(
      { terminal: { rows: 24 }, requestRender: () => {} },
      identityTheme,
      items,
      () => {},
    );
    picker.handleInput("sonnet");
    const lines = picker.render(80).join("\n");
    expect(lines).toContain("claude-sonnet-4");
    expect(lines).not.toContain("gpt-4o");
    expect(lines).not.toContain("gemini-2.5-pro");
  });

  it("shows No matching models when the query matches nothing", () => {
    const picker = createEnhancerModelSelector(
      { terminal: { rows: 24 }, requestRender: () => {} },
      identityTheme,
      [{ value: "openai/gpt-4o", label: "openai/gpt-4o" }],
      () => {},
    );
    picker.handleInput("zzzz");
    expect(picker.render(80).some((line) => line.includes("No matching models"))).toBe(true);
  });
});

describe("SYSTEM_PROMPT", () => {
  it("forbids answering or implementing the user's request", () => {
    expect(SYSTEM_PROMPT).toMatch(/do not answer/i);
    expect(SYSTEM_PROMPT).toMatch(/do not solve, implement/i);
    expect(SYSTEM_PROMPT).toContain("rewritten *request*");
  });
});

describe("filterPickerItems", () => {
  const items = [
    { value: "anthropic/claude-sonnet-4", label: "anthropic/claude-sonnet-4 (current)" },
    { value: "openai/gpt-4o", label: "openai/gpt-4o" },
  ];

  it("returns all items when the query is empty or whitespace", () => {
    expect(filterPickerItems(items, "")).toEqual(items);
    expect(filterPickerItems(items, "   ")).toEqual(items);
  });

  it("fuzzy-matches provider/id tokens", () => {
    const matched = filterPickerItems(items, "sonnet");
    expect(matched.map((item) => item.value)).toEqual(["anthropic/claude-sonnet-4"]);
  });

  it("returns no items when nothing fuzzy-matches", () => {
    expect(filterPickerItems(items, "zzzz")).toEqual([]);
  });
});

describe("buildEnhancerUserMessage section order", () => {
  it("preserves section ordering: cwd → tree → git → files → original", () => {
    const out = buildEnhancerUserMessage("do the thing", {
      cwd: "/tmp/example",
      tree: "x/",
      git: "branch: main",
      mentionedFiles: [{ path: "f.ts", content: "x" }],
    });
    const order = [
      "## Task",
      "## Working directory",
      "## Project tree",
      "## Git",
      "## Files referenced in the prompt",
      "## Original prompt",
    ].map((label) => out.indexOf(label));
    // Each label must appear, and the array must already be in ascending order.
    expect(order.every((idx) => idx >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
