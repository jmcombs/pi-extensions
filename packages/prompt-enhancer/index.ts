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
//
// `retryAssistantCall` is reached through the namespace rather than a named
// import: a host that ships a subset shim of pi-ai would turn a static named
// import of a missing symbol into a module-load error, taking the whole
// extension with it. Off the namespace it simply degrades to a single attempt.
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import {
  type Api,
  type AssistantMessage,
  complete,
  type Message,
  type Model,
  type RetryCallbacks,
  type RetryPolicy,
} from "@earendil-works/pi-ai/compat";
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
const FILE_MAX_BYTES = 1_000_000;

/**
 * Probe window for the *ratio* half of the binary guard, in decoded characters.
 * Long enough to cover a header plus a useful slice of payload, short enough
 * that scanning it costs nothing next to the read itself.
 *
 * The NUL half of the guard is deliberately **not** windowed — see
 * `looksBinary`. A window is a sampling decision for a statistic; it is not a
 * sound basis for a rule that says "no text file contains this byte".
 */
const BINARY_PROBE_CHARS = 8192;
/** Share of control/replacement characters in the probe that reads as binary. */
const BINARY_SUSPICIOUS_RATIO = 0.02;

/**
 * The project's own instruction files, sent as constraints on the rewrite.
 *
 * A rewrite that ignores what the repo already says about how work in it is
 * done is a worse prompt than the draft it replaced: the agent that executes it
 * then has to be corrected. These three names cover the conventions this
 * ecosystem actually writes down; they are probed at the working-directory root
 * only, never walked.
 */
const CONVENTION_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"] as const;

/**
 * How much of one instruction file may be sent.
 *
 * This is a safety valve against pathological input, **not** a token budget.
 * These files are the *rules the rewrite has to hold to*, and nobody enhances a
 * prompt to save tokens — they do it so the work is done against a properly
 * written prompt. A ceiling that clips a project's real instruction file makes
 * the feature fail at its job to save money nobody asked to save, so the
 * ceiling is set where no real file can reach it: 64 KB is three times this
 * repo's largest instruction file (`CONTRIBUTING.md`, 20,528 characters) and an
 * order of magnitude past a normal `AGENTS.md` or `CLAUDE.md`. What it still
 * stops is a generated multi-megabyte markdown dump landing under one of these
 * names. The 1 MB read guard in `readGuardedFile` is a separate, lower-level
 * protection and is unaffected by this number.
 */
export const CONVENTIONS_FILE_MAX_CHARS = 65_536;

/**
 * Ceiling on the whole conventions section.
 *
 * The same safety valve, applied to the set. Twice the per-file ceiling, so a
 * repo with two full-size instruction files never sees it and a real repo never
 * sees it at all; it exists only so that three pathological files cannot
 * multiply into a section that destroys the call. When it does bind, the budget
 * is shared by equal-share water-filling rather than first-come-first-served:
 * every file that is present is represented, a file that wants less than its
 * share frees the remainder for the others, and nobody can take the whole
 * budget and leave the rest with nothing. That is the fix for the old
 * winner-take-all spend, under which this repo sent `AGENTS.md` truncated and
 * dropped `CONTRIBUTING.md` entirely without saying so.
 */
export const CONVENTIONS_TOTAL_MAX_CHARS = 131_072;

/**
 * Smallest allowance worth spending on a file.
 *
 * The old loop tested its budget *before* slicing, so a file could be admitted
 * as ten characters of content plus a fourteen-character "truncated" marker — a
 * sliver that costs tokens and teaches the model nothing. Below this, the file
 * is omitted cleanly instead.
 */
export const CONVENTIONS_MIN_USEFUL_CHARS = 400;

/**
 * Bounds on the conversation background sent with the rewrite.
 *
 * A mid-conversation prompt ("I need to work with you on this dependabot
 * skill") cannot be rewritten from a project tree alone: "this" was named
 * earlier in the session, and a model with no tools fills that gap by
 * announcing what it would go and look at. A few recent turns close it.
 *
 * Deliberately small. The enhancer is one cheap completion before the real
 * turn, not a second agent; the budget caps the section at roughly 500 tokens
 * even in a long session.
 *
 * The per-turn cap is the one that had to move. At 320 characters an assistant
 * turn was clipped mid-sentence — and the assistant turn is usually the one a
 * follow-up prompt ("do that for the other package too") is pointing at, so the
 * clip landed on exactly the text the rewrite needed. 600 carries a normal
 * paragraph whole. Turn count stays at 4: the fix was depth per turn, not more
 * turns.
 */
export const HISTORY_MAX_TURNS = 4;
export const HISTORY_TURN_MAX_CHARS = 600;
export const HISTORY_MAX_CHARS = 2000;

export const SYSTEM_PROMPT = `You are a prompt rewriter for a coding agent. You do not answer the user's request. You do not solve, implement, or explain it. You rewrite their rough prompt into a better prompt for a *different* coding agent to execute later.

No tools are attached and nothing you say retrieves anything: your entire output is consumed as text, and the user message holds all the context you will ever get. Never announce what you would inspect or do.

Rules:
- Preserve intent exactly. Invent nothing: no new requirements, and no path that is not in the context, which is partial and may be truncated.
- Fix typos and misspellings, in identifiers and paths too, without changing what is asked for.
- Text in triple backticks (\`\`\`) is usually a verbatim sample — a trace, a diff, a test. Carry it through unchanged.
- Project conventions constrain the rewrite; do not restate them.
- Conversation background is there only to resolve what the prompt refers to. Never answer or continue it.
- If the prompt is not about the codebase, rewrite it anyway: return it as it is, clarified only if ambiguous. Never refuse, never explain yourself, never address the user.
- If the original is already precise, change little. Match its tone; no second person unless it used one.
- If you catch yourself answering, writing code, or listing steps, stop and output the rewritten *request* instead.

Output only the rewritten prompt as plain text: no preamble, no commentary, no headings, no quoting of the original.`;

