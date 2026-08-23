/**
 * Smoke tests for @jmcombs/pi-prompt-enhancer.
 *
 * Verifies the registration surface (commands + shortcut) plus the pure
 * helpers (file mention extraction, message assembly). The end-to-end
 * enhancer flow involves a real LLM call and editor mutation; per the
 * project's testing policy we do **not** mock the LLM. End-to-end is
 * exercised manually with `pi -e ./packages/prompt-enhancer`.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import {
  type ExtensionAPI,
  type ExtensionContext,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import factory, {
  buildEnhancerUserMessage,
  buildProjectConventions,
  buildRecentTurns,
  completeWithRetry,
  computePickerMaxVisible,
  createEnhancerModelSelector,
  ENHANCER_RETRY_POLICY,
  type EnhancerContext,
  filterPickerItems,
  formatEnhancementFailure,
  formatRetryStatus,
  gatherEnhancerContext,
  normalizeFailureReason,
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
      "prompt_enhance",
      "prompt_enhance_auto",
      "prompt_enhance_model",
      "prompt_enhance_revert",
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

  it("omits the conversation section when there is no history", () => {
    const out = buildEnhancerUserMessage("hi", baseContext);
    expect(out).not.toMatch(/## Recent conversation/);
  });

  it("labels conversation history as background that must not be continued", () => {
    const out = buildEnhancerUserMessage("what about the skill", {
      ...baseContext,
      history: "User: add a dependabot skill\nAgent: added it",
    });
    expect(out).toContain(
      "## Recent conversation (background only — do not answer or continue it)\nUser: add a dependabot skill",
    );
    // The prompt to rewrite still comes last, after the background.
    expect(out.indexOf("## Recent conversation")).toBeLessThan(out.indexOf("## Original prompt"));
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

  it("states that nothing can be retrieved and announcements are not the output", () => {
    expect(SYSTEM_PROMPT).toContain("No tools are attached");
    expect(SYSTEM_PROMPT).toMatch(/never announce what you would inspect/i);
  });

  it("marks the context as partial so a missing path is not invented", () => {
    expect(SYSTEM_PROMPT).toContain("may be truncated");
    expect(SYSTEM_PROMPT).toMatch(/no path that is not in the context/i);
  });

  it("frames project conventions as constraints, not as material to summarise", () => {
    expect(SYSTEM_PROMPT).toMatch(/project conventions constrain the rewrite/i);
    expect(SYSTEM_PROMPT).toMatch(/do not restate them/i);
  });

  it("rewrites non-codebase prompts instead of refusing or answering them", () => {
    expect(SYSTEM_PROMPT).toContain("not about the codebase");
    expect(SYSTEM_PROMPT).toContain("Never refuse, never explain yourself, never address the user");
  });

  it("keeps conversation background as background", () => {
    expect(SYSTEM_PROMPT).toMatch(/never answer or continue it/i);
  });

  /**
   * A regression bound, not an aesthetic one. This prompt is paid on every
   * enhance; the fix for a failing model is shorter and clearer wording plus
   * better context, never more instructions. 1,218 is what shipped before, and
   * the one new rule here cost 66 characters.
   */
  it("stays inside its character budget", () => {
    expect(SYSTEM_PROMPT.length).toBeLessThanOrEqual(1290);
  });
});

