/**
 * @jmcombs/pi-prompt-enhancer — Codebase-aware prompt enhancer for Pi.
 *
 * Registers:
 *   - /prompt_enhance [text]  — rewrite the editor (or supplied text) using live
 *                          codebase context and load the result into the editor.
 *   - /prompt_enhance_model   — pick the Prompt Enhancer model for this session.
 *   - /prompt_enhance_revert  — restore the editor to the pre-enhance text.
 *   - /prompt_enhance_auto    — toggle auto-enhance on Enter (off by default).
 *   - Ctrl+Shift+E / Ctrl+Shift+Z — enhance / revert shortcuts.
 *
 * Design constraints (from the project plan):
 *   - No external npm deps. Pi-runtime + Node built-ins only.
 *   - Nothing is submitted automatically; the enhanced prompt always lands in
 *     the editor for the user to review.
 *   - Esc cancels at any point, restoring the original prompt.
 *   - Context gathering and the LLM call run in parallel where possible,
 *     inside a BorderedLoader.
 */

import { execFile } from "node:child_process";
import { type Dirent, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

// Pi's extension loader aliases the bare "@earendil-works/pi-ai" specifier to
// pi-ai's compat entry, which re-exports the package index plus `complete`.
// Importing the compat subpath directly is the same module at runtime, but it
// is the only specifier whose *types* match what Pi actually injects — the
// package index does not export `complete`.
import { type Api, complete, type Message, type Model } from "@earendil-works/pi-ai/compat";
import {
  BorderedLoader,
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { shouldSkipAutoEnhance } from "./auto.js";
import { formatStatusWidget } from "./widget.js";

export { shouldSkipAutoEnhance } from "./auto.js";

// `execFile` (not `exec`) avoids passing args through a shell, so we don't
// need to escape user-derived `cwd` paths.
const execFileAsync = promisify(execFile);

// ── Constants ──────────────────────────────────────────────────────────

const TREE_MAX_DEPTH = 3;
const TREE_MAX_ENTRIES = 100;
const TREE_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".cache",
  ".turbo",
  ".vercel",
  ".idea",
  ".vscode",
  "target", // Rust / Java
]);

const GIT_TIMEOUT_MS = 3000;
const GIT_LOG_LIMIT = 8;

const FILE_MAX_LINES = 100;
const FILE_MAX_REFERENCES = 3;

export const SYSTEM_PROMPT = `You are a prompt rewriter for a coding agent. You do not answer the user's request. You do not solve, implement, or explain it. You rewrite their rough prompt into a better prompt for a *different* coding agent to execute later.

No tools are attached and nothing you say retrieves anything: your entire output is consumed as text, and the user message holds all the context you will ever get. Never announce what you would inspect or do.

Rules:
- Preserve intent exactly. Invent nothing: no new requirements, and no path that is not in the context, which is partial and may be truncated.
- Conversation background is there only to resolve what the prompt refers to. Never answer or continue it.
- If the prompt is not about the codebase, rewrite it anyway: return it as it is, clarified only if ambiguous. Never refuse, never explain yourself, never address the user.
- If the original is already precise, change little. Match its tone; no second person unless it used one.
- If you catch yourself answering, writing code, or listing steps, stop and output the rewritten *request* instead.

Output only the rewritten prompt as plain text: no preamble, no commentary, no markdown headings, no quoting of the original.`;

// Status keys for ctx.ui.setStatus footer chips. Distinct keys so we can
// independently set/clear them. Enhance is not advertised as an always-on
// chip — /hotkeys and Ctrl+Shift+E are the catalog. Revert is contextual.
const STATUS_KEY_REVERT_HINT = "pe-revert";

function revertHintText(): string {
  return autoEnhanceEnabled
    ? "Enter to send · Ctrl+Shift+Z to revert"
    : "Ctrl+Shift+Z to revert enhanced prompt";
}

// Widget rendered above the editor with persistent enhancer state.
const WIDGET_KEY = "prompt-enhancer";
const TRANSIENT_STATUS_MS = 4000;