// Status keys for ctx.ui.setStatus footer chips. Distinct keys so we can
// independently set/clear them. Enhance is not advertised as an always-on
// chip — /hotkeys and Ctrl+Shift+E are the catalog. Revert is contextual.
const STATUS_KEY_REVERT_HINT = "pe-revert";

function revertHintText(): string {
  return autoEnhanceEnabled
    ? "Enter to send · Ctrl+Shift+Z to revert"
    : "Ctrl+Shift+Z to revert enhanced prompt";
}

/**
 * Cap on the failure reason we quote back to the user.
 *
 * Provider error text is not written for a status line: it arrives multi-line,
 * sentence-punctuated, and occasionally with a whole JSON body attached. The
 * reason is a hint about *why*, not the payload, so it gets one line and a
 * budget.
 */
const FAILURE_REASON_MAX_CHARS = 100;

/**
 * Reduce raw provider/transport error text to something quotable inline:
 * first line only, no trailing period, capped. Returns `undefined` when there
 * is nothing left worth showing, so callers can drop the parenthetical
 * entirely rather than print an empty one.
 */
export function normalizeFailureReason(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const firstLine = raw.split("\n", 1)[0] ?? "";
  const trimmed = firstLine.trim().replace(/\.$/, "").trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > FAILURE_REASON_MAX_CHARS
    ? `${trimmed.slice(0, FAILURE_REASON_MAX_CHARS)}…`
    : trimmed;
}

/**
 * The one thing a failed enhancement says, identical in every mode.
 *
 * The point of the wording is the second clause: whatever went wrong, the text
 * the user typed is still theirs and still in the editor. Auto-enhance standing
 * itself down is shown by the widget, not repeated here.
 */
export function formatEnhancementFailure(reason: string | undefined): string {
  const normalized = normalizeFailureReason(reason);
  return normalized === undefined
    ? "prompt enhancement failed; your prompt is unchanged"
    : `prompt enhancement failed (${normalized}); your prompt is unchanged`;
}

/**
 * The loader line while a retry is pending.
 *
 * Naming the reason turns a 14-second wait into a decision: a user who can see
 * `Connection error` at second 2 can press Esc instead of watching the whole
 * budget drain. Without a reason it is the line pi's own retry indicator shows.
 */
export function formatRetryStatus(
  attempt: number,
  maxAttempts: number,
  delayMs: number,
  errorMessage?: string,
): string {
  const line = `Retrying (${attempt}/${maxAttempts}) in ${Math.ceil(delayMs / 1000)}s…`;
  const reason = normalizeFailureReason(errorMessage);
  return reason === undefined ? line : `${line} · ${reason}`;
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
 * The last text the user actually wrote — the prompt this chain re-rolls.
 *
 * Assigned on every successful enhance to whatever that enhance was given, and
 * cleared when the chain ends: at `/prompt_enhance_revert`, at submit (the
 * `input` event), or at `session_start`.
 *
 * That assignment is a no-op on a re-roll and a re-seat on anything else, which
 * is the whole rule. Pressing Ctrl+Shift+E over a rewrite we wrote and nobody
 * touched enhances *this* again rather than the rewrite on screen — the point
 * of enhancing twice is a different approach to the same request, and a rewrite
 * of a rewrite is not that — so the stored string does not move. Pressing it
 * over text the user typed or edited enhances that text, and that text becomes
 * what the next press re-rolls: an edit is the user saying something, and what
 * they last said is what "again" means.
 *
 * Two earlier rules were tried and both failed the same way. Assigning it on
 * every success *including* re-rolls overwrote the typed draft with rewrite #1,
 * because a re-roll's input is the rewrite when the input is read off the
 * screen rather than out of this variable. Re-seating on resemblance —
 * word-token overlap against a threshold — moved it whenever the user cut more
 * than about half the words, which is exactly what "the model was too verbose,
 * let me trim it" looks like. Both left Ctrl+Shift+Z putting machine text in the
 * editor under a status that said "your original prompt". So the re-seat turns
 * on provenance and nothing else: `editorHoldsOurText`, one byte comparison,
 * no threshold.
 *
 * What Ctrl+Shift+Z restores is therefore the last thing the user wrote, not
 * the first — an edit mid-chain replaces the draft it was made from, and that
 * draft is gone (the editor's own undo is what steps back through the text in
 * between). Whether the restore is lossless is not remembered: it is asked of
 * the editor at revert time, so an edit made after the last enhance is warned
 * about too.
 */
let lastOriginalPrompt: string | undefined;

/**
 * The exact string this extension last wrote into the editor.
 *
 * Provenance, not resemblance: we `setEditorText` the rewrite ourselves, so a
 * later read that is byte-equal to it is *certain* to be our own output coming
 * back untouched. That certainty is all this value is used for. It answers one
 * question — "has anything other than us written the editor since?" — and never
 * decides which text revert restores.
 *
 * Two things turn on the answer: whether the status line may claim nothing was
 * typed over the chain, and whether the next enhance re-rolls the stored
 * original instead of rewriting the rewrite on screen.
 */
let lastEnhancedText: string | undefined;

/**
 * The editor's own representation of a string we hand it.
 *
 * `ui.setEditorText` is pi-tui `Editor.setText`, which normalises before it
 * stores (`Editor.normalizeText`): CRLF and CR collapse to LF, and every TAB
 * becomes four spaces. So what comes back out of `getEditorText` is not what we
 * put in — a rewrite containing a single tab reads back four spaces wider and
 * never compares equal to the string we sent.
 *
 * Applying the same transform to our stored copy puts both sides in the
 * editor's representation, which is the only representation the comparison can
 * honestly be made in. Same three replacements, same order, mirroring pi.
 * `editorRoundTrip` in the tests pins this against the real `Editor`, so a
 * change in pi's expansion fails loudly rather than quietly reintroducing the
 * mismatch.
 *
 * `ui.setEditorComponent` can put a different component in that slot, and a
 * component that stores text verbatim would make this transform an
 * over-normalisation rather than a match. Nothing in the extension API reports
 * which component is installed, so there is nothing to feature-detect; the
 * guard is in `editorHoldsOurText`, which accepts either representation.
 */
export function toEditorText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
}

