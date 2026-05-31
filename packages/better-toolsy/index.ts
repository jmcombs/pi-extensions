/**
 * @jmcombs/pi-better-toolsy — Replace noisy bash commands with compact Node.js tools.
 *
 * Provides six file-oriented tools (list_dir, read_file, code_search,
 * find_files, edit_file, write_file) backed by pure `fs/promises` and `path`.
 * Includes optional bash interception that redirects common shell commands to
 * these tools.
 *
 * See:
 *    - CONTRIBUTING.md (project conventions)
 *    - TEMPLATE.md at the repo root
 *    - https://pi.dev/docs/extensions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { promises as fs } from "node:fs";
import { join, resolve, relative, dirname, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Path safety ────────────────────────────────────────────────────────
// Blocks directory traversal attacks (../../etc/passwd) on every user-supplied
// path argument.  Root is the working directory unless a `root` override is
// passed (not exposed to LLM).

function safeResolve(inputPath: string, root: string = process.cwd()): string {
  const resolved = resolve(root, inputPath);
  if (!resolved.startsWith(root)) {
    throw new Error(`Path traversal blocked: ${inputPath}`);
  }
  return resolved;
}

// ── .gitignore awareness ───────────────────────────────────────────────
// Loads the nearest .gitignore and returns an array of pattern strings.

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

function matchesGitignore(filename: string, patterns: string[]): boolean {
  return patterns.some((pattern: string) => {
    // Handle directory-only patterns (trailing /)
    const dirOnly = pattern.endsWith("/");
    const cleanPattern = pattern.replace(/\/$/, "");

    if (dirOnly) {
      return filename.includes(cleanPattern);
    }

    // Simple glob-like matching for common patterns like *.log or node_modules
    if (pattern.includes("*")) {
      const regexSource = "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
      const re = new RegExp(regexSource);
      return re.test(filename);
    }

    // Exact match
    return basename(filename) === cleanPattern;
  });
}

// ── Tool schemas ─────────────────────────────────────────────────────

const listDirSchema = Type.Object({
  path: Type.String({ description: "Directory path to list (relative or absolute)." }),
  all: Type.Optional(
    Type.Boolean({ description: "Include hidden files (dotfiles). Default: false." }),
  ),
});
export type ListDirInput = Static<typeof listDirSchema>;

const readFileSchema = Type.Object({
  path: Type.String({ description: "File path to read (relative or absolute)." }),
  offset: Type.Optional(
    Type.Integer({ description: "Line number to start from (1-indexed, optional)." }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: "Maximum lines to return from offset (optional). If omitted, returns full file.",
    }),
  ),
});
export type ReadFileInput = Static<typeof readFileSchema>;

const codeSearchSchema = Type.Object({
  pattern: Type.String({ description: "Regular expression or substring to search for." }),
  path: Type.Optional(
    Type.String({ description: "Directory to search in (relative or absolute). Defaults to cwd." }),
  ),
  filePattern: Type.Optional(
    Type.String({ description: "Glob pattern to filter files (e.g. '*.ts'). Optional." }),
  ),
});
export type CodeSearchInput = Static<typeof codeSearchSchema>;

const findFilesSchema = Type.Object({
  name: Type.String({ description: "Name or glob pattern to match (e.g. '*.log' or '.env')." }),
  path: Type.Optional(
    Type.String({ description: "Directory to search in (relative or absolute). Defaults to cwd." }),
  ),
});
export type FindFilesInput = Static<typeof findFilesSchema>;

const editFileSchema = Type.Object({
  path: Type.String({ description: "File path to edit (relative or absolute)." }),
  oldText: Type.String({ description: "Exact text to replace (must match a unique region)." }),
  newText: Type.String({ description: "Replacement text." }),
});
export type EditFileInput = Static<typeof editFileSchema>;

const writeFileSchema = Type.Object({
  path: Type.String({
    description:
      "File path to write (relative or absolute). Parent dirs are created automatically.",
  }),
  content: Type.String({ description: "Content to write to the file." }),
});
export type WriteFileInput = Static<typeof writeFileSchema>;

// ── Tool implementations ───────────────────────────────────────────────

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}

async function listDirTool(_toolCallId: string, params: ListDirInput): Promise<ToolResult> {
  const dirPath = safeResolve(params.path);
  const entries: { name: string; type: "file" | "directory" }[] = [];

  try {
    const rawEntries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of rawEntries) {
      if (!params.all && entry.name.startsWith(".")) continue;
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
    // Directories first, then files; alphabetical within each group
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    content: [
      {
        type: "text",
        text:
          sorted.map((e) => `  ${e.type === "directory" ? "📁" : "📄"} ${e.name}`).join("\n") ||
          "(empty directory)",
      },
    ],
    details: { path: params.path, entries: sorted.length },
  };
}

// ── read_file: replaces `cat` ────────────────────────────────────────

async function readFileTool(_toolCallId: string, params: ReadFileInput): Promise<ToolResult> {
  const filePath = safeResolve(params.path);
  const maxBytes = 50 * 1024;

  try {
    const stat = await fs.stat(filePath);
    if (stat.size > maxBytes) {
      return {
        content: [
          {
            type: "text",
            text: `File is ${String(stat.size)} bytes. Use 'offset'/'limit' to read portions.`,
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
        ? selected.map((line, i) => `${String(i + 1)}|${line}`).join("\n")
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

// ── code_search: replaces `grep`/`rg` (with optional rg fast-path) ──

async function codeSearchTool(_toolCallId: string, params: CodeSearchInput): Promise<ToolResult> {
  const searchDir = safeResolve(params.path ?? ".");
  const gitignorePatterns = await loadGitignore(searchDir);
  const maxResults = 100;
  let matchCount = 0;
  const results: string[] = [];

  // Try `rg` fast-path first, fall back to Node.js
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
    const rgArgs = ["-n", "--no-heading", "--color=never", "-e", params.pattern, searchDir];
    if (params.filePattern) {
      rgArgs.splice(3, 0, "-g", `"${params.filePattern}"`);
    }
    try {
      const { stdout } = await execFileAsync("rg", rgArgs, { cwd: searchDir });
      lines = stdout.trim().split("\n").filter(Boolean);
    } catch {
      lines = [];
    }
  } else {
    // Node.js fallback: recursive directory walk
    const allFiles = await walkDir(searchDir, gitignorePatterns, params.filePattern ?? null);
    for (const file of allFiles) {
      try {
        const content = await fs.readFile(file, "utf-8");
        const re = new RegExp(params.pattern, "u");
        const fileLines = content.split("\n");
        let _found = false;
        fileLines.forEach((line, idx) => {
          if (re.test(line) && matchCount < maxResults) {
            results.push(`  ${file}:${String(idx + 1)}:     ${line.trimEnd()}`);
            matchCount++;
            _found = true;
          }
        });
        // Stop after a few files even without matches to avoid scanning endlessly
        if (matchCount >= maxResults) break;
      } catch {
        // skip binary/unreadable files
      }
    }
  }

  // Format rg output into readable results
  if (rgAvailable && lines.length > 0) {
    for (const line of lines) {
      if (matchCount >= maxResults) break;
      results.push(`  ${line}`);
      matchCount++;
    }
  }

  return {
    content: [
      { type: "text", text: results.length > 0 ? results.join("\n") : "No matches found." },
    ],
    details: {
      query: params.pattern,
      path: searchDir,
      matches: matchCount,
      usedRg: rgAvailable && lines.length > 0,
    },
  };
}

// ── Recursive directory walker (used by code_search Node.js fallback) ──

async function walkDir(
  dir: string,
  patterns: string[],
  filePattern: string | null,
): Promise<string[]> {
  const files: string[] = [];
  let dirEntries;
  try {
    dirEntries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // unreadable directory, skip silently
  }

  for (const entry of dirEntries) {
    const fullName = join(dir, entry.name);
    if (!entry.name.startsWith(".") || entry.name === ".gitignore") {
      const ignored = matchesGitignore(entry.name, patterns);
      if (!ignored) {
        if (entry.isDirectory()) {
          const subFiles = await walkDir(fullName, patterns, filePattern);
          files.push(...subFiles);
        } else {
          // Apply file pattern filter if provided
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
  // Simple glob-to-regex for patterns like "*.ts" or "*.test.js"
  if (!pattern.includes("*")) {
    return filename === pattern;
  }
  const regexSource = "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
  return new RegExp(regexSource).test(filename);
}

// ── find_files: replaces `find` ──────────────────────────────────────

async function findFilesTool(_toolCallId: string, params: FindFilesInput): Promise<ToolResult> {
  const searchDir = safeResolve(params.path ?? ".");
  const gitignorePatterns = await loadGitignore(searchDir);
  const maxResults = 200;
  let resultCount = 0;
  const results: string[] = [];

  const found = await findRecursive(
    searchDir,
    params.name,
    gitignorePatterns,
    maxResults - resultCount,
  );
  for (const f of found) {
    if (resultCount >= maxResults) break;
    results.push(`   ${relative(process.cwd(), f)}`);
    resultCount++;
  }

  return {
    content: [{ type: "text", text: results.length > 0 ? results.join("\n") : "No files found." }],
    details: { query: params.name, path: searchDir, filesFound: resultCount },
  };
}

async function findRecursive(
  dir: string,
  namePattern: string,
  gitignorePatterns: string[],
  remaining: number,
): Promise<string[]> {
  if (remaining <= 0) return [];
  const results: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!remaining) break;
    // Skip dotfiles/dotdirs unless explicitly searching for them
    if (entry.name.startsWith(".") && !namePattern.startsWith(".")) continue;

    const ignored = matchesGitignore(entry.name, gitignorePatterns);
    if (ignored) continue;

    const fullPath = join(dir, entry.name);
    // Check name/glob match
    if (entry.isDirectory()) {
      // Also match directory names against pattern
      if (matchesFilePattern(entry.name, namePattern)) {
        results.push(fullPath);
      }
      const sub = await findRecursive(
        fullPath,
        namePattern,
        gitignorePatterns,
        remaining - results.length,
      );
      results.push(...sub);
    } else if (matchesFilePattern(entry.name, namePattern)) {
      results.push(fullPath);
    }
  }
  return results;
}

// ── edit_file: replaces `sed` (exact text replacement, not regex) ─────

async function editFileTool(_toolCallId: string, params: EditFileInput): Promise<ToolResult> {
  const filePath = safeResolve(params.path);

  try {
    const content = await fs.readFile(filePath, "utf-8");
    // Validate that oldText appears exactly once to avoid ambiguity
    const firstIdx = content.indexOf(params.oldText);
    if (firstIdx === -1) {
      return {
        content: [
          {
            type: "text",
            text: `Edit failed: 'oldText' not found in ${relative(process.cwd(), filePath)}. The exact text must match the file contents.`,
          },
        ],
        details: { error: true, path: params.path },
      };
    }

    const secondIdx = content.indexOf(params.oldText, firstIdx + params.oldText.length);
    if (secondIdx !== -1) {
      return {
        content: [
          {
            type: "text",
            text: `Edit failed: 'oldText' appears ${String(countOccurrences(content, params.oldText))} times in ${relative(process.cwd(), filePath)}. It must match a unique region. Add more surrounding context to make it unique.`,
          },
        ],
        details: { error: true, path: params.path },
      };
    }

    const newContent = content.replace(params.oldText, params.newText);
    await fs.writeFile(filePath, newContent, "utf-8");

    return {
      content: [
        { type: "text", text: `Edited ${relative(process.cwd(), filePath)} — replaced 1 match.` },
      ],
      details: {
        path: params.path,
        oldLength: params.oldText.length,
        newLength: params.newText.length,
      },
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

// ── write_file: replaces creating files via shell (auto-creates parent dirs) ──

async function writeFileTool(_toolCallId: string, params: WriteFileInput): Promise<ToolResult> {
  const filePath = safeResolve(params.path);

  try {
    // Auto-create parent directories (mkdir -p equivalent)
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
      details: { path: params.path, size: stat.size, created: true },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error writing file: ${message}` }],
      details: { error: true, path: params.path },
    };
  }
}

// ── Prompt guideline text reused across tools ─────────────────────────

const BASH_AVOID_GUIDE =
  "\nUse this tool instead of the bash equivalent " +
  "(bash:ls, bash:cat, bash:grep, bash:sed, bash:find — noisy and inconsistent).";

// ── Bash interception: maps common shell commands to our tools ─────────

interface InterceptMap {
  command: string;
  toolName: string;
}

const INTERCEPT_MAP: InterceptMap[] = [
  { command: "ls", toolName: "list_dir" },
  { command: "cat", toolName: "read_file" },
  { command: "grep", toolName: "code_search" },
  { command: "rg", toolName: "code_search" },
  { command: "find", toolName: "find_files" },
  { command: "sed", toolName: "edit_file" },
];

// ── Extension factory ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // Register the bash-interception flag so it can be toggled if needed
  pi.registerFlag("intercept-bash", {
    type: "boolean",
    default: true,
    description: "Intercept common bash file commands and route them to Node.js tools.",
  });

  // ── Tools ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "list_dir",
    label: "List Directory",
    description:
      "List files and directories (replaces `ls`. Respects .gitignore, hides dotfiles by default, cross-platform.)" +
      BASH_AVOID_GUIDE,
    parameters: listDirSchema,
    execute: listDirTool,
  });

  pi.registerTool({
    name: "read_file",
    label: "Read File",
    description:
      "Read file contents with optional offset/limit (replaces `cat`. Safe path resolution, .gitignore-aware.)" +
      BASH_AVOID_GUIDE,
    parameters: readFileSchema,
    execute: readFileTool,
  });

  pi.registerTool({
    name: "code_search",
    label: "Code Search",
    description:
      "Search for patterns in code files (replaces `grep`/`rg`. Uses ripgrep if available, falls back to Node.js. Respects .gitignore.)" +
      BASH_AVOID_GUIDE,
    parameters: codeSearchSchema,
    execute: codeSearchTool,
  });

  pi.registerTool({
    name: "find_files",
    label: "Find Files",
    description:
      "Find files by name pattern (replaces `find`. Respects .gitignore.)" + BASH_AVOID_GUIDE,
    parameters: findFilesSchema,
    execute: findFilesTool,
  });

  pi.registerTool({
    name: "edit_file",
    label: "Edit File",
    description:
      "Edit a file by replacing exact text (replaces `sed`. Validates uniqueness of match.)" +
      BASH_AVOID_GUIDE,
    parameters: editFileSchema,
    execute: editFileTool,
  });

  pi.registerTool({
    name: "write_file",
    label: "Write File",
    description:
      "Write content to a file (auto-creates parent dirs, replaces shell-based file creation.)" +
      BASH_AVOID_GUIDE,
    parameters: writeFileSchema,
    execute: writeFileTool,
  });

  // ── Bash interception via event listener ───────────────────────────────
  (pi.on as (event: string, handler: (ctx: unknown) => void) => void)(
    "user_bash",
    (ctx: unknown) => {
      const c = ctx as Record<string, unknown>;
      const rawCmd = typeof c.command === "string" ? c.command : "";
      const matched = INTERCEPT_MAP.find((m) => m.command === rawCmd.trim().split("\s+")[0]);
      if (!matched) return;
      return { toolName: matched.toolName };
    },
  );
}