// Pattern 1 chrome around SelectList: top border, title, search Input, help,
// bottom border, plus the (n/total) scrollInfo line when the list overflows.
const PICKER_CHROME_LINES = 6;
const PICKER_MIN_VISIBLE = 3;
const PICKER_TITLE = "Pick Prompt Enhancer model";
const PICKER_HELP = "↑↓ navigate • type to filter • enter select • esc cancel";
const PICKER_NO_MATCH = "  No matching models";

// ── Session-scoped state ────────────────────────────────────────────────

let enhancerModelOverride: Model<Api> | undefined;

/**
 * The text that was in the editor (or supplied as args) immediately before
 * the most recent successful /prompt_enhance. /prompt_enhance_revert restores this and
 * clears the slot. Cleared also when the user submits a non-command prompt
 * (input event), since at that point the previous "original" is no longer
 * relevant.
 */
let lastOriginalPrompt: string | undefined;

/** Session-scoped. Off by default. Enter enhances, Enter again sends. */
let autoEnhanceEnabled = false;

/**
 * Latest known interactive ExtensionContext. Captured on session_start (and
 * other events with a fresh ctx) so that deferred work — specifically the
 * auto-clearing transient widget status — can update the UI without holding
 * a stale ctx from a previous handler invocation.
 */
let activeCtx: ExtensionContext | undefined;

/** Active auto-clear timer for the transient widget status line. */
let transientStatusTimer: ReturnType<typeof setTimeout> | undefined;

// ── Public types ────────────────────────────────────────────────────────

/**
 * Context bundle captured for an enhancement run. Exported so consumers can
 * inspect what the enhancer would send to the model (useful for tests and
 * downstream extensions that wrap this one).
 */
export interface EnhancerContext {
  cwd: string;
  tree?: string;
  git?: string;
  mentionedFiles: { path: string; content: string }[];
}

// ── Helpers: directory tree ─────────────────────────────────────────────

interface TreeEntry {
  relPath: string;
  isDir: boolean;
  depth: number;
}

async function buildProjectTree(cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const entries: TreeEntry[] = [];
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (signal.aborted) return;
    if (depth > TREE_MAX_DEPTH) return;
    if (entries.length >= TREE_MAX_ENTRIES) {
      truncated = true;
      return;
    }
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const dirent of dirents) {
      // `signal.aborted` was checked at the top of walk(), but it can flip to
      // true while we were awaiting fs.readdir above, so this re-check is real,
      // not redundant.
      if (signal.aborted) return;
      if (entries.length >= TREE_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      if (dirent.name.startsWith(".") && dirent.name !== ".github") continue;
      if (TREE_SKIP_DIRS.has(dirent.name)) continue;
      const full = path.join(dir, dirent.name);
      const rel = path.relative(cwd, full);
      entries.push({ relPath: rel, isDir: dirent.isDirectory(), depth });
      if (dirent.isDirectory()) {
        await walk(full, depth + 1);
      }
    }
  }

  await walk(cwd, 1);
  if (entries.length === 0) return undefined;

  const lines = entries.map((e) => `${"  ".repeat(e.depth - 1)}${e.relPath}${e.isDir ? "/" : ""}`);
  // `truncated` is initialized to false but set inside recursive walk() calls,
  // so it may be true by the time we reach here.
  if (truncated) lines.push(`  … (truncated at ${String(TREE_MAX_ENTRIES)} entries)`);
  return lines.join("\n");
}

// ── Helpers: git context ────────────────────────────────────────────────

async function runGit(
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      signal,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

async function buildGitContext(cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const [branch, status, log] = await Promise.all([
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd, signal),
    runGit(["status", "--short"], cwd, signal),
    runGit(["log", "--oneline", `-${String(GIT_LOG_LIMIT)}`], cwd, signal),
  ]);

  if (branch === undefined && status === undefined && log === undefined) return undefined;

  const parts: string[] = [];
  if (branch) parts.push(`branch: ${branch}`);
  if (status === undefined) {
    /* git status failed; skip */
  } else if (status === "") {
    parts.push("status: clean");
  } else {
    parts.push(`status:\n${status}`);
  }
  if (log) parts.push(`recent commits:\n${log}`);
  return parts.join("\n\n");
}