/**
 * Is the editor still holding the exact text this extension last wrote?
 *
 * Provenance, not resemblance. It answers one question — "did our own output
 * come back untouched?" — by byte-comparing, in the editor's representation,
 * what the editor now holds against what we sent it. There is deliberately no
 * threshold, no token overlap, no notion of "close enough": a similarity rule
 * lived here once and moved the stored original whenever a user trimmed a
 * verbose rewrite, which is exactly when they most needed it left alone.
 *
 * Both sides are trimmed because every read of the editor in this extension is
 * trimmed; normalise first, then trim, so a leading or trailing tab is expanded
 * before the trim decides whether it is whitespace.
 *
 * Our text is accepted in either representation — normalised, as pi-tui's
 * `Editor` hands it back, or verbatim, as a component installed through
 * `ui.setEditorComponent` may. Both arms are byte-exact, so widening costs no
 * precision: under the real `Editor` the verbatim arm can only match when the
 * two strings were already identical, and under a verbatim component the
 * normalised arm can only match when normalising changed nothing. Without it a
 * single tab in a rewrite would read as a hand edit on any host that does not
 * expand tabs — the same defect `toEditorText` exists to fix, from the other
 * side.
 *
 * What rides on the answer: whether the revert status line may claim nothing was
 * typed over the chain, and whether this enhance re-rolls the stored original
 * rather than rewriting the rewrite. One comparison, so the two can never
 * disagree about what the editor is holding.
 */
export function editorHoldsOurText(editorText: string, ourText: string | undefined): boolean {
  if (ourText === undefined) return false;
  const held = editorText.trim();
  return held === toEditorText(ourText).trim() || held === ourText.trim();
}

/**
 * What `/prompt_enhance_revert` says it just did.
 *
 * Because an edit re-seats the chain, the string revert restores is always the
 * last text the user wrote *and enhanced*, so the strong sentence is true
 * whenever the editor still holds the rewrite that came back from that enhance.
 *
 * The one thing that can be lost is an edit made after it — the user tightened
 * our rewrite and pressed Ctrl+Shift+Z instead of enhancing again — and that
 * edit was never given to the model, so nothing recorded it. The editor is what
 * knows, and it is asked at revert time rather than remembered: if it is not
 * holding our last rewrite, someone typed since, and their typing is what the
 * restore is about to overwrite. Hence "later edits", literally — edits later
 * than the enhance whose input is coming back.
 *
 * A hedged sentence for an edit the user then chose to discard is a small cost;
 * a confident sentence over text they wanted is not.
 */
export function revertStatusText(laterEditsLost: boolean): string {
  return laterEditsLost
    ? "Reverted to your original prompt; later edits lost."
    : "Reverted to your original prompt.";
}

/**
 * What the status line says after a successful rewrite.
 *
 * The re-roll wording exists because a re-roll can otherwise look like nothing
 * happened: the same prompt goes to the model a second time, and a model that
 * answers much as it did the first time leaves the editor looking untouched.
 * Naming what was enhanced — the original, not the rewrite on screen — is the
 * whole of the difference, and it costs a sentence rather than a new command,
 * shortcut or piece of state.
 */
export function enhancedStatusText(options: { rerolled: boolean; autoEnhance: boolean }): string {
  const what = options.rerolled ? "Re-enhanced your original prompt" : "Prompt enhanced";
  return options.autoEnhance ? `${what} — Enter to send.` : `${what} — Ctrl+Shift+Z to revert.`;
}

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
  /**
   * The repo's own instruction files (`AGENTS.md`, `CLAUDE.md`,
   * `CONTRIBUTING.md`) as constraints on the rewrite. Optional so an existing
   * consumer constructing this type by hand keeps compiling; absent and empty
   * mean the same thing to `buildEnhancerUserMessage`.
   */
  conventions?: { path: string; content: string }[];
  /**
   * Files inside the project that were `stat`ed successfully and then *refused*
   * by a read guard — oversized, unreadable, or not text. Never sent to the
   * model; surfaced to the user by repo-relative path so a refusal is a
   * statement rather than a silence.
   *
   * A path that is not there, and a path that escapes the working directory,
   * are both absent from this list: the first is the ordinary case, and the
   * second has no repo-relative name to show.
   */
  skippedFiles?: SkippedFile[];
  /**
   * Recent conversation turns, oldest first, already bounded by
   * `buildRecentTurns`. Absent on the first turn of a session and on any host
   * that does not expose `sessionManager.getBranch`.
   */
  history?: string;
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

/** ESC, the byte every ANSI escape sequence starts with. */
const ESC_CODE = 0x1b;

/** `]`, the introducer that makes an escape sequence an OSC. */
const OSC_INTRODUCER = 0x5d;

