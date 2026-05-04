/**
 * @jmcombs/pi-prompt-enhancer — Codebase-aware prompt enhancer for Pi.
 *
 * Registers:
 *   - /enhance [text]   — enhance the editor's contents (or supplied text) using
 *                          live codebase context (project tree, git, mentioned
 *                          files) and load the result back into the editor.
 *   - Ctrl+Shift+E      — enhance the editor's contents in place.
 *   - /enhance-model    — pick which model the enhancer uses for this session.
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
import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { complete, type Api, type Message, type Model } from "@mariozechner/pi-ai";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

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

const SYSTEM_PROMPT = `You are a prompt enhancer for a coding agent.

Given a user's rough prompt and live context from their working directory (project tree, git state, mentioned file contents), rewrite the prompt to be precise, actionable, and codebase-aware.

Rules:
- Preserve the user's intent exactly. Do not invent new requirements.
- If the prompt references files or functions, anchor your rewrite to the actual paths and code present in the context.
- Be concise. Output only the rewritten prompt — no preamble, no commentary, no markdown headings, no quoting of the original.
- If the original is already precise, return it nearly verbatim with only minor clarifications.
- Do not address the agent in the second person ("please ...") unless the original did. Match the tone of the original.

Return only the enhanced prompt as plain text.`;

// Status keys used with ctx.ui.setStatus so multiple enhancement triggers
// don't fight over the same footer slot.
const STATUS_KEY = "prompt-enhancer";

// ── Session-scoped state ────────────────────────────────────────────────

let enhancerModelOverride: Model<Api> | undefined;

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
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir is derived from cwd, not user input
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const dirent of dirents) {
      // typescript-eslint narrows `signal.aborted` to false from the earlier
      // check at the top of walk() and doesn't re-widen across the await above.
      // It can become true while we were awaiting fs.readdir, so the re-check
      // is real, not redundant.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
  // `truncated` is set inside recursive walk() calls; the analyzer doesn't see
  // that and would otherwise flag this as always-falsy.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
  const tokenRe = /[A-Za-z0-9_./@\-]+/g;
  const extRe =
    /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml|toml|css|scss|html|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|sh|bash|sql|prisma|tf|dockerfile)$/i;
  const matches = prompt.match(tokenRe) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/^[.,;:!?'"`(){}\[\]]+|[.,;:!?'"`(){}\[\]]+$/g, "");
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

  let stat;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is verified above to be inside cwd
    stat = await fs.stat(resolved);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  if (stat.size > 1_000_000) return undefined;

  let raw: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same as above
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

// ── Main flow ───────────────────────────────────────────────────────────

async function runEnhancer(ctx: ExtensionContext, providedText: string | undefined): Promise<void> {
  // The enhancer needs an interactive editor (to read/write prompt text) and
  // a TUI overlay (for the BorderedLoader). In print mode and JSON mode
  // ctx.hasUI is false and ctx.ui.custom is a no-op that returns undefined,
  // so the flow can't work — fail fast with a clear notification instead of
  // crashing on the undefined result.
  if (!ctx.hasUI) {
    ctx.ui.notify(
      "Prompt enhancer requires interactive mode (it reads and writes the editor).",
      "warning",
    );
    return;
  }

  const editorText = ctx.ui.getEditorText();
  const originalPrompt = (providedText ?? editorText).trim();

  if (!originalPrompt) {
    ctx.ui.notify("Prompt enhancer: nothing to enhance (editor is empty).", "warning");
    return;
  }

  const model = resolveEnhancerModel(ctx);
  if (!model) {
    ctx.ui.notify("Prompt enhancer: no active model. Pick one with /model first.", "error");
    return;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    ctx.ui.notify(`Prompt enhancer: ${auth.error}`, "error");
    return;
  }
  if (!auth.apiKey) {
    ctx.ui.notify(`Prompt enhancer: no API key configured for ${modelLabel(model)}.`, "error");
    return;
  }

  const editorBeforeReplace = editorText;
  // Replace the editor with the original (in case the user typed it via
  // /enhance "..." rather than into the editor) so a Ctrl+Z after success
  // takes them back to what they typed before invoking the enhancer.
  if (providedText !== undefined) ctx.ui.setEditorText(originalPrompt);

  ctx.ui.setStatus(STATUS_KEY, `enhancing via ${modelLabel(model)}`);

  const result = await ctx.ui.custom<
    { ok: true; enhanced: string } | { ok: false; reason: "cancelled" | "error"; message?: string }
  >((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, `Enhancing prompt via ${modelLabel(model)}…`, {
      cancellable: true,
    });
    loader.onAbort = () => {
      done({ ok: false, reason: "cancelled" });
    };

    const work = async (): Promise<
      | { ok: true; enhanced: string }
      | { ok: false; reason: "cancelled" | "error"; message?: string }
    > => {
      const context = await gatherEnhancerContext(originalPrompt, ctx.cwd, loader.signal);
      if (loader.signal.aborted) return { ok: false, reason: "cancelled" };

      const userMessage: Message = {
        role: "user",
        content: [{ type: "text", text: buildEnhancerUserMessage(originalPrompt, context) }],
        timestamp: Date.now(),
      };

      const response = await complete(
        model,
        { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
        { apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
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
    };

    work()
      .then(done)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        done({ ok: false, reason: "error", message });
      });

    return loader;
  });

  ctx.ui.setStatus(STATUS_KEY, undefined);

  if (result.ok) {
    ctx.ui.setEditorText(result.enhanced);
    ctx.ui.notify(
      "Prompt enhanced. Review the editor and submit when ready (Ctrl+Z to revert).",
      "info",
    );
    return;
  }

  // Restore whatever was in the editor before we touched it.
  ctx.ui.setEditorText(editorBeforeReplace);
  if (result.reason === "cancelled") {
    ctx.ui.notify("Prompt enhancement cancelled.", "info");
  } else {
    ctx.ui.notify(`Prompt enhancement failed: ${result.message ?? "unknown error"}`, "error");
  }
}

// ── Extension factory ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("enhance", {
    description: "Rewrite the editor's prompt into a precise, codebase-aware one.",
    handler: async (args, ctx) => {
      const provided = args.trim();
      await runEnhancer(ctx, provided.length > 0 ? provided : undefined);
    },
  });

  pi.registerCommand("enhance-model", {
    description: "Pick the model used by /enhance for this session (resets on restart).",
    handler: async (_args, ctx) => {
      const available = ctx.modelRegistry.getAvailable();
      if (available.length === 0) {
        ctx.ui.notify(
          "Prompt enhancer: no models with configured API keys. Configure one in ~/.pi/agent/auth.json.",
          "error",
        );
        return;
      }

      const choices = available.map((m) => {
        const base = modelLabel(m);
        const isOverride =
          enhancerModelOverride?.provider === m.provider && enhancerModelOverride.id === m.id;
        const isSessionDefault =
          enhancerModelOverride === undefined &&
          ctx.model?.provider === m.provider &&
          ctx.model.id === m.id;
        const label = isOverride
          ? `${base} (current)`
          : isSessionDefault
            ? `${base} (session default)`
            : base;
        return { label, model: m };
      });

      const choice = await ctx.ui.select(
        "Pick enhancer model",
        choices.map((c) => c.label),
      );
      if (choice === undefined) return;
      const picked = choices.find((c) => c.label === choice)?.model;
      if (!picked) return;
      enhancerModelOverride = picked;
      ctx.ui.notify(`Prompt enhancer: now using ${modelLabel(picked)} for this session.`, "info");
    },
  });

  pi.registerShortcut("ctrl+shift+e", {
    description: "Enhance the editor's prompt in place.",
    handler: async (ctx) => {
      await runEnhancer(ctx, undefined);
    },
  });
}
