/**
 * @jmcombs/pi-better-toolsy — Drop-in replacements for Pi's built-in file tools.
 *
 * Overrides ls, read, grep, find, edit, and write with Node.js implementations
 * that add: .gitignore awareness, path-traversal protection, $ injection-safe
 * edits, normalized search paths, and a file-size guard on reads.
 *
 * Also registers a `tool_call` hook that normalizes shell-unsafe `gh pr/issue/
 * release` bodies: a double-quoted --body/--title/--notes whose value contains
 * backticks or `$` is command-substituted by bash *inside the double quotes*,
 * silently garbling Markdown. The hook re-quotes such values as single-quoted
 * (expansion-safe) before the built-in bash tool runs. See makeGhBodySafe.
 *
 * See:
 *    - CONTRIBUTING.md (project conventions)
 *    - TEMPLATE.md at the repo root
 *    - https://pi.dev/docs/extensions
 */

import { execFile } from "node:child_process";
import { type Dirent, promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

const execFileAsync = promisify(execFile);

// ── Path safety ────────────────────────────────────────────────────────
// Blocks directory traversal attacks (../../etc/passwd) on every user-supplied
// path argument.  Root is the working directory unless a `root` override is
// passed (not exposed to LLM).

export function safeResolve(inputPath: string, root: string = process.cwd()): string {
  // Absolute paths are explicitly specified — path traversal attacks use relative
  // sequences like ../../etc/passwd, not absolute paths, so skip the check.
  if (isAbsolute(inputPath)) {
    return resolve(inputPath);
  }
  const resolved = resolve(root, inputPath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Path traversal blocked: ${inputPath}`);
  }
  return resolved;
}

// ── .gitignore awareness ───────────────────────────────────────────────

async function loadGitignore(baseDir: string): Promise<string[]> {
  const gitignoreFile = join(baseDir, ".gitignore");
  try {
    const raw = await fs.readFile(gitignoreFile, "utf-8");
    return raw
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

// relPath is the path relative to the root where the .gitignore lives (or just a
// basename for single-level calls like lsTool).  Supports path-based patterns
// (dist/**) as well as simple name/glob patterns.
function matchesGitignore(relPath: string, patterns: string[]): boolean {
  const name = basename(relPath);
  return patterns.some((raw: string) => {
    const dirOnly = raw.endsWith("/");
    const pat = raw.replace(/^\//, "").replace(/\/$/, "");

    if (pat.includes("/")) {
      // "dist/**" should also block the "dist" directory entry itself
      if (pat.endsWith("/**") && relPath === pat.slice(0, -3)) return true;
      // Convert glob wildcards in one pass so "**" → ".*" and a lone "*" →
      // "[^/]*" without a sentinel: the alternation matches "**" before "*".
      const reSource =
        "^" +
        pat.replace(/\./g, "\\.").replace(/\*\*|\*/g, (m) => (m === "**" ? ".*" : "[^/]*")) +
        "$";
      try {
        return new RegExp(reSource).test(relPath);
      } catch {
        return false;
      }
    }

    if (dirOnly) return name === pat;

    if (pat.includes("*")) {
      const reSource = `^${pat.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`;
      try {
        return new RegExp(reSource).test(name);
      } catch {
        return false;
      }
    }

    return name === pat;
  });
}

// ── Schemas — match Pi's built-in tool signatures exactly ─────────────

const lsSchema = Type.Object({
  path: Type.Optional(
    Type.String({ description: "Directory path to list (relative or absolute). Defaults to cwd." }),
  ),
  limit: Type.Optional(Type.Integer({ description: "Maximum number of entries to return." })),
});
export type LsInput = Static<typeof lsSchema>;

const readSchema = Type.Object({
  path: Type.String({ description: "File path to read (relative or absolute)." }),
  offset: Type.Optional(Type.Integer({ description: "Line number to start from (1-indexed)." })),
  limit: Type.Optional(
    Type.Integer({ description: "Maximum lines to return. If omitted, returns the full file." }),
  ),
});
export type ReadInput = Static<typeof readSchema>;

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Regular expression or substring to search for." }),
  path: Type.Optional(
    Type.String({ description: "Directory to search in (relative or absolute). Defaults to cwd." }),
  ),
  glob: Type.Optional(
    Type.String({ description: "Glob pattern to restrict files (e.g. '*.ts')." }),
  ),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search." })),
  literal: Type.Optional(
    Type.Boolean({ description: "Treat pattern as a literal string, not a regex." }),
  ),
  context: Type.Optional(
    Type.Integer({ description: "Lines of context to show around each match." }),
  ),
  limit: Type.Optional(Type.Integer({ description: "Maximum matches to return. Default: 100." })),
});
export type GrepInput = Static<typeof grepSchema>;

const findSchema = Type.Object({
  pattern: Type.String({ description: "Glob pattern to match (e.g. '*.log' or '.env')." }),
  path: Type.Optional(
    Type.String({ description: "Directory to search in (relative or absolute). Defaults to cwd." }),
  ),
  limit: Type.Optional(Type.Integer({ description: "Maximum results to return. Default: 200." })),
});
export type FindInput = Static<typeof findSchema>;

const editItemSchema = Type.Object({
  oldText: Type.String({ description: "Exact text to replace (must appear exactly once)." }),
  newText: Type.String({ description: "Replacement text." }),
});
type EditItem = Static<typeof editItemSchema>;

const editSchema = Type.Object({
  path: Type.String({ description: "File path to edit (relative or absolute)." }),
  // Accept either a native array or a JSON-encoded string so the tool recovers
  // gracefully when a model accidentally double-encodes the array as a string.
  edits: Type.Union([
    Type.Array(editItemSchema, {
      description:
        "Edits to apply in sequence. Each oldText must be unique in the file at the time it is applied. Pass this as a JSON array — do not stringify it.",
    }),
    Type.String({
      description:
        "JSON-encoded array of {oldText, newText} objects. Prefer passing the array directly.",
    }),
  ]),
});
export type EditInput = Static<typeof editSchema>;

const writeSchema = Type.Object({
  path: Type.String({
    description: "File path to write (relative or absolute). Parent dirs created automatically.",
  }),
  content: Type.String({ description: "Content to write to the file." }),
});
export type WriteInput = Static<typeof writeSchema>;

// ── Tool result type ───────────────────────────────────────────────────

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}

// ── ls ─────────────────────────────────────────────────────────────────

async function lsTool(_toolCallId: string, params: LsInput): Promise<ToolResult> {
  const dirPath = safeResolve(params.path ?? ".");
  const gitignorePatterns = await loadGitignore(dirPath);
  const entries: { name: string; type: "file" | "directory" }[] = [];

  try {
    const rawEntries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of rawEntries) {
      if (entry.name.startsWith(".")) continue;
      if (matchesGitignore(entry.name, gitignorePatterns)) continue;
      entries.push({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error listing directory: ${message}` }],
      details: { error: true, path: params.path },
    };
  }

  const sorted = entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const limit = params.limit ?? sorted.length;
  const capped = sorted.slice(0, limit);

  return {
    content: [
      {
        type: "text",
        text:
          capped.map((e) => (e.type === "directory" ? `${e.name}/` : e.name)).join("\n") ||
          "(empty)",
      },
    ],
    details: {
      path: params.path ?? ".",
      entries: capped.length,
      truncated: capped.length < sorted.length,
    },
  };
}