/**
 * BEL, the other way an OSC ends.
 *
 * Exempting ESC alone was half the fix. An OSC — a hyperlink, a window title —
 * is `ESC ] … ST`, and `ST` is spelled either `ESC \` or a bare BEL. `gh` and
 * `cargo` write OSC-8 hyperlinks into their output, so a saved log of either is
 * ordinary text carrying one BEL per link: 2.98% controls on a measured
 * capture, refused as "not text" by a 2% threshold. The `ESC \` spelling was
 * already exempt, which made the refusal depend on which spelling the tool
 * happened to use.
 */
const BEL_CODE = 0x07;

/**
 * Is the character at `index` an ESC that introduces an ANSI escape sequence?
 *
 * An escape sequence is ESC followed by an *introducer*: a byte in `@`–`_`
 * (0x40–0x5F, which covers CSI `[` and OSC `]`) for the two-byte Fe forms, or
 * `(` / `)` for the character-set designators. Everything after the introducer
 * — the parameters, the intermediates and the final byte — is printable ASCII,
 * so the ESC itself is the only character in `\x1b[32m` the C0 counter can
 * see. Testing the introducer rather than exempting ESC outright keeps a real
 * binary honest: a 0x1B in random payload has roughly a one-in-eight chance of
 * being followed by an introducer byte, so a file full of them still trips the
 * ratio.
 */
function startsAnsiSequence(text: string, index: number): boolean {
  const next = text.charCodeAt(index + 1);
  if (Number.isNaN(next)) return false;
  return (next >= 0x40 && next <= 0x5f) || next === 0x28 || next === 0x29;
}

/**
 * Does this decoded text look like something that was never text?
 *
 * The size cap does not cover it: a 4 KB `.ico` or a small `.wasm` is well
 * inside the budget and decodes to mojibake that costs tokens and teaches the
 * model nothing. `extractFileMentions` matches any token holding a `/`, so
 * "why does assets/logo.png look wrong" is enough to name one. Reading as UTF-8
 * turns undecodable bytes into U+FFFD, so the probe counts those alongside the
 * C0 controls (tab, LF, CR excepted).
 *
 * Two rules, with deliberately different scopes:
 *
 * 1. **NUL, unwindowed.** No text file contains one, so this is decisive — and
 *    it is checked across the entire decoded file rather than the probe window.
 *    A window here was a real hole: a file that read as text for 9,000
 *    characters and then carried a NUL cleared an 8,192-character probe and was
 *    delivered to the model with the NUL still in it.
 * 2. **Control ratio, windowed.** A statistic, so sampling the head is fine.
 *    ANSI escape sequences are excluded from it: a saved CI log
 *    (`\x1b[32mPASS\x1b[0m …`) is ordinary text a user pastes or names, and
 *    counting its colour codes as control noise pushed it past the threshold
 *    and had it silently refused.
 */
function looksBinary(raw: string): boolean {
  if (raw.includes("\0")) return true;

  const probe = raw.slice(0, BINARY_PROBE_CHARS);
  if (probe.length === 0) return false;
  let suspicious = 0;
  // Inside an OSC — opened by `ESC ]`, closed by BEL or by ST (`ESC \`).
  let inOsc = false;
  for (let i = 0; i < probe.length; i += 1) {
    const code = probe.charCodeAt(i);
    if (code === ESC_CODE && startsAnsiSequence(probe, i)) {
      inOsc = probe.charCodeAt(i + 1) === OSC_INTRODUCER;
      continue;
    }
    if (code === BEL_CODE && inOsc) {
      inOsc = false;
      continue;
    }
    // U+FFFD REPLACEMENT CHARACTER, or a C0 control that is not \t \n \r.
    if (code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13)) {
      suspicious += 1;
    }
  }
  return suspicious > probe.length * BINARY_SUSPICIOUS_RATIO;
}

/**
 * Why a file the extension was willing to consider did not make it into the
 * prompt. Surfaced to the user; see `formatSkippedFiles`.
 *
 * `path` is always repo-relative and always a path that was `stat`ed
 * successfully. It is never the token the user typed: the extractor takes
 * `~/.ssh/id_rsa` apart into `/.ssh/id_rsa`, and a note built from raw tokens
 * put strings like that — and, for a real absolute path, the absolute path
 * itself — in the status bar.
 */
export interface SkippedFile {
  path: string;
  why: string;
}

/**
 * The outcome of one guarded read.
 *
 * `refusal` is the distinction that matters to the UI, and it is narrower than
 * "a guard said no". It is set only for a file that resolves inside the project
 * and exists — the user named something real and did not get it. Everything
 * else is silent: a path that is not there, and a path that escapes the working
 * directory, which has no repo-relative name to show and whose existence is not
 * the status bar's to report.
 */
type GuardedRead = { ok: true; path: string; raw: string } | { ok: false; refusal?: SkippedFile };

/**
 * Read one repo-relative file under a fixed set of guards, or give up.
 *
 * Every guard is a refusal, never a repair: a path that escapes the working
 * directory, a directory, a symlink to somewhere else, an oversized file and a
 * binary one all decline to return content rather than returning a degraded
 * value. Written as one function so there is exactly one containment check to
 * audit. Clipping is the caller's job — the callers bound the same bytes by
 * different rules.
 */
