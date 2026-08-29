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
import {
  type AssistantMessage,
  fauxAssistantMessage,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import {
  type ExtensionAPI,
  type ExtensionContext,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import factory, {
  allocateConventionsBudget,
  buildEnhancerUserMessage,
  buildProjectConventions,
  buildRecentTurns,
  CONVENTIONS_FILE_MAX_CHARS,
  CONVENTIONS_TOTAL_MAX_CHARS,
  completeWithRetry,
  computePickerMaxVisible,
  createEnhancerModelSelector,
  ENHANCER_RETRY_POLICY,
  type EnhancerContext,
  editorHoldsOurText,
  enhancedStatusText,
  filterPickerItems,
  formatEnhancementFailure,
  formatRetryStatus,
  formatSkippedFiles,
  gatherEnhancerContext,
  HISTORY_MAX_CHARS,
  HISTORY_MAX_TURNS,
  HISTORY_TURN_MAX_CHARS,
  normalizeFailureReason,
  revertStatusText,
  SYSTEM_PROMPT,
  TOO_SHORT_MESSAGE,
  toEditorText,
} from "./index.js";
import { ENHANCING_SEGMENT } from "./widget.js";

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

  it("tells the model to carry fenced samples through unchanged", () => {
    // Pasting a stack trace or a failing test into the draft is normal, and a
    // reworded trace is worse than no rewrite at all: its line numbers and
    // identifiers are the entire reason it was pasted.
    expect(SYSTEM_PROMPT).toContain("triple backticks");
    expect(SYSTEM_PROMPT).toMatch(/carry it through unchanged/i);
  });

  it("asks for typo fixes without licensing a change of intent", () => {
    expect(SYSTEM_PROMPT).toMatch(/fix typos and misspellings/i);
    // Identifiers and paths are the ones worth naming: a misspelled path is
    // what the "invent no path" rule would otherwise preserve faithfully.
    expect(SYSTEM_PROMPT).toContain("identifiers and paths");
    // The licence is bounded, so it cannot be read as permission to reinterpret.
    expect(SYSTEM_PROMPT).toMatch(/without changing what is asked for/i);
    // …and the anti-invention rule it sits beside is still intact.
    expect(SYSTEM_PROMPT).toContain("Invent nothing");
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
   * better context, never more instructions.
   *
   * 1,218 was the 3.0.1 length. Three new rules — fenced samples, typo repair,
   * project conventions — cost +270 characters, and nothing tuned by the
   * acceptance matrix was removed to pay for them. 1,550 leaves room to reword
   * those three without leaving room for a fourth: adding one means cutting one.
   */
  it("stays inside its character budget", () => {
    expect(SYSTEM_PROMPT.length).toBeLessThanOrEqual(1550);
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
    const out = buildRecentTurns([turn("user", "x".repeat(2000))]);
    expect(out?.endsWith("…")).toBe(true);
    // "User: " + 600 clipped characters + the ellipsis.
    expect((out ?? "").length).toBe("User: ".length + HISTORY_TURN_MAX_CHARS + 1);
  });

  it("stops at the total budget instead of returning a whole long session", () => {
    const long = "y".repeat(HISTORY_TURN_MAX_CHARS);
    const out = buildRecentTurns([
      turn("user", long),
      turn("assistant", long),
      turn("user", long),
      turn("assistant", long),
    ]);
    expect((out ?? "").length).toBeLessThanOrEqual(HISTORY_MAX_CHARS);
    // The newest turn survives; the oldest is what the budget drops.
    expect(out?.split("\n").at(-1)?.startsWith("Agent:")).toBe(true);
  });

  /**
   * The caps, pinned. 320 characters cut an assistant turn mid-sentence, and
   * the assistant turn is usually the referent of the follow-up being rewritten
   * ("do that for the other package too"), so the clip landed on exactly the
   * text the rewrite needed. Turn count stays at 4: the fix was depth per turn,
   * not more turns.
   */
  it("keeps the conversation bounds where they were set", () => {
    expect(HISTORY_MAX_TURNS).toBe(4);
    expect(HISTORY_TURN_MAX_CHARS).toBe(600);
    expect(HISTORY_MAX_CHARS).toBe(2000);
    // The total must hold more than one full-width turn, or the per-turn cap
    // would be unreachable for anything but the newest entry.
    expect(HISTORY_MAX_CHARS).toBeGreaterThan(HISTORY_TURN_MAX_CHARS * 2);
  });

  it("fits four full-width turns inside the total budget", () => {
    const long = "z".repeat(5000);
    const out = buildRecentTurns([
      turn("user", long),
      turn("assistant", long),
      turn("user", long),
      turn("assistant", long),
      turn("user", long),
    ]);
    const lines = (out ?? "").split("\n");
    // Three clipped 600-char turns fit in 2,000; the fourth does not, and the
    // budget drops whole lines rather than truncating one mid-sentence.
    expect(lines.length).toBe(3);
    expect((out ?? "").length).toBeLessThanOrEqual(HISTORY_MAX_CHARS);
    for (const line of lines) expect(line.endsWith("…")).toBe(true);
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

describe("revertStatusText", () => {
  it("claims the user's own prompt only when nothing else wrote the editor", () => {
    expect(revertStatusText(false)).toBe("Reverted to your original prompt.");
  });

  it("keeps the same sentence and warns about later edits once the chain left our text", () => {
    const hedged = revertStatusText(true);
    expect(hedged).toBe("Reverted to your original prompt; later edits lost.");
    // Same opening as the clean path: one sentence the user learns once.
    expect(hedged.startsWith("Reverted to your original prompt")).toBe(true);
  });
});

describe("formatSkippedFiles", () => {
  it("says nothing when nothing was refused", () => {
    expect(formatSkippedFiles(undefined)).toBeUndefined();
    expect(formatSkippedFiles([])).toBeUndefined();
  });

  it("names the file and why it was refused", () => {
    expect(formatSkippedFiles([{ path: "assets/logo.png", why: "not text" }])).toBe(
      "Skipped assets/logo.png (not text).",
    );
  });

  it("falls back to a count past two files", () => {
    expect(
      formatSkippedFiles([
        { path: "a.png", why: "not text" },
        { path: "b.md", why: "too large" },
        { path: "c.bin", why: "not text" },
      ]),
    ).toBe("Skipped a.png (not text), b.md (too large) +1 more.");
  });

  /**
   * The widget line wraps rather than truncating, so the budget buys height,
   * not visibility: two refused files a few directories deep measured 243
   * characters, which is four wrapped rows at 80 columns above the editor.
   */
  it("keeps the note inside its budget however deep the paths are", () => {
    const deep = (name: string) => `packages/prompt-enhancer/acceptance/fixtures/generated/${name}`;
    for (const skipped of [
      [{ path: deep("one-with-a-long-name.bin"), why: "not text" }],
      [
        { path: deep("one-with-a-long-name.bin"), why: "not text" },
        { path: deep("another-long-name.log"), why: "too large" },
      ],
      [
        { path: deep("one-with-a-long-name.bin"), why: "not text" },
        { path: deep("another-long-name.log"), why: "too large" },
        { path: deep("a-third.ico"), why: "not text" },
      ],
    ]) {
      const note = formatSkippedFiles(skipped);
      expect(note, JSON.stringify(skipped)).toBeDefined();
      expect((note ?? "").length, note).toBeLessThanOrEqual(120);
    }
  });

  it("keeps the tail of a long path, which is the half that names the file", () => {
    const note = formatSkippedFiles([
      { path: "packages/prompt-enhancer/acceptance/fixtures/icon.ico", why: "not text" },
    ]);
    expect(note).toContain("icon.ico");
    expect(note).toContain("…");
    expect((note ?? "").length).toBeLessThanOrEqual(120);
  });

  it("gives up on names before it gives up on the budget", () => {
    const note = formatSkippedFiles([
      { path: "a".repeat(200), why: "not text" },
      { path: "b".repeat(200), why: "too large" },
    ]);
    expect((note ?? "").length).toBeLessThanOrEqual(120);
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
  /** How many times the enhancer asked the registry to resolve credentials. */
  authLookups: number;
}

/** Registered handlers, so tests can drive commands and events like pi does. */
function createHarness(): {
  commands: Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>;
  events: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
  shortcuts: Map<string, (ctx: ExtensionContext) => Promise<void>>;
} {
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const shortcuts = new Map<string, (ctx: ExtensionContext) => Promise<void>>();
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
    registerShortcut: (
      name: string,
      def: { handler: (ctx: ExtensionContext) => Promise<void> },
    ) => {
      shortcuts.set(name, def.handler);
    },
  } as unknown as ExtensionAPI;
  factory(api);
  return { commands, events, shortcuts };
}

function createHost(options: {
  draft: string;
  cancel?: boolean;
  /** Defaults to "tui". "rpc" keeps a UI but gets no custom components. */
  mode?: string;
  /** Defaults to true. False is print/JSON mode: no editor, no widget. */
  hasUI?: boolean;
  /** True when the host has no session model at all. */
  noModel?: boolean;
  /** What the registry answers when asked for credentials. */
  auth?: { ok: boolean; error?: string; apiKey?: string };
  /**
   * Which model the host hands the enhancer. Defaults to one whose `api` no
   * provider is registered for, which is how the failure suite gets a genuine
   * error out of the real code path. The revert suite passes a faux provider's
   * model instead, so the same path succeeds.
   */
  model?: unknown;
  cwd?: string;
}): {
  ctx: ExtensionContext;
  log: HostLog;
  /** What pi does to the editor on Enter, before it fires the input event. */
  clearEditorLikeEnter: () => void;
  /** Type over the editor the way the user would. */
  typeIntoEditor: (text: string) => void;
} {
  const log: HostLog = { notifications: [], widgets: [], editorTexts: [], authLookups: 0 };

  const tuiStub = { requestRender: () => {}, terminal: { rows: 24, columns: 80 } };
  const themeStub = {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };

  /**
   * The real pi-tui editor, not a string.
   *
   * The host's job is to behave like pi, and pi's editor rewrites text on the
   * way in — CRLF/CR to LF, TAB to four spaces. A `let editorText = text` stub
   * silently round-trips everything unchanged, which is precisely the
   * assumption that let the tab mismatch through. Driving the real component
   * means these tests see what a user's terminal sees.
   */
  const editor = new Editor(tuiStub as never, { borderColor: (s: string) => s } as never);
  editor.setText(options.draft);
  // pi's own ExtensionUIContext.getEditorText, verbatim.
  const readEditor = () => editor.getExpandedText?.() ?? editor.getText();

  const ctx = {
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    cwd: options.cwd ?? hostCwd,
    model: options.noModel
      ? undefined
      : (options.model ?? { provider: "test", id: "unreachable", api: "no-such-api-provider" }),
    modelRegistry: {
      getApiKeyAndHeaders: () => {
        log.authLookups += 1;
        return Promise.resolve({
          headers: {},
          ...(options.auth ?? { ok: true, apiKey: "test-key" }),
        });
      },
    },
    sessionManager: { getBranch: () => [] },
    ui: {
      getEditorText: readEditor,
      setEditorText: (text: string) => {
        editor.setText(text);
        // What the extension asked for, before pi normalises it — the log is
        // about the extension's intent, the editor about the user's reality.
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
      editor.setText("");
    },
    typeIntoEditor: (text: string) => {
      editor.setText(text);
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
    const said = lastWidgetLine(log);
    expect(said).toMatch(/prompt enhancement failed \(.+\); your prompt is unchanged/);
    expect(said).toContain(
      formatEnhancementFailure("No API provider registered for api: no-such-api-provider"),
    );

    await shutdown(host.harness, host.ctx);
  });

  /**
   * The split.
   *
   * A call that failed on the way out — the network, the service, a timeout,
   * an empty response — leaves nothing for the user to do but press the key
   * again, so it rides the transient status and clears itself. A missing
   * model or a missing key is the opposite: nothing the user does at the
   * keyboard will help until they configure something, and a message that
   * disappears is the wrong shape for that.
   */
  it("clears itself instead of sitting in the notification area", async () => {
    const host = await armed();
    await submit(host);

    expect(host.log.notifications).toEqual([]);
    expect(lastWidgetLine(host.log)).toContain("prompt enhancement failed");

    await shutdown(host.harness, host.ctx);
  });

  it.each([
    {
      what: "no active model",
      host: { noModel: true },
      expected: "Prompt Enhancer: no active model. Pick one with /model first.",
    },
    {
      what: "auth resolution failed",
      host: { auth: { ok: false, error: "keychain locked" } },
      expected: "Prompt Enhancer: keychain locked",
    },
    {
      what: "no API key configured",
      host: { auth: { ok: true, apiKey: "" } },
      expected: "Prompt Enhancer: no API key configured for test/unreachable.",
    },
  ])("keeps $what as a notification the user has to read", async ({ host, expected }) => {
    const harness = createHarness();
    const target = createHost({ draft: DRAFT, ...host });
    await harness.events.get("session_start")?.({}, target.ctx);
    await harness.commands.get("prompt_enhance")?.("", target.ctx);

    expect(target.log.notifications).toEqual([{ message: expected, level: "error" }]);
    // Nothing transient was said, and no rewrite was attempted.
    expect(lastWidgetLine(target.log)).not.toContain("failed");
    expect(target.log.editorTexts).toEqual([]);

    await shutdown(harness, target.ctx);
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

    expect(log.notifications).toEqual([]);
    expect(lastWidgetLine(log)).toContain(
      formatEnhancementFailure("No API provider registered for api: no-such-api-provider"),
    );
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

// ── The visible enhancing state ────────────────────────────────────────

/** The yellow in-flight block is a padded Powerline segment, like `auto`. */
function hasEnhancingChip(line: string): boolean {
  return line.includes(` ${ENHANCING_SEGMENT} `);
}

/**
 * The widget says "enhancing" for exactly as long as the call is out.
 *
 * The BorderedLoader already blocks input, but it lives below the editor and
 * says nothing once it is gone; the status bar above the editor is what a user
 * reads to know the extension is working. What matters here is not that the
 * state can be painted — widget.test.ts covers that — but that it is *cleared*
 * on every way out of the run, including ones nobody thinks about.
 */
describe("the enhancing state", () => {
  const DRAFT = "rework the enhancer widget so the segments collapse cleanly";
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeAll(() => {
    faux = registerFauxProvider({ api: "faux-enhancing-state", provider: "faux-state" });
  });

  afterAll(() => {
    faux.unregister();
  });

  async function run(options: {
    model?: unknown;
    cancel?: boolean;
    mode?: string;
  }): Promise<HostLog> {
    const harness = createHarness();
    const host = createHost({ draft: DRAFT, ...options });
    await harness.events.get("session_start")?.({}, host.ctx);
    await harness.commands.get("prompt_enhance")?.("", host.ctx);
    await harness.events.get("session_shutdown")?.({}, host.ctx);
    return host.log;
  }

  it("is on screen while the call is out, and gone after a success", async () => {
    faux.setResponses([fauxAssistantMessage("Collapse the widget segments cleanly.")]);
    const log = await run({ model: faux.getModel() });

    expect(log.widgets.map((w) => w[0] ?? "").some(hasEnhancingChip)).toBe(true);
    expect(hasEnhancingChip(lastWidgetLine(log))).toBe(false);
    expect(lastWidgetLine(log)).toContain("Prompt enhanced");
  });

  it("clears when the user cancels with Esc", async () => {
    faux.setResponses([fauxAssistantMessage("never read — Esc lands first")]);
    const log = await run({ model: faux.getModel(), cancel: true });

    expect(log.widgets.map((w) => w[0] ?? "").some(hasEnhancingChip)).toBe(true);
    expect(hasEnhancingChip(lastWidgetLine(log))).toBe(false);
    expect(lastWidgetLine(log)).toContain("Cancelled.");
  });

  it("clears when the call fails", async () => {
    // Default host model: an api no provider is registered for.
    const log = await run({});

    expect(log.widgets.map((w) => w[0] ?? "").some(hasEnhancingChip)).toBe(true);
    expect(hasEnhancingChip(lastWidgetLine(log))).toBe(false);
  });

  it("clears on the headless call path, which has no loader to hide behind", async () => {
    // RPC: hasUI is true, so the widget is painted, but ctx.ui.custom resolves
    // undefined and the work runs with no BorderedLoader at all.
    faux.setResponses([fauxAssistantMessage("Collapse the widget segments cleanly.")]);
    const log = await run({ model: faux.getModel(), mode: "rpc" });

    expect(log.widgets.map((w) => w[0] ?? "").some(hasEnhancingChip)).toBe(true);
    expect(hasEnhancingChip(lastWidgetLine(log))).toBe(false);
  });

  it("paints nothing at all without a UI", async () => {
    const harness = createHarness();
    const host = createHost({ draft: DRAFT, hasUI: false, mode: "print" });
    await harness.events.get("session_start")?.({}, host.ctx);
    await harness.commands.get("prompt_enhance")?.("", host.ctx);

    expect(host.log.widgets).toEqual([]);
    expect(host.log.notifications.map((n) => n.level)).toEqual(["warning"]);
    await harness.events.get("session_shutdown")?.({}, host.ctx);
  });
});

// ── Too short to enhance ───────────────────────────────────────────────

/**
 * `ok` is not a prompt.
 *
 * Ctrl+Shift+E on two characters used to gather a file tree, a git summary,
 * the project's instruction files and the recent turns — thousands of tokens
 * of context — to rewrite a word. The refusal has to land before any of that,
 * which means before credentials are even resolved.
 */
describe("a draft too short to enhance", () => {
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeAll(() => {
    faux = registerFauxProvider({ api: "faux-too-short", provider: "faux-short" });
  });

  afterAll(() => {
    faux.unregister();
  });

  async function armed(draft: string): Promise<{
    harness: ReturnType<typeof createHarness>;
    ctx: ExtensionContext;
    log: HostLog;
  }> {
    const harness = createHarness();
    const host = createHost({ draft, model: faux.getModel() });
    await harness.events.get("session_start")?.({}, host.ctx);
    return { harness, ctx: host.ctx, log: host.log };
  }

  it("costs nothing: no auth lookup, no call, no context gathering", async () => {
    const host = await armed("ok");
    await host.harness.commands.get("prompt_enhance")?.("", host.ctx);

    expect(host.log.authLookups).toBe(0);
    expect(lastWidgetLine(host.log)).toContain(TOO_SHORT_MESSAGE);
    // The draft is untouched — nothing was written to the editor at all.
    expect(host.log.editorTexts).toEqual([]);
    expect(host.ctx.ui.getEditorText()).toBe("ok");
    // It is guidance, not a failure: nothing in the notification area.
    expect(host.log.notifications).toEqual([]);
    await host.harness.events.get("session_shutdown")?.({}, host.ctx);
  });

  it("says the same thing from the shortcut", async () => {
    const host = await armed("ship it");
    await host.harness.shortcuts.get("ctrl+shift+e")?.(host.ctx);

    expect(host.log.authLookups).toBe(0);
    expect(lastWidgetLine(host.log)).toContain(TOO_SHORT_MESSAGE);
    await host.harness.events.get("session_shutdown")?.({}, host.ctx);
  });

  it("and from a command argument, which never touches the editor", async () => {
    const host = await armed("");
    await host.harness.commands.get("prompt_enhance")?.("ship it", host.ctx);

    expect(host.log.authLookups).toBe(0);
    expect(lastWidgetLine(host.log)).toContain(TOO_SHORT_MESSAGE);
    await host.harness.events.get("session_shutdown")?.({}, host.ctx);
  });

  it("never paints the enhancing state, because no call is made", async () => {
    const host = await armed("ok");
    await host.harness.commands.get("prompt_enhance")?.("", host.ctx);

    expect(host.log.widgets.map((w) => w[0] ?? "").some(hasEnhancingChip)).toBe(false);
    await host.harness.events.get("session_shutdown")?.({}, host.ctx);
  });

  it("enhances a short draft that names a file", async () => {
    const host = await armed("fix foo.ts");
    faux.setResponses([fauxAssistantMessage("Fix the failing behaviour in foo.ts.")]);
    await host.harness.commands.get("prompt_enhance")?.("", host.ctx);

    expect(host.log.authLookups).toBe(1);
    expect(host.ctx.ui.getEditorText()).toBe("Fix the failing behaviour in foo.ts.");
    expect(lastWidgetLine(host.log)).not.toContain(TOO_SHORT_MESSAGE);
    await host.harness.events.get("session_shutdown")?.({}, host.ctx);
  });

  it("stays out of auto-enhance's way, which stands down without a word", async () => {
    const host = await armed("ok");
    await host.harness.commands.get("prompt_enhance_auto")?.("", host.ctx);

    // Enter, as pi delivers it: the editor is emptied before the event fires.
    const outcome = await host.harness.events.get("input")?.(
      { source: "interactive", text: "ok", images: [] },
      host.ctx,
    );

    // The draft went to the agent, and the widget said nothing about it.
    expect(outcome).toEqual({ action: "continue" });
    expect(host.log.widgets.map((w) => w[0] ?? "").join("")).not.toContain(TOO_SHORT_MESSAGE);
    expect(host.log.authLookups).toBe(0);
    await host.harness.events.get("session_shutdown")?.({}, host.ctx);
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

  /**
   * The false positive the control-ratio rule used to have.
   *
   * A saved terminal log is ordinary text — it is exactly the artefact the
   * `fenced-trace` fixture models a user pasting — but every SGR sequence in it
   * carries an ESC, and ESC is a C0 control. At two colour changes per line the
   * log ran past the 2% threshold and was refused without a word.
   */
  it("accepts a saved ANSI-coloured CI log, which is text with colour in it", async () => {
    const line = "\u001b[32mPASS\u001b[0m packages/prompt-enhancer/index.test.ts\n";
    await fs.mkdir(path.join(cwd, "logs"), { recursive: true });
    await fs.writeFile(path.join(cwd, "logs", "ci.log"), line.repeat(200));

    const context = await gather("this is what CI printed, see logs/ci.log");
    const file = context.mentionedFiles.find((f) => f.path === "logs/ci.log");
    expect(file?.content).toContain("PASS");
    // The colour codes survive: they are part of the text, not noise to strip.
    expect(file?.content).toContain("\u001b[32m");
    expect(context.skippedFiles ?? []).toEqual([]);
  });

  /**
   * The false negative the NUL rule used to have.
   *
   * `BINARY_PROBE_CHARS` is 8,192, and the NUL check lived inside that window.
   * A file that read as text for 9,000 characters and then carried a NUL cleared
   * the probe and was delivered: content 9,101 characters long, `includes("\0")`
   * true. The NUL rule is now unwindowed.
   */
  it("refuses a file whose first NUL sits past the probe window", async () => {
    await fs.mkdir(path.join(cwd, "tmp"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "tmp", "late-nul.bin"),
      Buffer.concat([
        Buffer.from("a".repeat(9_000)),
        Buffer.alloc(1),
        Buffer.from("b".repeat(100)),
      ]),
    );

    const context = await gather("what is in tmp/late-nul.bin");
    expect(context.mentionedFiles.map((f) => f.path)).not.toContain("tmp/late-nul.bin");
    expect(JSON.stringify(context.mentionedFiles)).not.toContain("\u0000");
    expect(context.skippedFiles).toContainEqual({ path: "tmp/late-nul.bin", why: "not text" });
  });

  it("refuses a file past the size cap", async () => {
    await fs.writeFile(path.join(cwd, "huge.md"), "x".repeat(1_000_001));
    const context = await gather("summarise huge.md");
    expect(context.mentionedFiles.map((f) => f.path)).not.toContain("huge.md");
    expect(context.skippedFiles).toContainEqual({ path: "huge.md", why: "too large" });
  });

  it("names a refused file instead of dropping it in silence", async () => {
    await fs.mkdir(path.join(cwd, "img"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "img", "icon.ico"),
      Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x00]), Buffer.alloc(2048)]),
    );

    const context = await gather("why does img/icon.ico look wrong");
    expect(context.skippedFiles).toContainEqual({ path: "img/icon.ico", why: "not text" });
    // And the note the user actually sees says so.
    expect(formatSkippedFiles(context.skippedFiles)).toBe("Skipped img/icon.ico (not text).");
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

  /**
   * What the status bar is allowed to say about a path it never read.
   *
   * The containment check returned the raw token as a `SkippedFile` before any
   * `stat`, so `"read /Users/…/Library/Keychains/login.keychain-db"` rendered
   * that absolute path verbatim in the widget, and `"check ~/.ssh/id_rsa"`
   * rendered `/.ssh/id_rsa` — a path the user never typed, because the token
   * extractor drops the tilde. Neither file had been looked at. A path outside
   * the project has no repo-relative name and is now silent.
   */
  it("says nothing about a path outside the project, read or not", async () => {
    for (const prompt of [
      "read /Users/someone/Library/Keychains/login.keychain-db",
      "check ~/.ssh/id_rsa",
      "look at /var/db/no-such-thing/nope.md",
      "read ../escaped-secret.md and fix it",
    ]) {
      const context = await gather(prompt);
      expect(context.skippedFiles ?? [], prompt).toEqual([]);
      expect(JSON.stringify(context), prompt).not.toContain("Keychains");
      expect(JSON.stringify(context), prompt).not.toContain("id_rsa");
    }
  });

  it("says nothing about a file inside the project that is not there", async () => {
    const context = await gather("fix the typo in docs/not-a-real-file.md");
    expect(context.skippedFiles ?? []).toEqual([]);
  });

  /**
   * The other spelling of an OSC terminator.
   *
   * ESC was exempt from the control ratio and BEL was not, so an OSC-8
   * hyperlinked log — what `gh` and `cargo` write — scored 2.98% controls and
   * was refused as "not text", while the same log written with the `ESC \\`
   * terminator was accepted. The refusal depended on which spelling the tool
   * chose.
   */
  it("accepts a log whose hyperlinks and titles end with BEL", async () => {
    const link = "\u001b]8;;https://example.com/run/1\u0007view run\u001b]8;;\u0007";
    const title = "\u001b]0;build: package 12/40\u0007";
    await fs.mkdir(path.join(cwd, "logs"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "logs", "osc8.log"),
      `${title}${`${link} PASS packages/prompt-enhancer\n`.repeat(60)}`,
    );

    const context = await gather("this is what CI printed, see logs/osc8.log");
    expect(context.mentionedFiles.map((f) => f.path)).toContain("logs/osc8.log");
    expect(context.skippedFiles ?? []).toEqual([]);
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

  /**
   * The motivating measurement: this repo's own `AGENTS.md` is 6,033 bytes of
   * ordinary instruction content, and the old 4,000-character shared budget cut
   * it mid-sentence inside an inline-code span. A rule that arrives in halves is
   * worse than no rule, so a file this size must arrive whole.
   */
  it("sends a 6 KB instruction file whole, with no truncation marker", async () => {
    const cwd = await dir("six-kb");
    const paragraph = "Branch protection requires a PR; CODEOWNERS review is mandatory.";
    const body = Array.from({ length: 80 }, (_, i) => `- rule ${String(i)}: ${paragraph}`).join(
      "\n",
    );
    // Sized on this repo's own AGENTS.md (6,033 bytes), which is what the old
    // 4,000-character budget cut in half.
    expect(body.length).toBeGreaterThan(6000);
    expect(body.length).toBeLessThan(7000);
    await fs.writeFile(path.join(cwd, "AGENTS.md"), body);

    const out = await buildProjectConventions(cwd);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toBe(body);
    expect(out[0]?.content).not.toContain("truncated");
  });

  /**
   * The same measurement one size up, and the reason the ceiling moved. This
   * repo's own `CONTRIBUTING.md` is 20,528 bytes / 20,394 characters, and the
   * 16 KB per-file ceiling that preceded this one sent 16,358 of them — the
   * feature failing at its job to save tokens nobody asked to save. The ceiling
   * is a safety valve against a generated multi-megabyte dump, so a real
   * instruction file of this size has to arrive whole.
   */
  it("sends a 20 KB instruction file whole, with no truncation marker", async () => {
    const cwd = await dir("twenty-kb");
    const paragraph =
      "Every PR is squash-merged, commitlint runs over the whole range, and release-please owns the bump.";
    const body = Array.from({ length: 210 }, (_, i) => `- rule ${String(i)}: ${paragraph}`).join(
      "\n",
    );
    // Sized past this repo's own CONTRIBUTING.md, which the previous ceiling cut.
    expect(body.length).toBeGreaterThan(20_394);
    await fs.writeFile(path.join(cwd, "CONTRIBUTING.md"), body);

    const out = await buildProjectConventions(cwd);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toBe(body);
    expect(out[0]?.content).not.toContain("truncated");
  });

  it("truncates on a line boundary and says how much it left behind", async () => {
    const cwd = await dir("over-the-file-cap");
    // 400 lines of 200 characters: past the 64 KB per-file ceiling, so it is
    // clipped — but only ever between lines.
    const lines = Array.from({ length: 400 }, (_, i) => `${String(i)} ${"x".repeat(196)}`);
    await fs.writeFile(path.join(cwd, "AGENTS.md"), lines.join("\n"));

    const content = (await buildProjectConventions(cwd))[0]?.content ?? "";
    expect(content.split("\n").at(-1)).toMatch(
      /^… \(truncated: sent \d+ of 400 lines, \d+ of \d+ characters\)$/,
    );

    // Every line that survived is a whole line from the file: nothing was cut
    // mid-token.
    const body = content.split("\n").slice(0, -1);
    expect(body.length).toBeGreaterThan(0);
    for (const [index, line] of body.entries()) expect(line).toBe(lines[index]);
    expect(body.join("\n").length).toBeLessThanOrEqual(CONVENTIONS_FILE_MAX_CHARS);
  });

  it("omits a file whose first line alone will not fit rather than cutting mid-token", async () => {
    const cwd = await dir("one-huge-line");
    // A single line larger than the per-file ceiling: there is no line-boundary
    // prefix to send, so nothing is sent. Half a token is worse than nothing.
    await fs.writeFile(path.join(cwd, "AGENTS.md"), "x".repeat(CONVENTIONS_FILE_MAX_CHARS + 1));
    await fs.writeFile(path.join(cwd, "CLAUDE.md"), "short and important");

    const out = await buildProjectConventions(cwd);
    expect(out.map((f) => f.path)).toEqual(["CLAUDE.md"]);
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

  /**
   * The old spend was winner-take-all: the budget was walked in
   * `CONVENTION_FILES` order and whatever was left went to the next file, so on
   * this repo `AGENTS.md` came back truncated and `CONTRIBUTING.md` was dropped
   * with no marker at all. Every file that is present must now be represented.
   */
  it("represents every instruction file that is present, not just the first", async () => {
    const cwd = await dir("all-three-large");
    const fat = (label: string, lines: number) =>
      Array.from({ length: lines }, (_, i) => `${label} ${String(i)} ${"y".repeat(180)}`).join(
        "\n",
      );
    await fs.writeFile(path.join(cwd, "AGENTS.md"), fat("agents", 400));
    await fs.writeFile(path.join(cwd, "CLAUDE.md"), fat("claude", 400));
    await fs.writeFile(path.join(cwd, "CONTRIBUTING.md"), fat("contributing", 400));

    const out = await buildProjectConventions(cwd);
    expect(out.map((f) => f.path)).toEqual(["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]);
    expect(out[0]?.content).toContain("agents 0");
    expect(out[1]?.content).toContain("claude 0");
    expect(out[2]?.content).toContain("contributing 0");

    const total = out.reduce((n, f) => n + f.content.length, 0);
    // Content stays inside the total; the three markers ride on top of it.
    expect(total).toBeLessThanOrEqual(CONVENTIONS_TOTAL_MAX_CHARS + 3 * 120);
  });

  it("gives a small file all of itself and spends the remainder on the large one", async () => {
    const cwd = await dir("uneven");
    await fs.writeFile(path.join(cwd, "AGENTS.md"), "tiny but load-bearing");
    const big = Array.from({ length: 400 }, (_, i) => `${String(i)} ${"z".repeat(180)}`).join("\n");
    await fs.writeFile(path.join(cwd, "CLAUDE.md"), big);

    const out = await buildProjectConventions(cwd);
    expect(out.map((f) => f.path)).toEqual(["AGENTS.md", "CLAUDE.md"]);
    // The small file is whole — an equal split would have wasted most of its
    // half, so water-filling hands the surplus to the file that wants it.
    expect(out[0]?.content).toBe("tiny but load-bearing");
    expect(out[1]?.content.length).toBeGreaterThan(CONVENTIONS_FILE_MAX_CHARS - 200);
  });
});

/**
 * The budget split on its own, where the degenerate cases are reachable.
 *
 * The production constants are generous enough that a sliver cannot occur with
 * three files, which is exactly why the sliver rule is pinned here with small
 * numbers instead: the old loop tested `budget <= 0` *before* slicing, so a
 * file could be admitted as ~10 characters plus a 14-character marker.
 */
describe("allocateConventionsBudget", () => {
  it("gives everyone what they want when the total covers it", () => {
    expect(allocateConventionsBudget([100, 200, 300], 10_000, 5_000, 50)).toEqual([100, 200, 300]);
  });

  it("caps any single file at the per-file limit", () => {
    expect(allocateConventionsBudget([9_000, 100], 100_000, 5_000, 50)).toEqual([5_000, 100]);
  });

  it("splits a tight total evenly rather than first-come-first-served", () => {
    expect(allocateConventionsBudget([5_000, 5_000, 5_000], 900, 5_000, 100)).toEqual([
      300, 300, 300,
    ]);
  });

  it("redistributes what a small file does not need", () => {
    // 1,000 across two: an even split would give the 50-char file 500 and waste
    // 450 of it. It takes 50; the other takes the remaining 950.
    expect(allocateConventionsBudget([50, 5_000], 1_000, 5_000, 10)).toEqual([50, 950]);
  });

  it("omits a file rather than admitting it as a sliver", () => {
    // 30 characters each is not a shorter version of the file, it is noise.
    expect(allocateConventionsBudget([5_000, 5_000], 60, 5_000, 400)).toEqual([0, 0]);
  });

  it("keeps a file that is genuinely smaller than the sliver floor", () => {
    // The floor gates *partial* files. A 12-character file that fits whole is
    // whole, not a sliver.
    expect(allocateConventionsBudget([12, 5_000], 10_000, 5_000, 400)).toEqual([12, 5_000]);
  });

  it("handles no files at all", () => {
    expect(allocateConventionsBudget([])).toEqual([]);
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

// ── The editor's representation ─────────────────────────────────────────
//
// `editorHoldsOurText` decides two things: whether an enhance is a re-roll of
// the stored original, and whether revert may claim nothing was typed over. Both
// answers are wrong if our idea of what the editor does to text differs from
// what it actually does, so the shapes below are checked against a real pi-tui
// `Editor` rather than against a description of one.

/** What `ui.setEditorText(x)` then `ui.getEditorText()` really returns. */
function editorRoundTrip(text: string): string {
  const editor = new Editor(
    { requestRender: () => {}, terminal: { rows: 24, columns: 80 } } as never,
    { borderColor: (s: string) => s } as never,
  );
  editor.setText(text);
  return editor.getExpandedText?.() ?? editor.getText();
}

/**
 * The shapes a rewrite arrives in. The last two are the reported defect: a tab
 * survives our `setEditorText` call as four spaces, so the string we stored was
 * never the string the editor held, and every read-back looked hand-edited.
 */
const REWRITE_SHAPES: ReadonlyArray<{ name: string; text: string }> = [
  { name: "plain", text: "Fix the typo in README.md." },
  { name: "multi-line", text: "Fix the typo in README.md.\nThen run the tests." },
  { name: "trailing spaces", text: "Fix the typo in README.md.   \nRun the tests.  " },
  { name: "blank lines", text: "Fix the typo.\n\n\nThen run the tests." },
  { name: "unicode punctuation", text: "Rename the flag — it’s “wrong” in the docs." },
  { name: "long soft-wrapped line", text: `Rewrite ${"the settings screen ".repeat(9)}carefully.` },
  {
    name: "space-indented fenced block",
    text: "Update the snippet:\n\n```ts\n    const a = 1;\n```\n",
  },
  { name: "tab", text: "Fix the typo in\tREADME.md." },
  {
    name: "tab-indented fenced block",
    text: "Update the snippet:\n\n```ts\n\tconst a = 1;\n```\n",
  },
];

describe("the editor's representation of our text", () => {
  /**
   * The pin. If pi ever expands a tab to something other than four spaces, or
   * stops expanding it, this fails by name instead of `toEditorText` quietly
   * disagreeing with the editor again.
   */
  it("expands a tab to exactly four spaces and collapses CRLF and CR to LF", () => {
    expect(editorRoundTrip("a\tb")).toBe("a    b");
    expect(editorRoundTrip("a\r\nb")).toBe("a\nb");
    expect(editorRoundTrip("a\rb")).toBe("a\nb");
  });

  it.each(REWRITE_SHAPES)("normalises $name the same way the editor does", ({ text }) => {
    expect(toEditorText(text)).toBe(editorRoundTrip(text));
  });

  it.each(REWRITE_SHAPES)("recognises $name coming back untouched", ({ text }) => {
    expect(editorHoldsOurText(editorRoundTrip(text), text)).toBe(true);
  });

  it.each([
    { name: "CRLF", text: "Fix the typo.\r\nRun the tests." },
    { name: "CR", text: "Fix the typo.\rRun the tests." },
  ])("recognises $name coming back untouched", ({ text }) => {
    expect(editorHoldsOurText(editorRoundTrip(text), text)).toBe(true);
  });

  it("is provenance, not resemblance: one edited word is not our text", () => {
    const ours = "Fix the typo in\tREADME.md and leave the wording unchanged.";
    const edited = editorRoundTrip(ours).replace("unchanged", "alone");
    expect(editorHoldsOurText(edited, ours)).toBe(false);
  });

  it("has nothing to hold when we have written nothing", () => {
    expect(editorHoldsOurText("anything at all", undefined)).toBe(false);
  });

  /**
   * The editor slot is replaceable. `ui.setEditorComponent` swaps pi-tui's
   * `Editor` for whatever another extension installs, and nothing reports which
   * component is in it, so normalisation cannot be assumed either way. A
   * component that stores text verbatim hands the tab back as a tab; treating
   * that as a hand edit would make every tabbed rewrite unrepeatable and every
   * revert warn about edits nobody made.
   */
  it.each(REWRITE_SHAPES)("recognises $name from an editor that stores verbatim", ({ text }) => {
    expect(editorHoldsOurText(text, text)).toBe(true);
  });

  it("is still provenance against a verbatim editor: one edited word is not ours", () => {
    const ours = "Fix the typo in\tREADME.md and leave the wording unchanged.";
    expect(editorHoldsOurText(ours.replace("unchanged", "alone"), ours)).toBe(false);
  });
});

// ── Revert, end to end through the real runEnhancer ────────────────────
//
// Success needs a model that answers, and the project does not mock the LLM.
// `registerFauxProvider` is pi-ai's own in-process provider: it registers a
// real api implementation into the real api registry, so `complete()` dispatches
// through the same path a network provider would and the extension is unaware
// anything is unusual. Injected, not mocked — the scripted text is the only
// thing supplied.

describe("revert", () => {
  const TYPED = "fix the tpyo in the readme";
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeAll(() => {
    faux = registerFauxProvider({ api: "faux-prompt-enhancer", provider: "faux-enhancer" });
  });

  afterAll(() => {
    faux.unregister();
  });

  async function armed(): Promise<{
    harness: ReturnType<typeof createHarness>;
    ctx: ExtensionContext;
    log: HostLog;
    typeIntoEditor: (text: string) => void;
  }> {
    const harness = createHarness();
    const host = createHost({ draft: TYPED, model: faux.getModel() });
    await harness.events.get("session_start")?.({}, host.ctx);
    return { harness, ...host };
  }

  const enhance = (h: { harness: ReturnType<typeof createHarness>; ctx: ExtensionContext }) =>
    h.harness.commands.get("prompt_enhance")?.("", h.ctx);

  const revert = (h: { harness: ReturnType<typeof createHarness>; ctx: ExtensionContext }) =>
    h.harness.commands.get("prompt_enhance_revert")?.("", h.ctx);

  const shutdown = (h: { harness: ReturnType<typeof createHarness>; ctx: ExtensionContext }) =>
    h.harness.events.get("session_shutdown")?.({}, h.ctx);

  it("restores the typed original after a single enhance", async () => {
    const host = await armed();
    faux.setResponses([fauxAssistantMessage("Fix the typo in README.md.")]);

    await enhance(host);
    expect(host.ctx.ui.getEditorText()).toBe("Fix the typo in README.md.");

    await revert(host);
    expect(host.ctx.ui.getEditorText()).toBe(TYPED);
    await shutdown(host);
  });

  /**
   * The reported defect, pinned.
   *
   * `lastOriginalPrompt` used to be assigned on every success, so the second
   * enhance stored rewrite #1 as "the original". Ctrl+Shift+Z then put rewrite
   * #1 back while the widget said "Reverted to your original prompt." — the
   * false status being the sharper half: the user is told they have their draft
   * when they are holding a machine rewrite of it.
   */
  it("restores the typed original, not the first rewrite, after enhancing twice", async () => {
    const host = await armed();
    faux.setResponses([
      fauxAssistantMessage("REWRITE ONE: fix the typo in README.md."),
      fauxAssistantMessage("REWRITE TWO: correct the misspelling in README.md."),
    ]);

    await enhance(host);
    expect(host.ctx.ui.getEditorText()).toBe("REWRITE ONE: fix the typo in README.md.");
    await enhance(host);
    expect(host.ctx.ui.getEditorText()).toBe("REWRITE TWO: correct the misspelling in README.md.");

    await revert(host);
    expect(host.ctx.ui.getEditorText()).toBe(TYPED);
    expect(host.ctx.ui.getEditorText()).not.toContain("REWRITE");
    await shutdown(host);
  });

  it("does not drift after a third enhance either", async () => {
    const host = await armed();
    faux.setResponses([
      fauxAssistantMessage("ONE"),
      fauxAssistantMessage("TWO"),
      fauxAssistantMessage("THREE"),
    ]);

    await enhance(host);
    await enhance(host);
    await enhance(host);
    expect(host.ctx.ui.getEditorText()).toBe("THREE");

    await revert(host);
    expect(host.ctx.ui.getEditorText()).toBe(TYPED);
    await shutdown(host);
  });

  it("says it reverted only when it really did put the typed text back", async () => {
    const host = await armed();
    faux.setResponses([fauxAssistantMessage("ONE"), fauxAssistantMessage("TWO")]);

    await enhance(host);
    await enhance(host);
    await revert(host);

    // The claim and the editor are checked together: the status is only honest
    // if the editor holds what it says it restored.
    expect(lastWidgetLine(host.log)).toContain("Reverted to your original prompt.");
    expect(host.ctx.ui.getEditorText()).toBe(TYPED);
    await shutdown(host);
  });

  /**
   * The same claim, for a rewrite the editor does not store verbatim.
   *
   * Nobody touched the editor between the two enhances, so the strong sentence
   * is the true one. Before the comparison was made in the editor's own
   * representation, the tab in this rewrite came back as four spaces, the
   * enhancer concluded someone had typed over it, and the user was warned that
   * edits they never made had been lost.
   */
  it("does not accuse the user of editing a rewrite that merely contains a tab", async () => {
    const host = await armed();
    faux.setResponses([
      fauxAssistantMessage("Fix the typo in README.md:\n\n```ts\n\tconst a = 1;\n```"),
      fauxAssistantMessage("SECOND REWRITE"),
    ]);

    await enhance(host);
    await enhance(host);
    await revert(host);

    expect(lastWidgetLine(host.log)).toContain("Reverted to your original prompt.");
    expect(lastWidgetLine(host.log)).not.toContain("later edits lost");
    expect(host.ctx.ui.getEditorText()).toBe(TYPED);
    await shutdown(host);
  });

  /**
   * An edit that has been enhanced is the thing revert comes back to.
   *
   * Enhancing the user's edit and then reverting past it to a draft they had
   * already moved on from put text in the editor that was two steps behind what
   * they last said. The edit replaced the draft it was made from: what the
   * model was given is what Ctrl+Shift+Z hands back, always, so the two can
   * never name different strings. The draft before the edit is the editor's own
   * undo, not this extension's.
   */
  it("restores the edit once an edit has been enhanced, not the draft behind it", async () => {
    const host = await armed();
    const rewrite =
      "Fix the misspelling in README.md so the install command matches the published package name, and leave the surrounding wording unchanged.";
    const edited = rewrite.replace("wording unchanged", "wording alone");
    faux.setResponses([
      fauxAssistantMessage(rewrite),
      fauxAssistantMessage("Correct the misspelled package name in README.md's install command."),
    ]);

    await enhance(host);
    expect(host.ctx.ui.getEditorText()).toBe(rewrite);

    // The user tightens our rewrite by hand — still our rewrite, with an edit.
    host.typeIntoEditor(edited);
    await enhance(host);
    expect(host.ctx.ui.getEditorText()).toBe(
      "Correct the misspelled package name in README.md's install command.",
    );

    await revert(host);
    expect(host.ctx.ui.getEditorText()).toBe(edited);
    // Nothing was typed after that enhance, so nothing was lost by restoring it.
    expect(lastWidgetLine(host.log)).toContain("Reverted to your original prompt.");
    expect(lastWidgetLine(host.log)).not.toContain("later edits lost");
    await shutdown(host);
  });

  /**
   * The revert that never enhanced again — pre-existing, and invisible while
   * the warning was a flag only an enhance could set.
   *
   * Enhance, hand-edit the rewrite, press Ctrl+Shift+Z. The edit was never
   * given to the model, so nothing in this extension recorded it; the status
   * said "Reverted to your original prompt." and the user's edit was gone
   * without a word. The editor is asked at revert time instead, so the sentence
   * warns.
   */
  it("warns when the revert overwrites an edit that was never enhanced", async () => {
    const host = await armed();
    faux.setResponses([fauxAssistantMessage("Fix the typo in README.md.")]);

    await enhance(host);
    host.typeIntoEditor("Fix the typo in README.md, and nothing else.");

    await revert(host);
    expect(host.ctx.ui.getEditorText()).toBe(TYPED);
    const status = lastWidgetLine(host.log);
    expect(status).toContain("Reverted to your original prompt");
    expect(status).toContain("later edits lost");
    await shutdown(host);
  });

  /** The same press over a rewrite nobody touched still gets the clean sentence. */
  it("does not warn when the revert overwrites only our own untouched rewrite", async () => {
    const host = await armed();
    faux.setResponses([fauxAssistantMessage("Fix the typo in\tREADME.md.")]);

    await enhance(host);
    await revert(host);

    expect(host.ctx.ui.getEditorText()).toBe(TYPED);
    expect(lastWidgetLine(host.log)).toContain("Reverted to your original prompt.");
    expect(lastWidgetLine(host.log)).not.toContain("later edits lost");
    await shutdown(host);
  });

  /**
   * The edit that broke the similarity rule: most of the rewrite deleted.
   *
   * A user who finds the rewrite too verbose cuts it down and enhances again.
   * Word-token overlap read that as a fresh draft — 82 characters removed from a
   * short rewrite falls below any threshold — and revert handed back a line that
   * was half machine text under the status "Reverted to your original prompt."
   *
   * There is no threshold now, so the trim is treated the same as any other
   * edit: it was enhanced, so it is what comes back, whole and exactly as the
   * user left it. Never a partial rewrite, which is the failure that mattered.
   */
  it("restores the trimmed line the user enhanced, not a half-machine one", async () => {
    const host = await armed();
    const rewrite =
      "Fix the widget colour and the spacing on the settings screen without breaking the snapshot tests.";
    const trimmed = "Fix the widget padding.";
    faux.setResponses([fauxAssistantMessage(rewrite), fauxAssistantMessage("SECOND REWRITE")]);

    await enhance(host);
    host.typeIntoEditor(trimmed);
    await enhance(host);

    await revert(host);
    expect(host.ctx.ui.getEditorText()).toBe(trimmed);
    expect(host.ctx.ui.getEditorText()).not.toContain("snapshot tests");
    await shutdown(host);
  });

  /**
   * The accepted cost, now paid off rather than hedged.
   *
   * Clearing the editor and typing a different task used to leave the chain
   * pointing at the older draft, so revert handed back a task the user had
   * abandoned and the status line could only warn about it. Nothing in pi's
   * extension API distinguishes a retype from a hand-edit — no editor-change
   * event, no observation between our own writes — and it no longer has to:
   * both are the user writing, both are enhanced, and both become what revert
   * restores. The sentence has nothing left to hedge about.
   */
  it("restores the retyped draft rather than warning about an abandoned one", async () => {
    const host = await armed();
    const retyped = "Fix the chip spacing issue.";
    faux.setResponses([
      fauxAssistantMessage("Fix the chip colour issue."),
      fauxAssistantMessage("Correct the spacing of the chip component."),
    ]);

    await enhance(host);
    host.typeIntoEditor(retyped);
    await enhance(host);
    expect(host.ctx.ui.getEditorText()).toBe("Correct the spacing of the chip component.");

    await revert(host);
    expect(host.ctx.ui.getEditorText()).toBe(retyped);
    const status = lastWidgetLine(host.log);
    expect(status).toContain("Reverted to your original prompt.");
    expect(status).not.toContain("later edits lost");
    await shutdown(host);
  });

  /** The same sequence, entered through auto-enhance rather than the command. */
  it("re-seats the chain on a hand-edit on the auto-enhance path too", async () => {
    const host = await armed();
    const rewrite =
      "Fix the misspelling in README.md so the install command matches the published package name, and leave the surrounding wording unchanged.";
    faux.setResponses([fauxAssistantMessage(rewrite), fauxAssistantMessage("SECOND REWRITE")]);

    await host.harness.commands.get("prompt_enhance_auto")?.("", host.ctx);
    // Enter: pi empties the editor before it fires the input event.
    host.typeIntoEditor("");
    await host.harness.events.get("input")?.(
      { source: "interactive", text: TYPED, images: [] },
      host.ctx,
    );
    expect(host.ctx.ui.getEditorText()).toBe(rewrite);

    const edited = rewrite.replace("wording unchanged", "wording alone");
    host.typeIntoEditor(edited);
    await enhance(host);
    expect(host.ctx.ui.getEditorText()).toBe("SECOND REWRITE");

    await revert(host);
    expect(host.ctx.ui.getEditorText()).toBe(edited);
    await shutdown(host);
  });

  /**
   * A command argument is text the user typed, and that is knowable rather than
   * inferred: this extension never writes a slash-command argument. So it opens
   * a new chain even mid-chain, and revert points at it.
   */
  it("starts a new chain when the text arrives as a command argument", async () => {
    const host = await armed();
    faux.setResponses([fauxAssistantMessage("ONE"), fauxAssistantMessage("TWO")]);

    await enhance(host);
    await host.harness.commands.get("prompt_enhance")?.("add a changelog entry for 3.0", host.ctx);
    expect(host.ctx.ui.getEditorText()).toBe("TWO");

    await revert(host);
    expect(host.ctx.ui.getEditorText()).toBe("add a changelog entry for 3.0");
    expect(lastWidgetLine(host.log)).toContain("Reverted to your original prompt.");
    await shutdown(host);
  });

  it("has nothing to revert once it has reverted, and says so", async () => {
    const host = await armed();
    faux.setResponses([fauxAssistantMessage("ONE")]);

    await enhance(host);
    await revert(host);
    expect(host.ctx.ui.getEditorText()).toBe(TYPED);

    await revert(host);
    // Not "reverted to your original prompt" a second time: the editor was not
    // touched, and the status says exactly that.
    expect(lastWidgetLine(host.log)).toContain("Nothing to revert.");
    expect(host.ctx.ui.getEditorText()).toBe(TYPED);
    await shutdown(host);
  });

  it("forgets the original once the user sends a prompt", async () => {
    const host = await armed();
    faux.setResponses([fauxAssistantMessage("ONE"), fauxAssistantMessage("TWO")]);

    await enhance(host);
    // Enter on a non-command prompt: the previous original stops being relevant.
    await host.harness.events.get("input")?.(
      { source: "interactive", text: "ONE", images: [] },
      host.ctx,
    );

    await revert(host);
    expect(lastWidgetLine(host.log)).toContain("Nothing to revert.");
    expect(host.ctx.ui.getEditorText()).toBe("ONE");
    await shutdown(host);
  });
});

// ── Repeat enhance, end to end through the real runEnhancer ─────────────
//
// What reaches the model is the whole question here, so these tests read the
// prompt out of the request the faux provider actually receives rather than
// inferring it from what came back.

describe("repeat enhance", () => {
  const TYPED = "fix the tpyo in the readme";
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeAll(() => {
    faux = registerFauxProvider({ api: "faux-reroll", provider: "faux-reroll" });
  });

  afterAll(() => {
    faux.unregister();
  });

  /** The text under the user message's "## Original prompt" heading. */
  function originalPromptOf(context: { messages: readonly unknown[] }): string {
    const message = context.messages.at(-1) as { content?: unknown };
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : (content as { type: string; text?: string }[])
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join("");
    const heading = "## Original prompt\n";
    return text.slice(text.indexOf(heading) + heading.length);
  }

  /** Script the replies, recording the prompt each call was given. */
  function script(replies: readonly string[]): string[] {
    const seen: string[] = [];
    faux.setResponses(
      replies.map((reply) => (context: { messages: readonly unknown[] }) => {
        seen.push(originalPromptOf(context));
        return fauxAssistantMessage(reply);
      }),
    );
    return seen;
  }

  async function armed(): Promise<{
    harness: ReturnType<typeof createHarness>;
    ctx: ExtensionContext;
    log: HostLog;
    typeIntoEditor: (text: string) => void;
  }> {
    const harness = createHarness();
    const host = createHost({ draft: TYPED, model: faux.getModel() });
    await harness.events.get("session_start")?.({}, host.ctx);
    return { harness, ...host };
  }

  const enhance = (
    h: { harness: ReturnType<typeof createHarness>; ctx: ExtensionContext },
    args = "",
  ) => h.harness.commands.get("prompt_enhance")?.(args, h.ctx);

  const revert = (h: { harness: ReturnType<typeof createHarness>; ctx: ExtensionContext }) =>
    h.harness.commands.get("prompt_enhance_revert")?.("", h.ctx);

  const shutdown = (h: { harness: ReturnType<typeof createHarness>; ctx: ExtensionContext }) =>
    h.harness.events.get("session_shutdown")?.({}, h.ctx);

  /**
   * The reported defect: pressing Ctrl+Shift+E twice used to hand rewrite #1
   * back to the model, so each press drifted further from the request instead
   * of offering another approach to it.
   */
  it("re-rolls the stored original instead of rewriting its own rewrite", async () => {
    const host = await armed();
    const seen = script(["REWRITE ONE", "REWRITE TWO"]);

    await enhance(host);
    await enhance(host);

    expect(seen).toEqual([TYPED, TYPED]);
    expect(host.ctx.ui.getEditorText()).toBe("REWRITE TWO");

    await revert(host);
    expect(host.ctx.ui.getEditorText()).toBe(TYPED);
    await shutdown(host);
  });

  it("keeps re-rolling the original on a third press", async () => {
    const host = await armed();
    const seen = script(["ONE", "TWO", "THREE"]);

    await enhance(host);
    await enhance(host);
    await enhance(host);

    expect(seen).toEqual([TYPED, TYPED, TYPED]);
    await revert(host);
    expect(host.ctx.ui.getEditorText()).toBe(TYPED);
    await shutdown(host);
  });

  /**
   * The exception, and the reason the comparison has to be exact: an edit is
   * the user saying something, so it is what gets enhanced.
   */
  it("enhances the edited text when the user changed the rewrite", async () => {
    const host = await armed();
    const seen = script(["Fix the misspelling in README.md.", "SECOND REWRITE"]);

    await enhance(host);
    const edited = "Fix the misspelling in README.md, and leave the wording alone.";
    host.typeIntoEditor(edited);
    await enhance(host);

    expect(seen).toEqual([TYPED, edited]);

    // The edit is now the chain's original, so it is what revert reaches.
    await revert(host);
    expect(host.ctx.ui.getEditorText()).toBe(edited);
    await shutdown(host);
  });

  /**
   * The reported defect: an edit honoured once, then silently dropped.
   *
   * Type, enhance, edit the rewrite, enhance — the edit went to the model, as
   * it should. Press enhance once more and the *first* draft went instead,
   * under a footer reading "Re-enhanced your original prompt.", because the
   * stored original had never moved off the text typed before the first press.
   * Whatever the user last wrote is what "again" means, so the edit is what the
   * third press re-rolls.
   */
  it("re-rolls the edit, not the draft it replaced, on the press after an edit", async () => {
    const host = await armed();
    const seen = script(["REWRITE ONE", "REWRITE TWO", "REWRITE THREE"]);

    await enhance(host);
    const edited = "RW-ONE PLUS MY EDIT";
    host.typeIntoEditor(edited);
    await enhance(host);
    await enhance(host);

    expect(seen).toEqual([TYPED, edited, edited]);
    expect(seen.at(-1)).not.toBe(TYPED);
    await shutdown(host);
  });

  /**
   * And the press after *that* edit re-rolls the newer one.
   *
   * The edits are three tokens rather than two so that they are drafts the
   * enhancer will take on at all — a two-word edit is refused as too short
   * before any of this chain logic is reached.
   */
  it("moves again when the user edits a second time mid-chain", async () => {
    const host = await armed();
    const seen = script(["ONE", "TWO", "THREE", "FOUR"]);
    const first = "MY FIRST EDIT";
    const second = "MY SECOND EDIT";

    await enhance(host);
    host.typeIntoEditor(first);
    await enhance(host);
    host.typeIntoEditor(second);
    await enhance(host);
    await enhance(host);

    expect(seen).toEqual([TYPED, first, second, second]);
    await revert(host);
    expect(host.ctx.ui.getEditorText()).toBe(second);
    await shutdown(host);
  });

  /**
   * The footer, pinned to the request rather than to the flag behind it.
   *
   * The status and the prompt were both derived from the same variable but
   * never checked against each other, so reverting the prompt selection alone
   * left "Re-enhanced your original prompt." announcing a re-roll that had not
   * happened, and the suite stayed green. Here the two are compared: the
   * sentence may only appear on a press that sent the model the same string as
   * the press before it, and whatever is sent must be the user's own words.
   */
  it("only claims a re-roll on a press that really re-sent the same prompt", async () => {
    const host = await armed();
    const seen = script(["ONE", "TWO", "THREE", "FOUR", "FIVE"]);
    const statuses: string[] = [];
    const press = async (): Promise<void> => {
      await enhance(host);
      statuses.push(lastWidgetLine(host.log));
    };

    const edited = "Fix the misspelling in README.md, and leave the wording alone.";
    await press();
    await press();
    await press();
    host.typeIntoEditor(edited);
    await press();
    await press();

    // What the user had written, at each press.
    const wrote = [TYPED, TYPED, TYPED, edited, edited];
    expect(seen).toEqual(wrote);

    for (const [i, sent] of seen.entries()) {
      const claimsReroll = (statuses[i] ?? "").includes("Re-enhanced your original prompt");
      expect(claimsReroll).toBe(i > 0 && sent === seen[i - 1]);
      expect(sent).toBe(wrote[i]);
    }
    await shutdown(host);
  });

  /**
   * Change 1 and Change 2 in one case. A tab in the rewrite comes back as four
   * spaces; if the comparison did not account for that, the enhancer would read
   * its own untouched output as a hand edit and rewrite the rewrite.
   */
  it("still re-rolls when the rewrite contains a tab the editor expanded", async () => {
    const host = await armed();
    const seen = script(["Fix the typo:\n\n```ts\n\tconst a = 1;\n```", "SECOND REWRITE"]);

    await enhance(host);
    await enhance(host);

    expect(seen).toEqual([TYPED, TYPED]);
    await shutdown(host);
  });

  it("enhances a command argument rather than re-rolling", async () => {
    const host = await armed();
    const seen = script(["REWRITE ONE", "REWRITE TWO"]);

    await enhance(host);
    // An argument is something the user typed, so it opens a fresh chain.
    await enhance(host, "add a changelog entry for 3.0");

    expect(seen).toEqual([TYPED, "add a changelog entry for 3.0"]);
    await revert(host);
    expect(host.ctx.ui.getEditorText()).toBe("add a changelog entry for 3.0");
    await shutdown(host);
  });

  it("says which prompt it re-enhanced, so a similar rewrite is not mistaken for a no-op", async () => {
    const host = await armed();
    script(["REWRITE ONE", "REWRITE ONE"]);

    await enhance(host);
    expect(lastWidgetLine(host.log)).toContain("Prompt enhanced");

    await enhance(host);
    expect(lastWidgetLine(host.log)).toContain("Re-enhanced your original prompt");
    await shutdown(host);
  });
});

describe("enhancedStatusText", () => {
  it("names the revert shortcut when Enter still sends", () => {
    expect(enhancedStatusText({ rerolled: false, autoEnhance: false })).toBe(
      "Prompt enhanced — Ctrl+Shift+Z to revert.",
    );
  });

  it("points at Enter when auto-enhance armed this rewrite", () => {
    expect(enhancedStatusText({ rerolled: false, autoEnhance: true })).toBe(
      "Prompt enhanced — Enter to send.",
    );
  });

  it("names the original as the input on a re-roll", () => {
    expect(enhancedStatusText({ rerolled: true, autoEnhance: false })).toBe(
      "Re-enhanced your original prompt — Ctrl+Shift+Z to revert.",
    );
    expect(enhancedStatusText({ rerolled: true, autoEnhance: true })).toBe(
      "Re-enhanced your original prompt — Enter to send.",
    );
  });
});