// ── Helpers: mentioned files ────────────────────────────────────────────

/**
 * Heuristically extracts file-path-like tokens from a prompt. Matches anything
 * that contains a slash or has a typical source-file extension. Conservative
 * by design — false negatives are fine, false positives waste tokens.
 */
function extractFileMentions(prompt: string): string[] {
  // Tokens with at least one path separator OR a recognizable file extension.
  // Trimmed of common surrounding punctuation.
  const tokenRe = /[A-Za-z0-9_./@-]+/g;
  const extRe =
    /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml|toml|css|scss|html|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|sh|bash|sql|prisma|tf|dockerfile)$/i;
  const matches = prompt.match(tokenRe) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/^[.,;:!?'"`(){}[\]]+|[.,;:!?'"`(){}[\]]+$/g, "");
    if (!cleaned) continue;
    if (cleaned.length > 256) continue;
    if (!cleaned.includes("/") && !extRe.test(cleaned)) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

async function readMentionedFile(
  candidate: string,
  cwd: string,
): Promise<{ path: string; content: string } | undefined> {
  // Resolve, then ensure the resolved path stays within cwd to avoid the
  // extension reading arbitrary files via "../../etc/passwd"-style paths.
  const resolved = path.resolve(cwd, candidate);
  const rel = path.relative(cwd, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;

  let stat: Stats;
  try {
    stat = await fs.stat(resolved);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  if (stat.size > 1_000_000) return undefined;

  let raw: string;
  try {
    raw = await fs.readFile(resolved, "utf-8");
  } catch {
    return undefined;
  }
  const lines = raw.split("\n");
  const truncated = lines.length > FILE_MAX_LINES;
  const body = lines.slice(0, FILE_MAX_LINES).join("\n");
  const content = truncated
    ? `${body}\n… (truncated at ${String(FILE_MAX_LINES)} lines, file has ${String(lines.length)} total)`
    : body;
  return { path: rel, content };
}

async function buildMentionedFiles(
  prompt: string,
  cwd: string,
): Promise<{ path: string; content: string }[]> {
  const candidates = extractFileMentions(prompt).slice(0, FILE_MAX_REFERENCES * 4);
  const results: { path: string; content: string }[] = [];
  for (const candidate of candidates) {
    if (results.length >= FILE_MAX_REFERENCES) break;
    const file = await readMentionedFile(candidate, cwd);
    if (file) results.push(file);
  }
  return results;
}

// ── Context assembly ────────────────────────────────────────────────────

export async function gatherEnhancerContext(
  prompt: string,
  cwd: string,
  signal: AbortSignal,
): Promise<EnhancerContext> {
  const [tree, git, mentionedFiles] = await Promise.all([
    buildProjectTree(cwd, signal),
    buildGitContext(cwd, signal),
    buildMentionedFiles(prompt, cwd),
  ]);
  return { cwd, tree, git, mentionedFiles };
}

export function buildEnhancerUserMessage(originalPrompt: string, context: EnhancerContext): string {
  const sections: string[] = [];
  sections.push(
    "## Task\nRewrite the original prompt so a coding agent can execute it later. Do not answer, solve, implement, or explain the original request. Output only the rewritten prompt.",
  );
  sections.push(`## Working directory\n${context.cwd}`);
  if (context.tree)
    sections.push(`## Project tree (depth ${String(TREE_MAX_DEPTH)})\n${context.tree}`);
  if (context.git) sections.push(`## Git\n${context.git}`);
  if (context.mentionedFiles.length > 0) {
    const blocks = context.mentionedFiles.map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
    sections.push(`## Files referenced in the prompt\n\n${blocks.join("\n\n")}`);
  }
  sections.push(`## Original prompt\n${originalPrompt}`);
  return sections.join("\n\n");
}

// ── Model resolution ────────────────────────────────────────────────────

function resolveEnhancerModel(ctx: ExtensionContext): Model<Api> | undefined {
  return enhancerModelOverride ?? ctx.model;
}

function modelLabel(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Visible SelectList rows for a terminal height. Uses 70% of rows minus the
 * Pattern 1 chrome (borders, title, help, optional scrollInfo), clamped so a
 * tiny terminal still shows a few items and a short list is not padded.
 */
export function computePickerMaxVisible(terminalRows: number, itemCount: number): number {
  const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? Math.floor(terminalRows) : 24;
  const budget = Math.floor(rows * 0.7) - PICKER_CHROME_LINES;
  return Math.max(PICKER_MIN_VISIBLE, Math.min(itemCount, budget));
}

/** Same tokenized fuzzy filter `/model` uses (`fuzzyFilter` from pi-tui). */
export function filterPickerItems(items: readonly SelectItem[], query: string): SelectItem[] {
  const q = query.trim();
  if (q.length === 0) return [...items];
  return fuzzyFilter([...items], q, (item) => item.label);
}

export interface EnhancerModelPickerHandle {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
}

/** Official Pattern 1 selector: DynamicBorder + SelectList, editor-replace. */
export function createEnhancerModelSelector(
  tui: { terminal?: { rows?: number }; requestRender: () => void },
  theme: Pick<Theme, "fg" | "bold">,
  items: SelectItem[],
  done: (value: string | undefined) => void,
): EnhancerModelPickerHandle {
  const listTheme = {
    selectedPrefix: (t: string) => theme.fg("accent", t),
    selectedText: (t: string) => theme.fg("accent", t),
    description: (t: string) => theme.fg("muted", t),
    scrollInfo: (t: string) => theme.fg("dim", t),
    noMatch: (t: string) => theme.fg("warning", t),
  };

  const searchInput = new Input();
  searchInput.focused = true;

  const listContainer = new Container();
  let selectList: SelectList | undefined;

  const buildList = (visible: SelectItem[]): void => {
    listContainer.clear();
    if (visible.length === 0) {
      selectList = undefined;
      listContainer.addChild(new Text(theme.fg("warning", PICKER_NO_MATCH), 1, 0));
      return;
    }
    const maxVisible = computePickerMaxVisible(tui.terminal?.rows ?? 24, visible.length);
    const list = new SelectList(visible, maxVisible, listTheme);
    list.onSelect = (item: SelectItem): void => {
      done(item.value);
    };
    list.onCancel = (): void => {
      done(undefined);
    };
    selectList = list;
    listContainer.addChild(list);
  };

  buildList(items);

  const container = new Container();
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  container.addChild(new Text(theme.fg("accent", theme.bold(PICKER_TITLE)), 1, 0));
  container.addChild(searchInput);
  container.addChild(listContainer);
  container.addChild(new Text(theme.fg("dim", PICKER_HELP), 1, 0));
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

  return {
    render: (width: number): string[] => container.render(width),
    invalidate: (): void => {
      container.invalidate();
    },
    handleInput: (data: string): void => {
      const kb = getKeybindings();
      if (
        kb.matches(data, "tui.select.up") ||
        kb.matches(data, "tui.select.down") ||
        kb.matches(data, "tui.select.confirm") ||
        kb.matches(data, "tui.select.cancel")
      ) {
        if (selectList) {
          selectList.handleInput(data);
        } else if (kb.matches(data, "tui.select.cancel")) {
          done(undefined);
        }
      } else {
        searchInput.handleInput(data);
        buildList(filterPickerItems(items, searchInput.getValue()));
      }
      tui.requestRender();
    },
  };
}

// ── Persistent widget ────────────────────────────────────────
//
// One Powerline line above the editor (Steward / Headroom standard):
//   [glyph Prompt Enhancer] [model | no model] [optional status]
//
// Soft messages (cancelled, reverted, nothing-to-enhance) ride the status
// segment so they don't pile up as Pi notifications. Hard errors still go
// through ctx.ui.notify. Pi cannot place widgets left/right of each other —
// only above/below the editor — so this sits in the same stack as Steward.

function renderWidgetLine(ctx: ExtensionContext, transientStatus?: string): string {
  const model = resolveEnhancerModel(ctx);
  return formatStatusWidget({
    model: model ? modelLabel(model) : undefined,
    auto: autoEnhanceEnabled,
    status: transientStatus,
  });
}

function updateWidget(ctx: ExtensionContext, transientStatus?: string): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, [renderWidgetLine(ctx, transientStatus)], {
    placement: "aboveEditor",
  });
}

function clearTransientStatusTimer(): void {
  if (transientStatusTimer !== undefined) {
    clearTimeout(transientStatusTimer);
    transientStatusTimer = undefined;
  }
}

/**
 * Show a status line in the widget that auto-clears after TRANSIENT_STATUS_MS.
 * Used in place of `ctx.ui.notify` for non-error feedback so messages don't
 * stack up in Pi's notification area.
 */
function showTransientStatus(ctx: ExtensionContext, status: string): void {
  if (!ctx.hasUI) return;
  clearTransientStatusTimer();
  updateWidget(ctx, status);
  transientStatusTimer = setTimeout(() => {
    transientStatusTimer = undefined;
    if (activeCtx?.hasUI) updateWidget(activeCtx);
  }, TRANSIENT_STATUS_MS);
}

// ── Main flow ───────────────────────────────────────────────────────────

type EnhancementOutcome =
  | { ok: true; enhanced: string }
  | { ok: false; reason: "cancelled" | "error"; message?: string };

/** The successful half of `ModelRegistry.getApiKeyAndHeaders`'s result. */
type ResolvedEnhancerAuth = Extract<
  Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>,
  { ok: true }
>;

/**
 * The enhancement itself: gather context, call the model, extract the rewrite.
 *
 * Shared by the interactive path (cancellation driven by BorderedLoader's
 * signal) and the headless path (driven by a local AbortController), so the
 * LLM call exists exactly once.
 */
async function performEnhancement(
  params: {
    cwd: string;
    model: Model<Api>;
    auth: ResolvedEnhancerAuth;
    originalPrompt: string;
  },
  signal: AbortSignal,
): Promise<EnhancementOutcome> {
  const { cwd, model, auth, originalPrompt } = params;

  const context = await gatherEnhancerContext(originalPrompt, cwd, signal);
  if (signal.aborted) return { ok: false, reason: "cancelled" };

  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: buildEnhancerUserMessage(originalPrompt, context) }],
    timestamp: Date.now(),
  };

  const response = await complete(
    model,
    { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers, signal },
  );

  if (response.stopReason === "aborted") return { ok: false, reason: "cancelled" };
  if (response.stopReason === "error") {
    return {
      ok: false,
      reason: "error",
      message: response.errorMessage ?? "Unknown LLM error",
    };
  }

  const enhanced = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  if (!enhanced) {
    return { ok: false, reason: "error", message: "Model returned an empty response." };
  }

  return { ok: true, enhanced };
}