async function readGuardedFile(candidate: string, cwd: string): Promise<GuardedRead> {
  // Resolve, then ensure the resolved path stays within cwd to avoid the
  // extension reading arbitrary files via "../../etc/passwd"-style paths.
  const resolved = path.resolve(cwd, candidate);
  const rel = path.relative(cwd, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    // Silent, and deliberately so. There is no repo-relative name for a path
    // that escapes the project, and `candidate` is the raw token — naming it
    // rendered `/Users/…/Library/Keychains/login.keychain-db` in the status
    // bar, and `~/.ssh/id_rsa` as the `/.ssh/id_rsa` the extractor made of it,
    // for files that had not even been `stat`ed.
    return { ok: false };
  }

  // Then again on the *real* path. The check above compares strings, and a
  // string cannot see a symlink: a repo shipping `notes.md` as a link to
  // `~/.ssh/id_rsa` clears it and gets read. `cwd` is realpathed too — on macOS
  // the temp directory is itself a symlink, so a real path compared against a
  // nominal one would never match and every read would be refused.
  let realResolved: string;
  let realCwd: string;
  try {
    [realResolved, realCwd] = await Promise.all([fs.realpath(resolved), fs.realpath(cwd)]);
  } catch {
    return { ok: false };
  }
  const realRel = path.relative(realCwd, realResolved);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) return { ok: false };

  let stat: Stats;
  try {
    stat = await fs.stat(realResolved);
  } catch {
    return { ok: false };
  }
  if (!stat.isFile()) return { ok: false };
  if (stat.size > FILE_MAX_BYTES) {
    return { ok: false, refusal: { path: rel, why: "too large" } };
  }

  let raw: string;
  try {
    raw = await fs.readFile(realResolved, "utf-8");
  } catch {
    return { ok: false, refusal: { path: rel, why: "unreadable" } };
  }
  if (looksBinary(raw)) {
    return { ok: false, refusal: { path: rel, why: "not text" } };
  }

  return { ok: true, path: rel, raw };
}

/**
 * Clip to `maxLines`, with the existing marker.
 *
 * Line-bounded from the start, so nothing here changes: a mentioned file is
 * bounded by how much of it is worth reading, not by a character budget.
 */
function clipToLineCount(raw: string, maxLines: number): string {
  const lines = raw.split("\n");
  if (lines.length <= maxLines) return raw;
  const body = lines.slice(0, maxLines).join("\n");
  return `${body}\n… (truncated at ${String(maxLines)} lines, file has ${String(lines.length)} total)`;
}

/**
 * Clip to `maxChars`, always on a line boundary, or give up.
 *
 * A character budget applied with `slice` cuts wherever it lands: this repo's
 * `AGENTS.md` came back ending inside an inline-code span, which reads to the
 * model as a malformed rule rather than a truncated one. Whole lines only, and
 * the marker says exactly how much was left behind rather than the bare
 * "(truncated)" it used to.
 *
 * Returns `undefined` when not even the first line fits. That is the honest
 * answer for a file whose first line alone exceeds the budget: there is no
 * line-boundary prefix to send, and half a token is worse than nothing.
 */
function clipToCharBudget(raw: string, maxChars: number): string | undefined {
  if (raw.length <= maxChars) return raw;

  const lines = raw.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    // Every line after the first costs its own length plus the "\n" that
    // rejoins it, so `used` is exactly the length of `kept.join("\n")`.
    const cost = kept.length === 0 ? line.length : line.length + 1;
    if (used + cost > maxChars) break;
    kept.push(line);
    used += cost;
  }
  if (kept.length === 0) return undefined;

  return `${kept.join("\n")}\n… (truncated: sent ${String(kept.length)} of ${String(lines.length)} lines, ${String(used)} of ${String(raw.length)} characters)`;
}

async function buildMentionedFiles(
  prompt: string,
  cwd: string,
): Promise<{ files: { path: string; content: string }[]; skipped: SkippedFile[] }> {
  const candidates = extractFileMentions(prompt).slice(0, FILE_MAX_REFERENCES * 4);
  const files: { path: string; content: string }[] = [];
  const skipped: SkippedFile[] = [];
  for (const candidate of candidates) {
    if (files.length >= FILE_MAX_REFERENCES) break;
    const read = await readGuardedFile(candidate, cwd);
    if (read.ok)
      files.push({ path: read.path, content: clipToLineCount(read.raw, FILE_MAX_LINES) });
    else if (read.refusal) skipped.push(read.refusal);
  }
  return { files, skipped };
}

/**
 * Split a total character budget across the instruction files that are present.
 *
 * Equal-share water-filling: everyone is offered `total / n`; whoever wants less
 * than their share takes what they want and frees the difference, and the round
 * repeats until nothing changes. That is what makes "all present files are
 * represented" true by construction — the old first-come spend gave file #1
 * everything it could hold and left the rest with nothing, silently.
 *
 * `sizes` are raw file lengths; the returned allowance for each is at most
 * `perFile`. An allowance of `0` means "omit this file", which happens only when
 * the share is too small to carry a meaningful part of it — a sliver of content
 * plus a truncation marker is not a cheaper version of the file, it is noise.
 *
 * Exported for the budget tests; nothing outside this module needs it.
 */
export function allocateConventionsBudget(
  sizes: readonly number[],
  total: number = CONVENTIONS_TOTAL_MAX_CHARS,
  perFile: number = CONVENTIONS_FILE_MAX_CHARS,
  minUseful: number = CONVENTIONS_MIN_USEFUL_CHARS,
): number[] {
  const want = sizes.map((size) => Math.min(Math.max(size, 0), perFile));
  const allowance = want.slice();

  let remaining = Math.max(total, 0);
  const pending = new Set(want.map((_, index) => index));
  while (pending.size > 0) {
    const share = Math.floor(remaining / pending.size);
    const satisfied = [...pending].filter((index) => (want[index] ?? 0) <= share);
    if (satisfied.length === 0) {
      for (const index of pending) allowance[index] = share;
      break;
    }
    for (const index of satisfied) {
      const taken = want[index] ?? 0;
      allowance[index] = taken;
      remaining -= taken;
      pending.delete(index);
    }
  }

  return allowance.map((granted, index) => {
    const wanted = want[index] ?? 0;
    if (granted >= wanted) return wanted;
    return granted >= minUseful ? granted : 0;
  });
}