// ── read ───────────────────────────────────────────────────────────────

export async function readTool(_toolCallId: string, params: ReadInput): Promise<ToolResult> {
  const filePath = safeResolve(params.path);
  const maxBytes = 50 * 1024;

  try {
    const stat = await fs.stat(filePath);
    const wantsSlice = params.offset != null || params.limit != null;

    if (stat.size > maxBytes && !wantsSlice) {
      const totalLines = (await fs.readFile(filePath, "utf-8")).split("\n").length;
      return {
        content: [
          {
            type: "text",
            text: `File is ${String(stat.size)} bytes (${String(totalLines)} lines). Use offset/limit to read it in chunks, e.g. {offset: 1, limit: 400}.`,
          },
        ],
        details: { path: params.path, size: stat.size, totalLines },
      };
    }

    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw.split("\n");
    let selected = lines;

    if (params.offset != null) {
      const start = Math.max(0, params.offset - 1);
      selected =
        params.limit != null ? lines.slice(start, start + params.limit) : lines.slice(start);
    }

    const output = wantsSlice
      ? selected.map((line, i) => `${String(i + (params.offset ?? 1))}|${line}`).join("\n")
      : raw;

    if (Buffer.byteLength(output, "utf-8") > maxBytes) {
      return {
        content: [
          {
            type: "text",
            text: `Requested slice is ${String(Buffer.byteLength(output, "utf-8"))} bytes, over the ${String(maxBytes)}-byte cap. Narrow the range — try a smaller limit, e.g. {offset: ${String(params.offset ?? 1)}, limit: ${String(Math.max(1, Math.floor((selected.length * maxBytes) / Buffer.byteLength(output, "utf-8"))))}}.`,
          },
        ],
        details: { path: params.path, totalLines: lines.length, requestedLines: selected.length },
      };
    }

    return {
      content: [{ type: "text", text: output || "(empty file)" }],
      details: { path: params.path, totalLines: lines.length, returnedLines: selected.length },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error reading file: ${message}` }],
      details: { error: true, path: params.path },
    };
  }
}

// ── grep ───────────────────────────────────────────────────────────────

async function grepTool(_toolCallId: string, params: GrepInput): Promise<ToolResult> {
  const searchDir = safeResolve(params.path ?? ".");
  const gitignorePatterns = await loadGitignore(searchDir);
  const maxResults = params.limit ?? 100;
  let matchCount = 0;
  const results: string[] = [];

  const rgAvailable = await new Promise<boolean>((res) => {
    execFileAsync("rg", ["--version"], { cwd: searchDir })
      .then(() => {
        res(true);
      })
      .catch(() => {
        res(false);
      });
  });

  let lines: string[] = [];
  if (rgAvailable) {
    const rgArgs = ["-n", "--no-heading", "--color=never"];
    if (params.ignoreCase) rgArgs.push("-i");
    if (params.literal) rgArgs.push("-F");
    if (params.context != null) rgArgs.push("-C", String(params.context));
    if (params.glob) rgArgs.push("-g", params.glob);
    rgArgs.push("-e", params.pattern, searchDir);
    try {
      const { stdout } = await execFileAsync("rg", rgArgs, { cwd: searchDir });
      lines = stdout.trim().split("\n").filter(Boolean);
    } catch {
      lines = [];
    }
  } else {
    const allFiles = await walkDir(searchDir, gitignorePatterns, params.glob ?? null);
    const reFlags = params.ignoreCase ? "iu" : "u";
    const re = params.literal ? null : new RegExp(params.pattern, reFlags);
    for (const file of allFiles) {
      try {
        const content = await fs.readFile(file, "utf-8");
        const relFile = relative(process.cwd(), file);
        const fileLines = content.split("\n");
        fileLines.forEach((line, idx) => {
          const hit = re
            ? re.test(line)
            : params.ignoreCase
              ? line.toLowerCase().includes(params.pattern.toLowerCase())
              : line.includes(params.pattern);
          if (hit && matchCount < maxResults) {
            results.push(`  ${relFile}:${String(idx + 1)}:     ${line.trimEnd()}`);
            matchCount++;
          }
        });
        if (matchCount >= maxResults) break;
      } catch {
        // skip binary/unreadable files
      }
    }
  }

  if (rgAvailable && lines.length > 0) {
    for (const line of lines) {
      if (matchCount >= maxResults) break;
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const absPath = line.slice(0, colonIdx);
        const rest = line.slice(colonIdx);
        results.push(`  ${relative(process.cwd(), absPath)}${rest}`);
      } else {
        results.push(`  ${line}`);
      }
      matchCount++;
    }
  }

  return {
    content: [
      { type: "text", text: results.length > 0 ? results.join("\n") : "No matches found." },
    ],
    details: { query: params.pattern, path: searchDir, matches: matchCount, usedRg: rgAvailable },
  };
}

// ── Recursive directory walker (grep Node.js fallback) ─────────────────

async function walkDir(
  dir: string,
  patterns: string[],
  filePattern: string | null,
  rootDir: string = dir,
): Promise<string[]> {
  const files: string[] = [];
  let dirEntries: Dirent[];
  try {
    dirEntries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of dirEntries) {
    const fullName = join(dir, entry.name);
    if (!entry.name.startsWith(".") || entry.name === ".gitignore") {
      const relName = relative(rootDir, fullName);
      const ignored = matchesGitignore(relName, patterns);
      if (!ignored) {
        if (entry.isDirectory()) {
          const subFiles = await walkDir(fullName, patterns, filePattern, rootDir);
          files.push(...subFiles);
        } else {
          if (!filePattern || matchesFilePattern(entry.name, filePattern)) {
            files.push(fullName);
          }
        }
      }
    }
  }
  return files;
}

function matchesFilePattern(filename: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return filename === pattern;
  }
  const regexSource = `^${pattern.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`;
  return new RegExp(regexSource).test(filename);
}

// ── find ───────────────────────────────────────────────────────────────

async function findTool(_toolCallId: string, params: FindInput): Promise<ToolResult> {
  const searchDir = safeResolve(params.path ?? ".");
  const gitignorePatterns = await loadGitignore(searchDir);
  const maxResults = params.limit ?? 200;

  const found = await findRecursive(searchDir, params.pattern, gitignorePatterns);
  const capped = found.slice(0, maxResults);
  const results = capped.map((f) => `   ${relative(process.cwd(), f)}`);

  return {
    content: [{ type: "text", text: results.length > 0 ? results.join("\n") : "No files found." }],
    details: { query: params.pattern, path: searchDir, filesFound: results.length },
  };
}

async function findRecursive(
  dir: string,
  namePattern: string,
  gitignorePatterns: string[],
  rootDir: string = dir,
): Promise<string[]> {
  const results: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && !namePattern.startsWith(".")) continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(rootDir, fullPath);
    const ignored = matchesGitignore(relPath, gitignorePatterns);
    if (ignored) continue;

    if (entry.isDirectory()) {
      if (matchesFilePattern(entry.name, namePattern)) {
        results.push(fullPath);
      }
      const sub = await findRecursive(fullPath, namePattern, gitignorePatterns, rootDir);
      results.push(...sub);
    } else if (matchesFilePattern(entry.name, namePattern)) {
      results.push(fullPath);
    }
  }
  return results;
}

// ── edit ───────────────────────────────────────────────────────────────

type NormalizeResult = { ok: true; edits: EditItem[] } | { ok: false; error: string };

function normalizeEdits(raw: EditItem[] | string): NormalizeResult {
  if (Array.isArray(raw)) return { ok: true, edits: raw };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        error:
          "edits must be an array of {oldText, newText} objects — received a non-array JSON value. Pass the array directly.",
      };
    }
    return { ok: true, edits: parsed as EditItem[] };
  } catch {
    return {
      ok: false,
      error:
        "edits could not be parsed — pass the array directly as a JSON array, do not stringify it first.",
    };
  }
}

export async function editTool(_toolCallId: string, params: EditInput): Promise<ToolResult> {
  const filePath = safeResolve(params.path);

  const normalized = normalizeEdits(params.edits);
  if (!normalized.ok) {
    return {
      content: [{ type: "text", text: `Edit failed: ${normalized.error}` }],
      details: { error: true, path: params.path },
    };
  }
  const edits = normalized.edits;

  try {
    let content = await fs.readFile(filePath, "utf-8");

    // Validate uniqueness and apply each edit in sequence so later edits see
    // earlier ones (allows dependent edits in one call).
    for (const edit of edits) {
      const firstIdx = content.indexOf(edit.oldText);
      if (firstIdx === -1) {
        return {
          content: [
            {
              type: "text",
              text: `Edit failed: oldText not found in ${relative(process.cwd(), filePath)}.\n"${edit.oldText.slice(0, 80)}${edit.oldText.length > 80 ? "…" : ""}"`,
            },
          ],
          details: { error: true, path: params.path },
        };
      }

      const secondIdx = content.indexOf(edit.oldText, firstIdx + edit.oldText.length);
      if (secondIdx !== -1) {
        return {
          content: [
            {
              type: "text",
              text: `Edit failed: oldText appears ${String(countOccurrences(content, edit.oldText))} times in ${relative(process.cwd(), filePath)}. Add more surrounding context to make it unique.`,
            },
          ],
          details: { error: true, path: params.path },
        };
      }

      content =
        content.slice(0, firstIdx) + edit.newText + content.slice(firstIdx + edit.oldText.length);
    }

    await fs.writeFile(filePath, content, "utf-8");

    return {
      content: [
        {
          type: "text",
          text: `Edited ${relative(process.cwd(), filePath)} — applied ${String(edits.length)} edit${edits.length === 1 ? "" : "s"}.`,
        },
      ],
      details: { path: params.path, edits: edits.length },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error editing file: ${message}` }],
      details: { error: true, path: params.path },
    };
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// ── write ──────────────────────────────────────────────────────────────

async function writeTool(_toolCallId: string, params: WriteInput): Promise<ToolResult> {
  const filePath = safeResolve(params.path);

  try {
    const parentDir = dirname(filePath);
    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(filePath, params.content, "utf-8");
    const stat = await fs.stat(filePath);

    return {
      content: [
        {
          type: "text",
          text: `Wrote ${relative(process.cwd(), filePath)} (${String(stat.size)} bytes).`,
        },
      ],
      details: { path: params.path, size: stat.size },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error writing file: ${message}` }],
      details: { error: true, path: params.path },
    };
  }
}

// ── TUI rendering ──────────────────────────────────────────────────────
// Pi resolves a tool's renderCall/renderResult independently of its execute:
// overriding a built-in's execution does NOT override its rendering. Without
// these, Pi falls back to the built-in renderers for edit/write/read — which
// re-derive their own diff/preview from the call args and hide our output. We
// supply our own so the TUI reflects what better-toolsy actually did.

const DEFAULT_RESULT_LINES = 20;

// Stamped onto every tool-call header so it is unmistakable — and consistent —
// that better-toolsy handled the call, regardless of the tool or whether it
// succeeded or failed. Kept out of execute() output so it never reaches the
// model's context (and never corrupts file content returned by read).
const FINGERPRINT = "🔧 bt";

/** Header line for a tool call, e.g. "edit packages/foo.ts   🔧 bt". */
function renderToolHeader(tool: string, detail: string, theme: Theme): Component {
  const label = theme.fg("toolTitle", theme.bold(tool));
  const head = detail ? `${label} ${theme.fg("accent", detail)}` : label;
  return new Text(`${head}   ${theme.fg("muted", FINGERPRINT)}`, 0, 0);
}

/** Render our execute() text output, truncated unless the row is expanded. */
function renderToolResult(
  result: { content: readonly { type: string; text?: string }[] },
  isError: boolean,
  expanded: boolean,
  theme: Theme,
): Component {
  const full = result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  if (!full) {
    return new Container();
  }

  const lines = full.split("\n");
  const limit = expanded ? lines.length : DEFAULT_RESULT_LINES;
  const role = isError ? "error" : "toolOutput";
  let body = theme.fg(role, lines.slice(0, limit).join("\n"));

  const remaining = lines.length - limit;
  if (remaining > 0) {
    body += theme.fg(
      "muted",
      `\n… ${String(remaining)} more line${remaining === 1 ? "" : "s"} — expand to view`,
    );
  }
  return new Text(body, 0, 0);
}

// ── gh body sanitization ───────────────────────────────────────────────
// A double-quoted `gh … --body "…"` whose value contains backticks or `$` gets
// command-substituted by bash *inside the double quotes*, garbling Markdown PR/
// issue/release bodies. We re-quote such values as single-quoted (which disables
// ALL expansion), mirroring the fix a model applies by hand. Pure and fail-safe:
// any parse ambiguity leaves the command byte-for-byte untouched. Over-quoting a
// body is harmless (bodies never intend expansion); under-detecting just falls
// back to the status quo — so we only ever err on the safe side.

// Long/short flags whose value is free-form prose that must not shell-expand.
// Only honored inside a gh pr/issue/release command (see the segment walk in
// makeGhBodySafe), so a generic -n/-b/-t elsewhere (grep -n, sort -n) is never
// touched. Note: gh release uses --notes/-n, not --body.
const GH_BODY_FLAGS = new Set(["--body", "-b", "--title", "-t", "--notes", "-n"]);
const GH_SUBCOMMANDS = new Set(["pr", "issue", "release"]);
const COMMAND_SEPARATORS = new Set(["&&", "||", "|", ";"]);
const ATTACHED_FLAG = /^(--body|--title|--notes)=/;

// Map each flag alias to its canonical long name, so the visible message can
// report which flags were normalized (e.g. `-b` and `--body` both report
// `--body`). FLAG_ORDER gives a stable display order.
const CANONICAL_FLAG: Record<string, string> = {
  "--body": "--body",
  "-b": "--body",
  "--title": "--title",
  "-t": "--title",
  "--notes": "--notes",
  "-n": "--notes",
};
const FLAG_ORDER = ["--body", "--title", "--notes"];

type Word = { start: number; end: number; text: string };

/** POSIX-safe single-quoting: close, escaped-quote, reopen around each `'`. */
function singleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Split a command into shell words, respecting single/double quotes and
 * backslash escapes, recording each word's [start, end) span in the original
 * string. Returns null on unbalanced quoting so the caller leaves the command
 * alone (fail-safe).
 */
function tokenizeWords(cmd: string): Word[] | null {
  const words: Word[] = [];
  const n = cmd.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(cmd[i] as string)) i++;
    if (i >= n) break;
    const start = i;
    let quote: "none" | "single" | "double" = "none";
    while (i < n) {
      const c = cmd[i] as string;
      if (quote === "none") {
        if (/\s/.test(c)) break;
        if (c === "'") quote = "single";
        else if (c === '"') quote = "double";
        else if (c === "\\") i++; // skip the escaped char
      } else if (quote === "single") {
        if (c === "'") quote = "none";
      } else {
        if (c === "\\")
          i++; // inside "…", backslash escapes the next char
        else if (c === '"') quote = "none";
      }
      i++;
    }
    if (quote !== "none") return null; // unterminated quote
    words.push({ start, end: i, text: cmd.slice(start, i) });
  }
  return words;
}

/**
 * If `text` is exactly one double-quoted string (`"…"`), return its raw inner
 * content; otherwise null. The closing quote must be the final character, which
 * rejects the ambiguous `"… $(echo "x") …"` (nested quotes inside command
 * substitution) — bailing there rather than risk corrupting a valid command.
 */
function asDoubleQuoted(text: string): string | null {
  if (text.length < 2 || text[0] !== '"') return null;
  let i = 1;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i === text.length - 1 ? text.slice(1, i) : null;
    i++;
  }
  return null; // no closing quote
}

/** Un-apply the four escapes bash honors inside double quotes → literal text. */
function unescapeDoubleQuoted(inner: string): string {
  return inner.replace(/\\(["\\$`])/g, "$1");
}

/** True if `inner` has a backtick or `$` that bash would act on (unescaped). */
function hasUnescapedShellActive(inner: string): boolean {
  return /(?<!\\)[`$]/.test(inner);
}

/**
 * Re-quote shell-unsafe `gh pr/issue/release` --body/--title/--notes values as
 * single-quoted. Returns the (possibly) rewritten command, whether anything
 * changed, and the canonical long names of the flags that were normalized (for
 * the visible message). Never throws; on any ambiguity returns
 * `{ command, changed: false, flags: [] }`.
 */
export function makeGhBodySafe(command: string): {
  command: string;
  changed: boolean;
  flags: string[];
} {
  const words = tokenizeWords(command);
  if (!words) return { command, changed: false, flags: [] };

  // Walk simple-command segments (split on &&/||/|/;). Only act on flags inside
  // a segment whose command name is `gh` (or `…/gh`) and that names a pr/issue/
  // release subcommand — this is what keeps us off unrelated `-n/-b/-t`.
  const edits: { start: number; end: number; text: string }[] = [];
  const flagsSeen = new Set<string>();
  let cmdName: string | null = null;
  let cmdIsGh = false;
  let ghSubSeen = false;

  const considerValue = (flag: string, start: number, end: number, dq: string) => {
    if (!hasUnescapedShellActive(dq)) return;
    edits.push({ start, end, text: singleQuote(unescapeDoubleQuoted(dq)) });
    flagsSeen.add(CANONICAL_FLAG[flag] ?? flag);
  };

  for (let w = 0; w < words.length; w++) {
    const word = words[w] as Word;
    if (COMMAND_SEPARATORS.has(word.text)) {
      cmdName = null;
      cmdIsGh = false;
      ghSubSeen = false;
      continue;
    }
    if (cmdName === null) {
      cmdName = word.text;
      cmdIsGh = word.text === "gh" || word.text.endsWith("/gh");
      continue;
    }
    if (cmdIsGh && !ghSubSeen && GH_SUBCOMMANDS.has(word.text)) ghSubSeen = true;
    if (!cmdIsGh || !ghSubSeen) continue;

    // Attached form: --body="…"
    if (ATTACHED_FLAG.test(word.text)) {
      const eq = word.text.indexOf("=");
      const dq = asDoubleQuoted(word.text.slice(eq + 1));
      if (dq != null) considerValue(word.text.slice(0, eq), word.start + eq + 1, word.end, dq);
      continue;
    }
    // Separated form: --body "…"
    if (GH_BODY_FLAGS.has(word.text) && w + 1 < words.length) {
      const value = words[w + 1] as Word;
      if (!COMMAND_SEPARATORS.has(value.text)) {
        const dq = asDoubleQuoted(value.text);
        if (dq != null) considerValue(word.text, value.start, value.end, dq);
      }
    }
  }

  if (edits.length === 0) return { command, changed: false, flags: [] };
  // Apply right-to-left so earlier spans keep their original indices.
  edits.sort((a, b) => b.start - a.start);
  let out = command;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { command: out, changed: true, flags: FLAG_ORDER.filter((f) => flagsSeen.has(f)) };
}

// ── Extension factory ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ls",
    label: "List Directory",
    description: "List files and directories. Respects .gitignore, hides dotfiles.",
    parameters: lsSchema,
    execute: lsTool,
    renderCall: (args: LsInput, theme) => renderToolHeader("ls", args.path ?? ".", theme),
  });

  pi.registerTool({
    name: "read",
    label: "Read File",
    description:
      "Read file contents with optional offset/limit. Files over the 50 KB cap must be read in chunks via offset/limit.",
    parameters: readSchema,
    execute: readTool,
    renderCall: (args: ReadInput, theme, context) => {
      if (basename(args.path) === "SKILL.md" && !context.expanded) {
        const skillName = basename(dirname(args.path)) || basename(args.path);
        return new Text(
          theme.fg("customMessageLabel", "\x1b[1m[skill]\x1b[22m ") +
            theme.fg("customMessageText", skillName) +
            theme.fg("dim", " (ctrl+o to expand)"),
          0,
          0,
        );
      }
      return renderToolHeader("read", args.path, theme);
    },
    renderResult: (result, options, theme, context) => {
      if (basename(context.args.path) === "SKILL.md" && !options.expanded) {
        return new Container();
      }
      return renderToolResult(result, context.isError, options.expanded, theme);
    },
  });

  pi.registerTool({
    name: "grep",
    label: "Search",
    description:
      "Search for patterns in code files. Uses ripgrep if available, falls back to Node.js. Respects .gitignore.",
    parameters: grepSchema,
    execute: grepTool,
    renderCall: (args: GrepInput, theme) =>
      renderToolHeader("grep", args.path ? `${args.pattern} in ${args.path}` : args.pattern, theme),
  });

  pi.registerTool({
    name: "find",
    label: "Find Files",
    description: "Find files by name pattern. Respects .gitignore.",
    parameters: findSchema,
    execute: findTool,
    renderCall: (args: FindInput, theme) =>
      renderToolHeader("find", args.path ? `${args.pattern} in ${args.path}` : args.pattern, theme),
  });

  pi.registerTool({
    name: "edit",
    label: "Edit File",
    description:
      "Edit a file by replacing exact text. Each oldText must be unique. Supports multiple edits in one call.",
    parameters: editSchema,
    execute: editTool,
    renderCall: (args: EditInput, theme) => renderToolHeader("edit", args.path, theme),
    renderResult: (result, options, theme, context) =>
      renderToolResult(result, context.isError, options.expanded, theme),
  });

  pi.registerTool({
    name: "write",
    label: "Write File",
    description: "Write content to a file. Creates parent directories automatically.",
    parameters: writeSchema,
    execute: writeTool,
    renderCall: (args: WriteInput, theme) => renderToolHeader("write", args.path, theme),
    renderResult: (result, options, theme, context) =>
      renderToolResult(result, context.isError, options.expanded, theme),
  });

  // Rewrite shell-unsafe `gh …--body/--title/--notes` before the built-in bash
  // tool runs. `event.input` is mutable in place (Pi re-runs no validation), so
  // we patch `command` directly. Fully defensive: any error leaves it untouched.
  pi.on("tool_call", (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    try {
      const { command, changed, flags } = makeGhBodySafe(event.input.command);
      if (!changed) return;
      event.input.command = command;

      // Report which flags were normalized (falls back to the full list if,
      // defensively, none were captured). `${flagList} → single-quoted form`.
      const flagList = flags.length > 0 ? flags.join(", ") : "--body/--title/--notes";
      const detail = `normalized shell-unsafe gh ${flagList} → single-quoted form`;

      // Surface in-session with the same 🔧 bt signature every other
      // better-toolsy tool stamps (ctx.ui.notify is a plain-text toast, so we
      // prefix the FINGERPRINT constant rather than a themed badge). Guarded by
      // hasUI so headless/CI runs skip the toast but still get the log below.
      if (ctx?.hasUI) ctx.ui.notify(`${FINGERPRINT} ${detail}`, "info");
      // Always logged for non-interactive / CI runs.
      console.error(`[better-toolsy] ${detail}`);
    } catch {
      // fail-safe: never mutate the command on error
    }
  });
}