describe("buildRecentTurns", () => {
  const turn = (role: string, text: string) => ({ role, content: [{ type: "text", text }] });

  it("returns undefined with no history at all", () => {
    expect(buildRecentTurns([])).toBeUndefined();
  });

  it("returns undefined when nothing in the branch is a user or assistant turn", () => {
    expect(
      buildRecentTurns([turn("system", "you are a bot"), { role: "toolResult" }]),
    ).toBeUndefined();
  });

  it("renders labelled turns oldest first", () => {
    const out = buildRecentTurns([turn("user", "add a skill"), turn("assistant", "added it")]);
    expect(out).toBe("User: add a skill\nAgent: added it");
  });

  it("accepts the wrapped { message } entry shape", () => {
    expect(buildRecentTurns([{ message: turn("user", "hello") }])).toBe("User: hello");
  });

  it("reads plain string content as well as text blocks", () => {
    expect(buildRecentTurns([{ role: "assistant", content: "done" }])).toBe("Agent: done");
  });

  it("keeps only the most recent turns", () => {
    const out = buildRecentTurns([
      turn("user", "one"),
      turn("assistant", "two"),
      turn("user", "three"),
      turn("assistant", "four"),
      turn("user", "five"),
    ]);
    expect(out).toBe("Agent: two\nUser: three\nAgent: four\nUser: five");
  });

  it("collapses whitespace so formatting does not eat the budget", () => {
    expect(buildRecentTurns([turn("user", "a\n\n  b\tc  ")])).toBe("User: a b c");
  });

  it("clips a long turn and marks it", () => {
    const out = buildRecentTurns([turn("user", "x".repeat(1000))]);
    expect(out?.endsWith("…")).toBe(true);
    expect((out ?? "").length).toBeLessThan(360);
  });

  it("stops at the total budget instead of returning a whole long session", () => {
    const long = "y".repeat(320);
    const out = buildRecentTurns([
      turn("user", long),
      turn("assistant", long),
      turn("user", long),
      turn("assistant", long),
    ]);
    expect((out ?? "").length).toBeLessThanOrEqual(1200);
    // The newest turn survives; the oldest is what the budget drops.
    expect(out?.split("\n").at(-1)?.startsWith("Agent:")).toBe(true);
  });

  it("skips empty turns rather than emitting a bare label", () => {
    expect(buildRecentTurns([turn("user", "   "), turn("assistant", "real")])).toBe("Agent: real");
  });

  it("tolerates junk entries", () => {
    expect(buildRecentTurns([null, undefined, 7, "nope", turn("user", "ok")])).toBe("User: ok");
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

describe("completeWithRetry", () => {
  // The real policy waits 2000/4000/8000 ms; tests use the same shape with a
  // 1 ms base so the retry *count* and ordering are exercised without the wait.
  const fastPolicy = { ...ENHANCER_RETRY_POLICY, baseDelayMs: 1 };

  /** Minimal but complete `AssistantMessage` scaffolding for the fixtures below. */
  const assistantBase: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "llama.cpp",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    timestamp: 0,
  };

  const errorMessage = (text: string): AssistantMessage => ({
    ...assistantBase,
    stopReason: "error",
    errorMessage: text,
  });

  it("uses pi's own retry budget: enabled, 3 retries, 2000 ms base", () => {
    expect(ENHANCER_RETRY_POLICY).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2000 });
  });

  it("retries a transient transport error 3 times, then returns the last error", async () => {
    let calls = 0;
    const result = await completeWithRetry(
      async () => {
        calls++;
        return errorMessage("Connection error.");
      },
      undefined,
      fastPolicy,
    );
    expect(calls).toBe(4);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Connection error.");
  });

  it("does not retry an error pi's classifier calls non-transient", async () => {
    let calls = 0;
    const result = await completeWithRetry(
      async () => {
        calls++;
        return errorMessage("401 Unauthorized: invalid api key");
      },
      undefined,
      fastPolicy,
    );
    expect(calls).toBe(1);
    expect(result.stopReason).toBe("error");
  });

  it("never retries an aborted response", async () => {
    let calls = 0;
    const result = await completeWithRetry(
      async () => {
        calls++;
        return { ...assistantBase, stopReason: "aborted", errorMessage: undefined };
      },
      undefined,
      fastPolicy,
    );
    expect(calls).toBe(1);
    expect(result.stopReason).toBe("aborted");
  });

  it("returns without retrying when the first attempt succeeds", async () => {
    let calls = 0;
    const result = await completeWithRetry(
      async () => {
        calls++;
        return {
          ...assistantBase,
          content: [{ type: "text", text: "ok" }],
          stopReason: "stop",
        };
      },
      undefined,
      fastPolicy,
    );
    expect(calls).toBe(1);
    expect(result.stopReason).toBe("stop");
  });

  it("applies the enhancer policy by default, with no policy argument", async () => {
    // Pins the *default binding* production relies on, not the exported
    // constant: called with two arguments, a retryable error must go into the
    // (2000 ms) backoff, so an abort 10 ms in comes back "aborted". If the
    // default were dropped or disabled the call would return "error" at once.
    const controller = new AbortController();
    let calls = 0;
    const pending = completeWithRetry(async () => {
      calls++;
      return errorMessage("fetch failed");
    }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await pending;
    expect(calls).toBe(1);
    expect(result.stopReason).toBe("aborted");
  });

  it("forwards retry callbacks, and omitting them is harmless", async () => {
    const onePolicy = { ...fastPolicy, maxRetries: 1 };
    const scheduled: Array<[number, number, number, string]> = [];
    let attemptStarts = 0;
    let finished: { success: boolean; attempt: number } | undefined;

    const result = await completeWithRetry(
      async () => errorMessage("Connection error."),
      undefined,
      onePolicy,
      {
        onRetryScheduled: (attempt, maxAttempts, delayMs, message) => {
          scheduled.push([attempt, maxAttempts, delayMs, message]);
        },
        onRetryAttemptStart: () => {
          attemptStarts++;
        },
        onRetryFinished: (success, attempt) => {
          finished = { success, attempt };
        },
      },
    );

    expect(scheduled).toEqual([[1, 1, 1, "Connection error."]]);
    expect(attemptStarts).toBe(1);
    expect(finished).toEqual({ success: false, attempt: 1 });
    expect(result.stopReason).toBe("error");

    // Same call without callbacks: retries all the same and never throws.
    let calls = 0;
    const bare = await completeWithRetry(
      async () => {
        calls++;
        return errorMessage("Connection error.");
      },
      undefined,
      onePolicy,
    );
    expect(calls).toBe(2);
    expect(bare.stopReason).toBe("error");
  });

  it("aborting during the backoff sleep cancels at once and reports 'aborted'", async () => {
    const controller = new AbortController();
    let calls = 0;
    const started = Date.now();
    // Full 2000 ms base: if the abort were not honoured mid-sleep this would
    // take seconds rather than milliseconds.
    const pending = completeWithRetry(
      async () => {
        calls++;
        return errorMessage("fetch failed");
      },
      controller.signal,
      ENHANCER_RETRY_POLICY,
    );
    // Let the first attempt fail and the backoff sleep begin.
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await pending;
    expect(calls).toBe(1);
    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("normalizeFailureReason", () => {
  it("returns the reason as-is when it is already one clean line", () => {
    expect(normalizeFailureReason("Connection error")).toBe("Connection error");
  });

  it("drops a trailing period so it does not collide with the message punctuation", () => {
    expect(normalizeFailureReason("Connection error.")).toBe("Connection error");
  });

  it("keeps only the first line of a multi-line provider error", () => {
    expect(normalizeFailureReason("Connection error.\n  at fetch (node:internal)\n  at run")).toBe(
      "Connection error",
    );
  });

  it("caps an over-long reason with an ellipsis", () => {
    const long = `${"x".repeat(250)}.`;
    const out = normalizeFailureReason(long);
    expect(out).toBe(`${"x".repeat(100)}…`);
    expect(out).toHaveLength(101);
  });

  it("treats absent, empty, and whitespace-only reasons as no reason at all", () => {
    expect(normalizeFailureReason(undefined)).toBeUndefined();
    expect(normalizeFailureReason("")).toBeUndefined();
    expect(normalizeFailureReason("   \n  ")).toBeUndefined();
    expect(normalizeFailureReason(".")).toBeUndefined();
  });
});

describe("formatEnhancementFailure", () => {
  it("quotes the reason in parentheses and promises the prompt is unchanged", () => {
    expect(formatEnhancementFailure("Connection error")).toBe(
      "prompt enhancement failed (Connection error); your prompt is unchanged",
    );
  });

  it("normalizes the reason it is given", () => {
    expect(formatEnhancementFailure("Connection error.\nstack frame")).toBe(
      "prompt enhancement failed (Connection error); your prompt is unchanged",
    );
    expect(formatEnhancementFailure(`${"y".repeat(120)}`)).toBe(
      `prompt enhancement failed (${"y".repeat(100)}…); your prompt is unchanged`,
    );
  });

  it("drops the parenthetical and its space entirely when there is no reason", () => {
    const expected = "prompt enhancement failed; your prompt is unchanged";
    expect(formatEnhancementFailure(undefined)).toBe(expected);
    expect(formatEnhancementFailure("")).toBe(expected);
    expect(formatEnhancementFailure("   ")).toBe(expected);
  });
});

describe("formatRetryStatus", () => {
  it("names the reason the last attempt gave, so Esc is an informed choice", () => {
    expect(formatRetryStatus(1, 3, 2000, "Connection error.")).toBe(
      "Retrying (1/3) in 2s… · Connection error",
    );
    expect(formatRetryStatus(3, 3, 8000, "503 Service Unavailable")).toBe(
      "Retrying (3/3) in 8s… · 503 Service Unavailable",
    );
  });

  it("falls back to pi's own wording when no reason came through", () => {
    expect(formatRetryStatus(2, 3, 4000)).toBe("Retrying (2/3) in 4s…");
    expect(formatRetryStatus(2, 3, 4000, "")).toBe("Retrying (2/3) in 4s…");
  });
});

// ── Failure handling, end to end through the real runEnhancer ───────────
//
// No LLM is mocked. The stub host hands the enhancer a model whose `api` no
// provider is registered for, so pi-ai's own `stream()` throws before it opens
// a socket: a genuine failure, produced by the real code path, with no network
// and no retry budget to wait out. Cancellation is equally real — the stub
// presses Escape on the actual `BorderedLoader` the extension built.

const ESCAPE = "\x1b";

/**
 * A real, empty working directory for these runs.
 *
 * It must exist: `gatherEnhancerContext` spawns git in it, and aborting a
 * child that failed to spawn because its `cwd` was missing takes the whole
 * process group down with it under Node. Empty is enough — the tree walk finds
 * nothing, git reports no repository, and the run reaches the model call at
 * once.
 */
let hostCwd = "";

// `BorderedLoader` renders pi's own cancel key hint, which reads the global
// theme. Pinned to the built-in "dark" so the tests never depend on the
// developer's configured theme.
beforeAll(async () => {
  initTheme("dark", false);
  hostCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-prompt-enhancer-tests-"));
});

afterAll(async () => {
  if (hostCwd) await fs.rm(hostCwd, { recursive: true, force: true });
});

interface HostLog {
  notifications: { message: string; level: string }[];
  widgets: string[][];
  editorTexts: string[];
}

/** Registered handlers, so tests can drive commands and events like pi does. */
function createHarness(): {
  commands: Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>;
  events: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
} {
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const api = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      events.set(name, handler);
    },
    registerCommand: (
      name: string,
      def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ) => {
      commands.set(name, def.handler);
    },
    registerShortcut: () => {},
  } as unknown as ExtensionAPI;
  factory(api);
  return { commands, events };
}

function createHost(options: { draft: string; cancel?: boolean }): {
  ctx: ExtensionContext;
  log: HostLog;
  /** What pi does to the editor on Enter, before it fires the input event. */
  clearEditorLikeEnter: () => void;
} {
  const log: HostLog = { notifications: [], widgets: [], editorTexts: [] };
  let editorText = options.draft;

  const tuiStub = { requestRender: () => {}, terminal: { rows: 24, columns: 80 } };
  const themeStub = {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };

  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd: hostCwd,
    model: { provider: "test", id: "unreachable", api: "no-such-api-provider" },
    modelRegistry: {
      getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: "test-key", headers: {} }),
    },
    sessionManager: { getBranch: () => [] },
    ui: {
      getEditorText: () => editorText,
      setEditorText: (text: string) => {
        editorText = text;
        log.editorTexts.push(text);
      },
      setStatus: () => {},
      setWidget: (_key: string, lines: string[]) => {
        log.widgets.push(lines);
      },
      notify: (message: string, level: string) => {
        log.notifications.push({ message, level });
      },
      custom: async <T>(
        build: (
          tui: unknown,
          theme: unknown,
          kb: unknown,
          done: (value: T) => void,
        ) => { handleInput?: (data: string) => void; dispose?: () => void },
      ): Promise<T> => {
        let settle: (value: T) => void = () => {};
        const settled = new Promise<T>((resolve) => {
          settle = resolve;
        });
        const component = build(tuiStub, themeStub, {}, settle);
        // Escape on the real loader: aborts its signal and fires onAbort,
        // exactly as a keypress would.
        if (options.cancel === true) component.handleInput?.(ESCAPE);
        const outcome = await settled;
        component.dispose?.();
        return outcome;
      },
    },
  } as unknown as ExtensionContext;

  return {
    ctx,
    log,
    clearEditorLikeEnter: () => {
      editorText = "";
    },
  };
}

function lastWidgetLine(log: HostLog): string {
  return log.widgets.at(-1)?.[0] ?? "";
}

/** The green `auto` block is a padded Powerline segment. */
function hasAutoChip(line: string): boolean {
  return line.includes(" auto ");
}

describe("enhancement failure", () => {
  const DRAFT = "rework the widget rendering so the segments collapse cleanly";

  type Armed = {
    harness: ReturnType<typeof createHarness>;
    ctx: ExtensionContext;
    log: HostLog;
    clearEditorLikeEnter: () => void;
  };

  async function armed(options: { cancel?: boolean } = {}): Promise<Armed> {
    const harness = createHarness();
    const host = createHost({ draft: DRAFT, cancel: options.cancel });
    // session_start resets the module-scoped session state between tests.
    await harness.events.get("session_start")?.({}, host.ctx);
    await harness.commands.get("prompt_enhance_auto")?.("", host.ctx);
    expect(hasAutoChip(lastWidgetLine(host.log))).toBe(true);
    return { harness, ...host };
  }

  /**
   * Enter, the way pi delivers it: the editor is emptied *before* the input
   * event fires, so the enhancer never sees the draft in `getEditorText()`.
   */
  function submit(armedHost: Armed): Promise<unknown> {
    armedHost.clearEditorLikeEnter();
    return Promise.resolve(
      armedHost.harness.events.get("input")?.(
        { source: "interactive", text: DRAFT, images: [] },
        armedHost.ctx,
      ),
    );
  }

  async function shutdown(
    harness: ReturnType<typeof createHarness>,
    ctx: ExtensionContext,
  ): Promise<void> {
    await harness.events.get("session_shutdown")?.({}, ctx);
  }

  it("switches auto-enhance off and drops the widget's auto block", async () => {
    const host = await armed();

    // The submit was swallowed: the draft went to the enhancer, not the agent.
    expect(await submit(host)).toEqual({ action: "handled" });
    expect(hasAutoChip(lastWidgetLine(host.log))).toBe(false);

    // Auto is genuinely off, not merely unpainted: the same Enter now passes
    // the draft straight through to the agent.
    expect(await submit(host)).toEqual({ action: "continue" });
    expect(host.log.notifications).toHaveLength(1);

    await shutdown(host.harness, host.ctx);
  });

  it("puts the draft back in the editor, which is what the message promises", async () => {
    const host = await armed();
    await submit(host);

    // pi emptied the editor on Enter, so "restore what was there" would have
    // restored nothing. The draft itself is what comes back.
    expect(host.log.editorTexts.at(-1)).toBe(DRAFT);
    expect(host.ctx.ui.getEditorText()).toBe(DRAFT);

    await shutdown(host.harness, host.ctx);
  });

  it("says one thing, with the reason, and promises the prompt is unchanged", async () => {
    const host = await armed();
    await submit(host);

    const log = host.log;
    expect(log.notifications).toHaveLength(1);
    const only = log.notifications[0];
    expect(only?.message).toMatch(/^prompt enhancement failed \(.+\); your prompt is unchanged$/);
    expect(only?.message).toBe(
      formatEnhancementFailure("No API provider registered for api: no-such-api-provider"),
    );

    await shutdown(host.harness, host.ctx);
  });

  it("says exactly the same thing on the manual path", async () => {
    const auto = await armed();
    await submit(auto);
    await shutdown(auto.harness, auto.ctx);

    // Manual: /prompt_enhance on the editor's contents, auto never turned on.
    const harness = createHarness();
    const { ctx, log } = createHost({ draft: DRAFT });
    await harness.events.get("session_start")?.({}, ctx);
    await harness.commands.get("prompt_enhance")?.("", ctx);

    expect(log.notifications).toHaveLength(1);
    expect(log.notifications[0]?.message).toBe(auto.log.notifications[0]?.message);
    expect(hasAutoChip(lastWidgetLine(log))).toBe(false);
    expect(log.editorTexts.at(-1)).toBe(DRAFT);

    await shutdown(harness, ctx);
  });

  it("leaves auto-enhance alone when the user cancels with Esc", async () => {
    const host = await armed({ cancel: true });
    await submit(host);

    // Cancel is a decision, not a failure: no message, and auto is still armed.
    expect(host.log.notifications).toEqual([]);
    expect(hasAutoChip(lastWidgetLine(host.log))).toBe(true);
    // The draft still comes back — cancelling must not cost the user their text.
    expect(host.log.editorTexts.at(-1)).toBe(DRAFT);

    await shutdown(host.harness, host.ctx);
  });
});

// ── File reading guards ────────────────────────────────────────────────

/**
 * The guards on files the *prompt* names, exercised through the shipped entry
 * point. `extractFileMentions` matches any token holding a `/` or a known
 * extension, so "why does logo.png look wrong" is enough to name a binary, and
 * reading one as UTF-8 spends thousands of characters of the model call on
 * mojibake. Real files in a real directory: these are filesystem behaviours and
 * a stubbed `fs` would only test the stub.
 */
describe("mentioned-file guards", () => {
  let cwd = "";

  beforeAll(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-prompt-enhancer-mentions-"));
  });

  afterAll(async () => {
    if (cwd) await fs.rm(cwd, { recursive: true, force: true });
  });

  const gather = (prompt: string) =>
    gatherEnhancerContext(prompt, cwd, new AbortController().signal);

  it("still reads a plain text file the prompt names", async () => {
    await fs.writeFile(path.join(cwd, "notes.md"), "# Notes\nkeep this");
    const context = await gather("update notes.md please");
    expect(context.mentionedFiles.map((f) => f.path)).toContain("notes.md");
    expect(context.mentionedFiles.find((f) => f.path === "notes.md")?.content).toContain(
      "keep this",
    );
  });

  it("refuses a binary file rather than decoding it into the prompt", async () => {
    // `assets/logo.png`, with the separator: `extractFileMentions` matches any
    // token holding a `/`, so the extension list never gets a say. The bytes
    // are a PNG signature, then values that are not valid UTF-8 and decode to
    // U+FFFD, then NULs. Under the old reader all of that reached the model.
    await fs.mkdir(path.join(cwd, "assets"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "assets", "logo.png"),
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(Array.from({ length: 4096 }, (_, i) => 128 + (i % 128))),
        Buffer.alloc(4096),
      ]),
    );
    const context = await gather("why does assets/logo.png look wrong");
    expect(context.mentionedFiles.map((f) => f.path)).not.toContain("assets/logo.png");
    expect(JSON.stringify(context)).not.toContain("\uFFFD");
  });

  it("refuses a file past the size cap", async () => {
    await fs.writeFile(path.join(cwd, "huge.md"), "x".repeat(1_000_001));
    const context = await gather("summarise huge.md");
    expect(context.mentionedFiles.map((f) => f.path)).not.toContain("huge.md");
  });

  it("refuses a path that escapes the working directory", async () => {
    const outside = path.join(path.dirname(cwd), "escaped-secret.md");
    await fs.writeFile(outside, "TOP SECRET");
    try {
      const context = await gather("read ../escaped-secret.md and fix it");
      expect(context.mentionedFiles).toEqual([]);
      expect(JSON.stringify(context)).not.toContain("TOP SECRET");
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it("refuses a symlink that points out of the working directory", async () => {
    const outside = path.join(path.dirname(cwd), "linked-secret.md");
    await fs.writeFile(outside, "TOP SECRET");
    await fs.symlink(outside, path.join(cwd, "innocent.md"));
    try {
      const context = await gather("check innocent.md");
      expect(context.mentionedFiles.map((f) => f.path)).not.toContain("innocent.md");
      expect(JSON.stringify(context)).not.toContain("TOP SECRET");
    } finally {
      await fs.rm(outside, { force: true });
      await fs.rm(path.join(cwd, "innocent.md"), { force: true });
    }
  });
});

// ── Project conventions ────────────────────────────────────────────────

/**
 * The conventions reader against a real filesystem.
 *
 * Every case here is a real file (or a real symlink, or a real 2 MB file) in a
 * real temp directory: the guards are filesystem behaviour, and a stubbed `fs`
 * would only test the stub. Each test builds its own directory so the cases
 * cannot leak into one another.
 */
describe("buildProjectConventions", () => {
  let root = "";

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-prompt-enhancer-conventions-"));
  });

  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  /** A fresh working directory per case. */
  async function dir(name: string): Promise<string> {
    const made = path.join(root, name);
    await fs.mkdir(made, { recursive: true });
    return made;
  }

  it("returns nothing when the project has no instruction files", async () => {
    expect(await buildProjectConventions(await dir("empty"))).toEqual([]);
  });

  it("reads AGENTS.md, CLAUDE.md and CONTRIBUTING.md from the project root", async () => {
    const cwd = await dir("all-three");
    await fs.writeFile(path.join(cwd, "AGENTS.md"), "# Agents\nUse tabs.");
    await fs.writeFile(path.join(cwd, "CLAUDE.md"), "# Claude\nNo emoji.");
    await fs.writeFile(path.join(cwd, "CONTRIBUTING.md"), "# Contributing\nConventional Commits.");

    const out = await buildProjectConventions(cwd);
    expect(out.map((f) => f.path)).toEqual(["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]);
    expect(out[0]?.content).toContain("Use tabs.");
    expect(out[2]?.content).toContain("Conventional Commits.");
  });

  it("skips the files that are absent instead of emitting empty entries", async () => {
    const cwd = await dir("one-of-three");
    await fs.writeFile(path.join(cwd, "CLAUDE.md"), "only this one");
    const out = await buildProjectConventions(cwd);
    expect(out.map((f) => f.path)).toEqual(["CLAUDE.md"]);
  });

  it("never treats a directory as a conventions file", async () => {
    const cwd = await dir("dir-named-agents");
    await fs.mkdir(path.join(cwd, "AGENTS.md"));
    expect(await buildProjectConventions(cwd)).toEqual([]);
  });

  it("caps each file at 80 lines and says that it truncated", async () => {
    const cwd = await dir("long-file");
    const body = Array.from({ length: 500 }, (_, i) => `line ${String(i)}`).join("\n");
    await fs.writeFile(path.join(cwd, "AGENTS.md"), body);

    const content = (await buildProjectConventions(cwd))[0]?.content ?? "";
    expect(content).toContain("line 79");
    expect(content).not.toContain("line 80\n");
    expect(content).toContain("truncated at 80 lines, file has 500 total");
  });

  it("refuses a file past the size cap outright", async () => {
    const cwd = await dir("oversized");
    // One line, so the line cap cannot save us: only the byte cap can.
    await fs.writeFile(path.join(cwd, "AGENTS.md"), "x".repeat(1_000_001));
    expect(await buildProjectConventions(cwd)).toEqual([]);
  });

  it("refuses a binary file that happens to carry a conventions name", async () => {
    const cwd = await dir("binary");
    // A PNG header: inside the size cap, inside the line cap, not text.
    await fs.writeFile(
      path.join(cwd, "CLAUDE.md"),
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(512),
      ]),
    );
    expect(await buildProjectConventions(cwd)).toEqual([]);
  });

  it("refuses a conventions file that is a symlink out of the project", async () => {
    const cwd = await dir("symlinked");
    const secret = path.join(root, "id_rsa");
    await fs.writeFile(secret, "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n");
    await fs.symlink(secret, path.join(cwd, "AGENTS.md"));

    const out = await buildProjectConventions(cwd);
    expect(out).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("spends one shared character budget so a huge file cannot crowd out the rest", async () => {
    const cwd = await dir("budget");
    // 80 lines of 200 characters each: inside the line cap, past the budget.
    const fat = Array.from({ length: 80 }, () => "a".repeat(200)).join("\n");
    await fs.writeFile(path.join(cwd, "AGENTS.md"), fat);
    await fs.writeFile(path.join(cwd, "CLAUDE.md"), "short and important");

    const out = await buildProjectConventions(cwd);
    const total = out.reduce((n, f) => n + f.content.length, 0);
    // 4,000 for the content plus the one "\n… (truncated)" marker.
    expect(total).toBeLessThanOrEqual(4000 + "\n… (truncated)".length);
    expect(out[0]?.content.endsWith("\n… (truncated)")).toBe(true);
    // The budget is exhausted by the first file, so the second is dropped
    // whole rather than being sent as an empty block.
    expect(out.map((f) => f.path)).toEqual(["AGENTS.md"]);
  });
});

describe("gatherEnhancerContext conventions wiring", () => {
  let cwd = "";

  beforeAll(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-prompt-enhancer-gather-"));
    await fs.writeFile(path.join(cwd, "AGENTS.md"), "Conventional Commits, scope required.");
  });

  afterAll(async () => {
    if (cwd) await fs.rm(cwd, { recursive: true, force: true });
  });

  it("gathers conventions alongside the tree, git and mentioned files", async () => {
    const context = await gatherEnhancerContext("tidy this up", cwd, new AbortController().signal);
    expect(context.conventions?.map((f) => f.path)).toEqual(["AGENTS.md"]);
  });

  it("puts them in the user message as constraints, ahead of the original prompt", async () => {
    const context = await gatherEnhancerContext("tidy this up", cwd, new AbortController().signal);
    const message = buildEnhancerUserMessage("tidy this up", context);
    expect(message).toContain("## Project conventions (constraints on the rewrite");
    expect(message).toContain("### AGENTS.md");
    expect(message).toContain("Conventional Commits, scope required.");
    expect(message.indexOf("## Project conventions")).toBeLessThan(
      message.indexOf("## Original prompt"),
    );
  });

  it("still refuses to read outside the working directory", async () => {
    // The path-containment guard, exercised through the shipped entry point:
    // the prompt names a file that exists, one level above cwd.
    const outside = path.join(path.dirname(cwd), "outside-secret.md");
    await fs.writeFile(outside, "TOP SECRET");
    try {
      const context = await gatherEnhancerContext(
        "read ../outside-secret.md and fix it",
        cwd,
        new AbortController().signal,
      );
      expect(context.mentionedFiles).toEqual([]);
      expect(JSON.stringify(context)).not.toContain("TOP SECRET");
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});

describe("buildEnhancerUserMessage conventions section", () => {
  const baseContext: EnhancerContext = { cwd: "/tmp/example", mentionedFiles: [] };

  it("omits the section entirely when there are no conventions", () => {
    expect(buildEnhancerUserMessage("hi", baseContext)).not.toContain("## Project conventions");
    expect(buildEnhancerUserMessage("hi", { ...baseContext, conventions: [] })).not.toContain(
      "## Project conventions",
    );
  });

  it("tells the model in the heading that these bind the rewrite", () => {
    const out = buildEnhancerUserMessage("hi", {
      ...baseContext,
      conventions: [{ path: "AGENTS.md", content: "No emoji." }],
    });
    expect(out).toContain(
      "## Project conventions (constraints on the rewrite — do not restate them)",
    );
    expect(out).toContain("### AGENTS.md\n```\nNo emoji.\n```");
  });

  it("orders conventions before the prompt-specific files", () => {
    const out = buildEnhancerUserMessage("hi", {
      ...baseContext,
      conventions: [{ path: "AGENTS.md", content: "c" }],
      mentionedFiles: [{ path: "f.ts", content: "x" }],
    });
    expect(out.indexOf("## Project conventions")).toBeLessThan(
      out.indexOf("## Files referenced in the prompt"),
    );
  });
});