/**
 * The project's instruction files: what the repo already says about how work in
 * it should be done, plus any that were refused.
 *
 * Probed at the working-directory root only. Each file gets up to
 * `CONVENTIONS_FILE_MAX_CHARS`, the set gets up to `CONVENTIONS_TOTAL_MAX_CHARS`
 * shared by water-filling, and anything clipped is clipped on a line boundary
 * with a marker that says how much was left behind.
 */
async function collectProjectConventions(
  cwd: string,
): Promise<{ files: { path: string; content: string }[]; skipped: SkippedFile[] }> {
  const reads = await Promise.all(CONVENTION_FILES.map((name) => readGuardedFile(name, cwd)));

  const present = reads.filter((read): read is Extract<GuardedRead, { ok: true }> => read.ok);
  const skipped = reads.flatMap((read) => (!read.ok && read.refusal ? [read.refusal] : []));

  const allowances = allocateConventionsBudget(present.map((file) => file.raw.length));
  const files: { path: string; content: string }[] = [];
  for (const [index, file] of present.entries()) {
    const allowance = allowances[index] ?? 0;
    if (allowance <= 0) continue;
    const content = clipToCharBudget(file.raw, allowance);
    if (content === undefined) continue;
    files.push({ path: file.path, content });
  }
  return { files, skipped };
}

/**
 * The conventions the enhancer would send for `cwd`.
 *
 * Returns `[]` when the repo has none, which keeps the section out of the user
 * message entirely rather than sending an empty heading.
 */
export async function buildProjectConventions(
  cwd: string,
): Promise<{ path: string; content: string }[]> {
  return (await collectProjectConventions(cwd)).files;
}

// ── Context assembly ────────────────────────────────────────────────────

export async function gatherEnhancerContext(
  prompt: string,
  cwd: string,
  signal: AbortSignal,
): Promise<EnhancerContext> {
  const [tree, git, mentioned, conventions] = await Promise.all([
    buildProjectTree(cwd, signal),
    buildGitContext(cwd, signal),
    buildMentionedFiles(prompt, cwd),
    collectProjectConventions(cwd),
  ]);
  return {
    cwd,
    tree,
    git,
    mentionedFiles: mentioned.files,
    conventions: conventions.files,
    skippedFiles: [...mentioned.skipped, ...conventions.skipped],
  };
}

/**
 * The tail of a session as compact `User:` / `Agent:` lines, oldest first.
 *
 * Pure so it can be unit-tested without a host: it takes whatever
 * `sessionManager.getBranch()` returns and tolerates both entry shapes pi has
 * used (a bare message, or `{ message }`). Bounded three ways — turn count,
 * per-turn characters, and a total character budget — so a long session costs
 * the same as a short one. Whitespace is collapsed because the rewrite only
 * needs the words, not the formatting.
 *
 * Returns `undefined` when there is nothing usable, which keeps the section
 * out of the user message entirely on the first turn.
 */