async function runEnhancer(ctx: ExtensionContext, providedText: string | undefined): Promise<void> {
  // The enhancer needs an interactive editor (to read/write prompt text). In
  // print mode and JSON mode ctx.hasUI is false and there is no editor to read
  // from or write to, so the flow can't work — fail fast with a clear
  // notification. RPC mode keeps hasUI true but has no custom-component host;
  // that case runs headlessly below.
  if (!ctx.hasUI) {
    ctx.ui.notify(
      "Prompt Enhancer requires interactive mode (it reads and writes the editor).",
      "warning",
    );
    return;
  }

  const editorText = ctx.ui.getEditorText();
  const originalPrompt = (providedText ?? editorText).trim();

  if (!originalPrompt) {
    showTransientStatus(ctx, "Nothing to enhance (editor is empty).");
    return;
  }

  const model = resolveEnhancerModel(ctx);
  if (!model) {
    ctx.ui.notify("Prompt Enhancer: no active model. Pick one with /model first.", "error");
    return;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    ctx.ui.notify(`Prompt Enhancer: ${auth.error}`, "error");
    return;
  }
  if (!auth.apiKey) {
    ctx.ui.notify(`Prompt Enhancer: no API key configured for ${modelLabel(model)}.`, "error");
    return;
  }

  const editorBeforeReplace = editorText;
  // Replace the editor with the original (in case the user typed it via
  // /prompt_enhance "..." rather than into the editor) so a Ctrl+Z after success
  // takes them back to what they typed before invoking the enhancer.
  if (providedText !== undefined) ctx.ui.setEditorText(originalPrompt);

  // Loader owns in-flight UX. Hide the revert chip while we work; restore it
  // below if this run does not produce a new successful enhance.
  ctx.ui.setStatus(STATUS_KEY_REVERT_HINT, undefined);

  // Custom components are terminal-only. pi's own JSDoc on ExtensionContext.mode
  // says to guard them on "tui"; RPC keeps hasUI true but implements custom()
  // as `async custom() { return undefined; }`, which used to crash this flow.
  // Allowlist, not a denylist, so a future mode degrades to headless instead of
  // crashing. `mode` may be absent on a host that ships a subset shim of
  // @earendil-works/pi-coding-agent, hence the typeof check.
  const wantsCustomUI = typeof ctx.mode === "string" ? ctx.mode === "tui" : ctx.hasUI;

  const enhanceParams = {
    cwd: ctx.cwd,
    model,
    auth,
    originalPrompt,
  };
  let result: EnhancementOutcome | undefined;

  if (wantsCustomUI) {
    // Fallback for a host that reports "tui" but never invokes the factory:
    // without this we would consume whatever custom() resolved to.
    //
    // Edge case, unreachable on pi and knowingly left alone: a host that *does*
    // run the factory but still resolves `undefined` (rather than the value
    // passed to `done`) leaves `result` unset, and the headless branch below
    // then re-runs performEnhancement — a second billed LLM call for one
    // /prompt_enhance. Guarding it would mean distinguishing "done() never
    // fired" from "done(undefined)", which the ExtensionUIContext.custom
    // contract gives us no way to do, and pi's TUI mode always resolves with
    // the done() value. Recorded here so a future host quirk is diagnosable.
    let factoryRan = false;
    const customResult = await ctx.ui.custom<EnhancementOutcome>((tui, theme, _kb, done) => {
      factoryRan = true;
      const loader = new BorderedLoader(tui, theme, `Enhancing prompt via ${modelLabel(model)}…`, {
        cancellable: true,
      });
      loader.onAbort = () => {
        done({ ok: false, reason: "cancelled" });
      };

      performEnhancement(enhanceParams, loader.signal)
        .then(done)
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          done({ ok: false, reason: "error", message });
        });

      return loader;
    });
    if (factoryRan) result = customResult;
  }

  if (!result) {
    // Headless: same work, no BorderedLoader. Nothing can cancel it from the
    // UI, so the controller exists only to satisfy performEnhancement.
    const controller = new AbortController();
    try {
      result = await performEnhancement(enhanceParams, controller.signal);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result = { ok: false, reason: "error", message };
    }
  }

  if (result.ok) {
    ctx.ui.setEditorText(result.enhanced);
    lastOriginalPrompt = originalPrompt;
    ctx.ui.setStatus(STATUS_KEY_REVERT_HINT, revertHintText());
    showTransientStatus(
      ctx,
      autoEnhanceEnabled
        ? "Prompt enhanced — Enter to send."
        : "Prompt enhanced — Ctrl+Shift+Z to revert.",
    );
    return;
  }

  // Restore whatever was in the editor before we touched it.
  ctx.ui.setEditorText(editorBeforeReplace);
  if (lastOriginalPrompt !== undefined) {
    ctx.ui.setStatus(STATUS_KEY_REVERT_HINT, revertHintText());
  }
  if (result.reason === "cancelled") {
    showTransientStatus(ctx, "Cancelled.");
  } else {
    // Hard failures stay as notifications — the user needs to see them loud.
    ctx.ui.notify(`Prompt enhancement failed: ${result.message ?? "unknown error"}`, "error");
  }
}

