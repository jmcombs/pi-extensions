/**
 * @jmcombs/pi-better-toolsy — Drop-in replacements for Pi's built-in file tools.
 *
 * Overrides ls, read, grep, find, edit, and write with Node.js implementations
 * that add: .gitignore awareness, path-traversal protection, $ injection-safe
 * edits, normalized search paths, and a file-size guard on reads.
 *
 * See:
 *    - CONTRIBUTING.md (project conventions)
 *    - TEMPLATE.md at the repo root
 *    - https://pi.dev/docs/extensions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { promises as fs } from "node:fs";
import { sep, join, resolve, relative, dirname, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Path safety ────────────────────────────────────────────────────────
// Blocks directory traversal attacks (../../etc/passwd) on every user-supplied
// path argument.  Root is the working directory unless a `root` override is
// passed (not exposed to LLM).

export function safeResolve(inputPath: string, root: string = process.cwd()): string {
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
      const reSource =
        "^" +
        pat
          .replace(/\./g, "\\.")
          .replace(/\*\*/g, "\x00")
          .replace(/\*/g, "[^/]*")
          .replace(/\x00/g, ".*") +
        "$";
      try {
        return new RegExp(reSource).test(relPath);
      } catch {
        return false;
      }
    }

    if (dirOnly) return name === pat;

    if (pat.includes("*")) {
      const reSource = "^" + pat.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
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

const editSchema = Type.Object({
  path: Type.String({ description: "File path to edit (relative or absolute)." }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({ description: "Exact text to replace (must appear exactly once)." }),
      newText: Type.String({ description: "Replacement text." }),
    }),
    {
      description:
        "Edits to apply in sequence. Each oldText must be unique in the file at the time it is applied.",
    },
  ),
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
    if (stat.size > maxBytes) {
      return {
        content: [
          {
            type: "text",
            text: `File is ${String(stat.size)} bytes. Use offset/limit to read portions.`,
          },
        ],
        details: { path: params.path, size: stat.size },
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

    const output =
      params.offset != null || params.limit != null
        ? selected.map((line, i) => `${String(i + (params.offset ?? 1))}|${line}`).join("\n")
        : raw;

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
  let dirEntries;
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
  const regexSource = "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
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
  let entries;
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

export async function editTool(_toolCallId: string, params: EditInput): Promise<ToolResult> {
  const filePath = safeResolve(params.path);

  try {
    let content = await fs.readFile(filePath, "utf-8");

    // Validate uniqueness and apply each edit in sequence so later edits see
    // earlier ones (allows dependent edits in one call).
    for (const edit of params.edits) {
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
          text: `Edited ${relative(process.cwd(), filePath)} — applied ${String(params.edits.length)} edit${params.edits.length === 1 ? "" : "s"}.`,
        },
      ],
      details: { path: params.path, edits: params.edits.length },
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
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
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

// ── Extension factory ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ls",
    label: "List Directory",
    description: "List files and directories. Respects .gitignore, hides dotfiles.",
    parameters: lsSchema,
    execute: lsTool,
  });

  pi.registerTool({
    name: "read",
    label: "Read File",
    description:
      "Read file contents with optional offset/limit. Guards against large files (50 KB cap).",
    parameters: readSchema,
    execute: readTool,
  });

  pi.registerTool({
    name: "grep",
    label: "Search",
    description:
      "Search for patterns in code files. Uses ripgrep if available, falls back to Node.js. Respects .gitignore.",
    parameters: grepSchema,
    execute: grepTool,
  });

  pi.registerTool({
    name: "find",
    label: "Find Files",
    description: "Find files by name pattern. Respects .gitignore.",
    parameters: findSchema,
    execute: findTool,
  });

  pi.registerTool({
    name: "edit",
    label: "Edit File",
    description:
      "Edit a file by replacing exact text. Each oldText must be unique. Supports multiple edits in one call.",
    parameters: editSchema,
    execute: editTool,
  });

  pi.registerTool({
    name: "write",
    label: "Write File",
    description: "Write content to a file. Creates parent directories automatically.",
    parameters: writeSchema,
    execute: writeTool,
  });
}