export function buildRecentTurns(entries: readonly unknown[]): string | undefined {
  const lines: string[] = [];
  let budget = HISTORY_MAX_CHARS;

  for (let i = entries.length - 1; i >= 0 && lines.length < HISTORY_MAX_TURNS; i -= 1) {
    const entry = entries[i] as { role?: string; content?: unknown; message?: unknown } | undefined;
    if (typeof entry !== "object" || entry === null) continue;
    const message = (entry.message ?? entry) as { role?: string; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;

    const text = extractMessageText(message.content).replace(/\s+/g, " ").trim();
    if (text.length === 0) continue;

    const clipped =
      text.length > HISTORY_TURN_MAX_CHARS ? `${text.slice(0, HISTORY_TURN_MAX_CHARS)}…` : text;
    const line = `${message.role === "user" ? "User" : "Agent"}: ${clipped}`;
    // Stop at the budget rather than truncating mid-line: a half-sentence from
    // the oldest turn is the least useful thing we could spend it on.
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }

  return lines.length === 0 ? undefined : lines.reverse().join("\n");
}

/**
 * Session history for the current run, or `undefined`.
 *
 * `sessionManager.getBranch` is feature-detected: oh-my-pi remaps
 * `@earendil-works/pi-coding-agent` to a subset shim, and an enhancer that
 * throws on a missing host API is worse than one with no history.
 */
function gatherSessionHistory(ctx: ExtensionContext): string | undefined {
  try {
    if (typeof ctx.sessionManager?.getBranch !== "function") return undefined;
    return buildRecentTurns(ctx.sessionManager.getBranch());
  } catch {
    return undefined;
  }
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
  // Ahead of the prompt-specific files on purpose: these are the rules the
  // rewrite has to hold to, and the heading says so, because a model handed a
  // style guide will otherwise summarise it back as if that were the task.
  if (context.conventions && context.conventions.length > 0) {
    const blocks = context.conventions.map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
    sections.push(
      `## Project conventions (constraints on the rewrite — do not restate them)\n\n${blocks.join("\n\n")}`,
    );
  }
  if (context.mentionedFiles.length > 0) {
    const blocks = context.mentionedFiles.map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
    sections.push(`## Files referenced in the prompt\n\n${blocks.join("\n\n")}`);
  }
  // Labelled as background, twice: a model handed raw dialogue will otherwise
  // answer the last thing it sees instead of rewriting the prompt below.
  if (context.history) {
    sections.push(
      `## Recent conversation (background only — do not answer or continue it)\n${context.history}`,
    );
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
  | { ok: true; enhanced: string; skippedFiles?: SkippedFile[] }
  | { ok: false; reason: "cancelled" | "error"; message?: string };

/** How many refused files are named before the note falls back to a count. */
const SKIPPED_FILES_SHOWN = 2;

/**
 * Budget for the whole note, and for one path inside it.
 *
 * The note is appended to a status line in a single-line widget that does not
 * wrap or truncate, so an unbounded note pushes the rest of the line off the
 * terminal. Two refused files nested a few directories deep measured 243
 * characters. A deep path keeps its tail — the basename is the half that
 * identifies the file — behind a leading ellipsis.
 */
const SKIPPED_NOTE_MAX_CHARS = 120;
const SKIPPED_PATH_MAX_CHARS = 40;

function shortenSkippedPath(filePath: string): string {
  if (filePath.length <= SKIPPED_PATH_MAX_CHARS) return filePath;
  return `…${filePath.slice(filePath.length - (SKIPPED_PATH_MAX_CHARS - 1))}`;
}

/**
 * One clause naming the files the guards refused, or `undefined`.
 *
 * A refusal used to be invisible: name a saved terminal log or a `.png` in the
 * prompt, and the rewrite came back built on context that quietly excluded it.
 * The reason travels with the name because the reasons are actionable in
 * different ways — "too large" is a different problem from "not text".
 *
 * Every path here is repo-relative and belongs to a file that exists; see
 * `SkippedFile`. The note names as many as fit the budget and then gives up on
 * names rather than on the budget: a bare count still tells the user that
 * something was left out.
 */
export function formatSkippedFiles(
  skipped: readonly SkippedFile[] | undefined,
): string | undefined {
  if (skipped === undefined || skipped.length === 0) return undefined;

  for (let shown = SKIPPED_FILES_SHOWN; shown >= 1; shown -= 1) {
    const named = skipped
      .slice(0, shown)
      .map((file) => `${shortenSkippedPath(file.path)} (${file.why})`)
      .join(", ");
    const rest = skipped.length - shown;
    const note = rest > 0 ? `Skipped ${named} +${String(rest)} more.` : `Skipped ${named}.`;
    if (note.length <= SKIPPED_NOTE_MAX_CHARS) return note;
  }

  return skipped.length === 1 ? "Skipped 1 file." : `Skipped ${String(skipped.length)} files.`;
}

/**
 * Retry budget for the enhancer's LLM call.
 *
 * Mirrors pi's own `settings.retry` defaults (enabled, 3 retries, 2000 ms base)
 * so a transient provider or transport failure behaves here the way it does in
 * a normal pi turn: 4 attempts total, backing off 2000 / 4000 / 8000 ms, giving
 * up after ~14 s. Extensions do not run through the agent session, so nothing
 * applies this for us — a bare `complete()` fails on the first hiccup.
 */
export const ENHANCER_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
};

/**
 * Run one assistant call under pi's own retry policy and classifier.
 *
 * `retryAssistantCall` is pi's shared helper: it returns success and `aborted`
 * immediately (an abort is the user pressing Esc and must never be retried),
 * fails fast on errors its `isRetryableAssistantError` classifier rejects, and
 * otherwise backs off between attempts while honouring `signal` — an abort
 * during the backoff sleep comes back as an `aborted` message rather than an
 * error, so Esc is felt at once instead of after the remaining delay.
 *
 * If the host does not expose the helper, this degrades to a single attempt.
 */
export async function completeWithRetry(
  produce: () => Promise<AssistantMessage>,
  signal: AbortSignal | undefined,
  policy: RetryPolicy = ENHANCER_RETRY_POLICY,
  callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
  const retryAssistantCall = piAiCompat.retryAssistantCall as
    | typeof piAiCompat.retryAssistantCall
    | undefined;
  if (typeof retryAssistantCall !== "function") return produce();
  return retryAssistantCall(produce, policy, signal, callbacks);
}

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
    /** Bounded conversation background; read from the host before this runs. */
    history: string | undefined;
    /**
     * Optional retry progress hooks. The interactive path passes these so the
     * loader can say it is retrying instead of sitting silent for the whole
     * backoff; the headless path leaves them out and nothing is reported.
     */
    retryCallbacks?: RetryCallbacks;
  },
  signal: AbortSignal,
): Promise<EnhancementOutcome> {
  const { cwd, model, auth, originalPrompt, history, retryCallbacks } = params;

  const context = await gatherEnhancerContext(originalPrompt, cwd, signal);
  if (signal.aborted) return { ok: false, reason: "cancelled" };

  const userMessage: Message = {
    role: "user",
    content: [
      { type: "text", text: buildEnhancerUserMessage(originalPrompt, { ...context, history }) },
    ],
    timestamp: Date.now(),
  };

  const response = await completeWithRetry(
    () =>
      complete(
        model,
        { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
        { apiKey: auth.apiKey, headers: auth.headers, signal },
      ),
    signal,
    // Left undefined so the ENHANCER_RETRY_POLICY default binding applies —
    // the only production call site, and what the default-binding test pins.
    undefined,
    retryCallbacks,
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

  return { ok: true, enhanced, skippedFiles: context.skippedFiles };
}

/** Anything exposing pi-tui's `Loader.setMessage`. */
type MessageSettable = { setMessage: (message: string) => void };

function isMessageSettable(value: unknown): value is MessageSettable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { setMessage?: unknown }).setMessage === "function"
  );
}

/**
 * Update the text a `BorderedLoader` is showing.
 *
 * `BorderedLoader` wraps a pi-tui `Loader` (which owns `setMessage`) without
 * re-exposing it, so this feature-detects the wrapper first — in case a later
 * pi surfaces the method — then the wrapped loader. If neither is there the
 * message simply stays as it was: retry feedback is additive and must never
 * become a failure path of its own.
 */