function runRevert(ctx: ExtensionContext): void {
  if (!ctx.hasUI) {
    ctx.ui.notify("Prompt Enhancer revert requires interactive mode.", "warning");
    return;
  }
  if (lastOriginalPrompt === undefined) {
    showTransientStatus(ctx, "Nothing to revert.");
    return;
  }
  const restored = lastOriginalPrompt;
  lastOriginalPrompt = undefined;
  ctx.ui.setEditorText(restored);
  ctx.ui.setStatus(STATUS_KEY_REVERT_HINT, undefined);
  showTransientStatus(ctx, "Reverted to your original prompt.");
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** True when the latest assistant turn asked a question — no vocabulary. */
export function lastAssistantAskedQuestion(ctx: ExtensionContext): boolean {
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as {
        role?: string;
        content?: unknown;
        message?: { role?: string; content?: unknown };
      };
      const msg = entry.message ?? entry;
      if (msg.role !== "assistant") continue;
      const text = extractMessageText(msg.content).trim();
      if (text.length === 0) return false;
      const tail = text.slice(-400);
      return /\?\s*$/.test(text) || /\?\s*\n/.test(tail);
    }
  } catch {
    return false;
  }
  return false;
}

// ── Extension factory ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // session_start paints the persistent widget and clears any stale revert
  // chip from a previous session. Enhance is not advertised as a footer chip.
  pi.on("session_start", (_event, ctx) => {
    activeCtx = ctx;
    lastOriginalPrompt = undefined;
    autoEnhanceEnabled = false;
    clearTransientStatusTimer();
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY_REVERT_HINT, undefined);
    updateWidget(ctx);
  });

  // Clear the pending auto-clear timer on session shutdown so it doesn't fire
  // against a stale ctx after the session ends.
  pi.on("session_shutdown", (_event, _ctx) => {
    clearTransientStatusTimer();
    activeCtx = undefined;
  });

  // The user changed the active Pi model. If we don't have a /prompt_enhance_model
  // override in place, the widget's Model line should reflect the change.
  pi.on("model_select", (_event, ctx) => {
    activeCtx = ctx;
    if (enhancerModelOverride === undefined) updateWidget(ctx);
  });

  // Enter: if auto-enhance is on and this draft is a real request, rewrite
  // and swallow the submit (handled). A second Enter, a skipped short reply,
  // or auto-off all continue to the agent. Slash commands never reach here.
  pi.on("input", async (event, ctx) => {
    activeCtx = ctx;

    const sendThrough = (): { action: "continue" } => {
      if (lastOriginalPrompt !== undefined) {
        lastOriginalPrompt = undefined;
        if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY_REVERT_HINT, undefined);
      }
      return { action: "continue" };
    };

    if (event.source !== "interactive") return sendThrough();
    if (event.streamingBehavior === "steer" || event.streamingBehavior === "followUp") {
      return sendThrough();
    }
    if (Array.isArray(event.images) && event.images.length > 0) return sendThrough();

    // Already reviewed (or explicitly enhanced) — send.
    if (lastOriginalPrompt !== undefined) return sendThrough();

    if (!autoEnhanceEnabled) return sendThrough();

    const draft = event.text.trim();
    if (
      shouldSkipAutoEnhance(draft, {
        lastAssistantAsked: lastAssistantAskedQuestion(ctx),
      })
    ) {
      return sendThrough();
    }

    await runEnhancer(ctx, draft);
    return { action: "handled" };
  });

  const handleEnhance = async (args: string, ctx: ExtensionContext): Promise<void> => {
    const provided = args.trim();
    await runEnhancer(ctx, provided.length > 0 ? provided : undefined);
  };

  pi.registerCommand("prompt_enhance", {
    description: "Prompt Enhancer: rewrite the editor into a codebase-aware prompt.",
    handler: handleEnhance,
  });

  pi.registerCommand("prompt_enhance_model", {
    description: "Prompt Enhancer: pick the enhancer model for this session (resets on restart).",
    handler: async (_args, ctx) => {
      await handleEnhanceModel(ctx);
    },
  });

  async function handleEnhanceModel(ctx: ExtensionContext): Promise<void> {
    const available = ctx.modelRegistry.getAvailable();
    if (available.length === 0) {
      ctx.ui.notify(
        "Prompt Enhancer: no models with configured API keys. Configure one in ~/.pi/agent/auth.json.",
        "error",
      );
      return;
    }

    // Order so the currently-active model appears first. Pi's selector
    // scrolls to the matching item; if the active model happens to fall
    // alphabetically near the bottom, the picker would otherwise open
    // already scrolled to the bottom of a long list.
    const isActive = (m: Model<Api>): boolean => {
      if (enhancerModelOverride !== undefined) {
        return enhancerModelOverride.provider === m.provider && enhancerModelOverride.id === m.id;
      }
      return ctx.model?.provider === m.provider && ctx.model.id === m.id;
    };
    const sortedAvailable = [...available].sort((a, b) => {
      const aActive = isActive(a);
      const bActive = isActive(b);
      if (aActive !== bActive) return aActive ? -1 : 1;
      return modelLabel(a).localeCompare(modelLabel(b));
    });
    const choices = sortedAvailable.map((m) => {
      const base = modelLabel(m);
      const tag = isActive(m)
        ? enhancerModelOverride !== undefined
          ? " (current)"
          : " (session default)"
        : "";
      return { label: `${base}${tag}`, model: m };
    });

    if (!ctx.hasUI) {
      ctx.ui.notify("Prompt Enhancer model picker requires interactive mode.", "warning");
      return;
    }

    // Official Pattern 1: SelectList + DynamicBorder via ctx.ui.custom
    // (editor-replace, no overlay). Overlay maxHeight only clips; SelectList
    // sizes its viewport from tui.terminal.rows so the highlight stays on screen.
    const items: SelectItem[] = choices.map((c) => ({
      value: modelLabel(c.model),
      label: c.label,
    }));
    const choice = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) =>
      createEnhancerModelSelector(tui, theme, items, done),
    );
    if (choice === undefined) return;
    const picked = choices.find((c) => modelLabel(c.model) === choice)?.model;
    if (!picked) return;
    enhancerModelOverride = picked;
    updateWidget(ctx);
    showTransientStatus(ctx, `Now using ${modelLabel(picked)}.`);
  }

  const handleRevert = (_args: string, ctx: ExtensionContext): Promise<void> => {
    runRevert(ctx);
    return Promise.resolve();
  };

  pi.registerCommand("prompt_enhance_revert", {
    description: "Prompt Enhancer: restore the editor to the text from before the last enhance.",
    handler: handleRevert,
  });

  pi.registerCommand("prompt_enhance_auto", {
    description: "Prompt Enhancer: toggle auto-enhance on Enter (off by default).",
    handler: (_args, ctx) => {
      autoEnhanceEnabled = !autoEnhanceEnabled;
      updateWidget(ctx);
      showTransientStatus(
        ctx,
        autoEnhanceEnabled
          ? "Auto-enhance on — Enter rewrites, Enter again sends."
          : "Auto-enhance off.",
      );
      return Promise.resolve();
    },
  });

  pi.registerShortcut("ctrl+shift+e", {
    description: "Prompt Enhancer: enhance the editor prompt in place.",
    handler: async (ctx) => {
      await runEnhancer(ctx, undefined);
    },
  });

  pi.registerShortcut("ctrl+shift+z", {
    description: "Prompt Enhancer: revert to the pre-enhance prompt.",
    handler: (ctx) => {
      runRevert(ctx);
      return Promise.resolve();
    },
  });
}