function setLoaderMessage(loader: BorderedLoader, message: string): void {
  if (isMessageSettable(loader)) {
    loader.setMessage(message);
    return;
  }
  const inner = (loader as unknown as { loader?: unknown }).loader;
  if (isMessageSettable(inner)) inner.setMessage(message);
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
  const typedPrompt = (providedText ?? editorText).trim();

  /**
   * Is the editor exactly as we left it?
   *
   * Command arguments are excluded on purpose: an argument is something the
   * user typed, and typing one opens a fresh chain, so it can never be a
   * re-roll of the previous one.
   */
  const editorHeldOurRewrite =
    providedText === undefined && editorHoldsOurText(editorText, lastEnhancedText);

  /**
   * A second Ctrl+Shift+E over an untouched rewrite is a re-roll, not a second
   * pass.
   *
   * Feeding rewrite #1 back to the model produced rewrite-of-a-rewrite: each
   * press drifted further from what the user meant, and asking again for "a
   * different approach" — the thing repeat-enhancing is *for* — instead
   * compounded the last one. Re-running the stored original gives a genuine
   * alternative from the same starting point.
   *
   * The exception is the whole point of the comparison: if the editor is not
   * byte-for-byte what we wrote, the user changed it, and their change is the
   * prompt — and, once enhanced, the prompt every later press re-rolls, since
   * "again" can only mean the last thing the user said.
   */
  const storedOriginal = lastOriginalPrompt;
  const rerollingOriginal = storedOriginal !== undefined && editorHeldOurRewrite;
  const originalPrompt = rerollingOriginal ? storedOriginal : typedPrompt;

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

  /**
   * What goes back in the editor if this run does not produce a rewrite.
   *
   * Normally that is whatever was there before we touched it. On the
   * auto-enhance path it cannot be: pi clears the editor before it fires the
   * `input` event, so the snapshot is empty and restoring it would delete the
   * very draft a cancel or a failure promises to leave alone. Falling back to
   * the prompt itself puts back exactly what the user typed.
   */
  const editorRestoreText = editorText.trim().length > 0 ? editorText : originalPrompt;

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
    history: gatherSessionHistory(ctx),
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
      const workingMessage = `Enhancing prompt via ${modelLabel(model)}…`;
      const loader = new BorderedLoader(tui, theme, workingMessage, {
        cancellable: true,
      });
      loader.onAbort = () => {
        done({ ok: false, reason: "cancelled" });
      };

      // Without this the loader sits on "Enhancing prompt via …" for the whole
      // ~14 s retry budget with nothing to show the call is being retried.
      // Wording follows pi's own retry status indicator, plus the reason the
      // last attempt gave — that is what lets the user decide to Esc early.
      const retryCallbacks: RetryCallbacks = {
        onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
          setLoaderMessage(loader, formatRetryStatus(attempt, maxAttempts, delayMs, errorMessage));
        },
        onRetryAttemptStart: () => setLoaderMessage(loader, workingMessage),
      };

      performEnhancement({ ...enhanceParams, retryCallbacks }, loader.signal)
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

    // The chain original is whatever this enhance was given, because that is
    // the last thing the user actually wrote. On a re-roll it is the stored
    // original and this re-assigns the same string; on anything else — a first
    // enhance, a command argument, a rewrite the user edited or replaced — it
    // is the user's own words, and they become what the next press re-rolls and
    // what Ctrl+Shift+Z restores. One assignment, no branch, so what was sent
    // to the model and what revert hands back can never be different strings.
    lastOriginalPrompt = originalPrompt;
    lastEnhancedText = result.enhanced;
    ctx.ui.setStatus(STATUS_KEY_REVERT_HINT, revertHintText());
    const enhanced = enhancedStatusText({
      rerolled: rerollingOriginal,
      autoEnhance: autoEnhanceEnabled,
    });
    const skipped = formatSkippedFiles(result.skippedFiles);
    showTransientStatus(ctx, skipped === undefined ? enhanced : `${enhanced} ${skipped}`);
    return;
  }

  // Neither outcome may cost the user their text.
  ctx.ui.setEditorText(editorRestoreText);

  if (result.reason === "cancelled") {
    // Esc is a decision, not a breakage: nothing stands down, nothing changes
    // except that this run stopped.
    if (lastOriginalPrompt !== undefined) {
      ctx.ui.setStatus(STATUS_KEY_REVERT_HINT, revertHintText());
    }
    showTransientStatus(ctx, "Cancelled.");
    return;
  }

  // A failure stands auto-enhance down for the rest of the session (session
  // state only — nothing is written to config). pi already spent four attempts
  // over ~14 s before calling it a failure, so one is enough evidence that the
  // next Enter should just send rather than walk into the same wait again.
  //
  // The message is said once; the widget losing its green `auto` block is what
  // keeps the new state on screen afterwards.
  autoEnhanceEnabled = false;
  clearTransientStatusTimer();
  if (lastOriginalPrompt !== undefined) {
    ctx.ui.setStatus(STATUS_KEY_REVERT_HINT, revertHintText());
  }
  updateWidget(ctx);
  // Hard failures stay as notifications — the user needs to see them loud.
  ctx.ui.notify(formatEnhancementFailure(result.message), "error");
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
  // Asked of the editor, not remembered: an edit made after the last enhance
  // never reached the model, so this is the only place it can be noticed.
  const laterEditsLost = !editorHoldsOurText(ctx.ui.getEditorText(), lastEnhancedText);
  lastOriginalPrompt = undefined;
  lastEnhancedText = undefined;
  ctx.ui.setEditorText(restored);
  ctx.ui.setStatus(STATUS_KEY_REVERT_HINT, undefined);
  showTransientStatus(ctx, revertStatusText(laterEditsLost));
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
    lastEnhancedText = undefined;
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
        lastEnhancedText = undefined;
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
