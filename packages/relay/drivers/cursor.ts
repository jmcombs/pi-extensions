/**
 * drivers/cursor.ts — the `AgentDriver` seam (Locked Decision D10) for
 * **Cursor Agent CLI** (binary `cursor-agent`). Headless dispatch via
 * `cursor-agent -p`, never a permission-bypass flag (D2).
 *
 * Field/behavior notes below were confirmed by running `cursor-agent`
 * 2026.09.10-fd3934a directly (not just its `--help` text or vendor docs) —
 * re-verify after a CLI upgrade:
 *
 * ── Output envelope (`--output-format json`) ──
 * Success: `{ type: "result", subtype: "success", is_error: false, result }` —
 * the answer is `.result`, same field name as Claude. Errors may set
 * `is_error: true` or use a `{ type: "error" }` shape; unparseable/empty
 * stdout is treated as an error (D6).
 *
 * ── System prompt ──
 * Cursor has no `--system-prompt-file` / `--system-prompt-override`. Persona +
 * skills are prepended to the user prompt (`replace`) or appended (`append`).
 *
 * ── Model ids ──
 * Listed ids only. Parameterized forms such as
 * `claude-opus-4-8[context=300k,effort=high]` are rejected. Pi `opus` with
 * thinking off maps to `claude-opus-4-8-high`; Pi thinking `high` maps to
 * `claude-opus-4-8-thinking-high`. `auto` is passed through. `resolveCursorModel`
 * strips the `relay-cursor/` prefix and uses the Pi thinking suffix (`:high`,
 * `:off`, …) to pick the listed id; an id that does not resolve throws instead
 * of being forwarded to `--model`.
 *
 * ── Tool/permission model ──
 * `--print` has access to all tools, including write and shell. `--force` /
 * `--yolo` is the Cursor analogue of `--dangerously-skip-permissions` and is
 * NEVER passed (D2). `--sandbox` is NEVER passed (D12). `--trust` is passed so
 * headless runs do not hang on the workspace-trust prompt (not a tool bypass).
 *
 * Cursor has no `--allowedTools` argv flag. Permissions live in
 * `~/.cursor/cli-config.json` / `<project>/.cursor/cli.json`. To scope a run
 * without mutating the workspace, `env()` copies the user's Cursor config *home*
 * (top-level files only) into a temp dir, overlays mapped allow/deny rules on
 * `cli-config.json`, and points `CURSOR_CONFIG_DIR` at that dir. A temp dir that
 * contains only the generated `cli-config.json` makes `cursor-agent -p` hang on
 * the first tool call until relay's wall-cap (empty pipes; the wait is on the
 * tty). When the role declared no tools, `env()` is a no-op so we do not replace
 * the user's config home with an empty allowlist.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver, DriverInvocation, DriverResult } from "./claude.js";
import { type PiThinkingLevel, parseModelThinking } from "./thinking.js";

/** Pi model id → Cursor `--model` id when thinking is off. */
export const CURSOR_MODEL_MAP: Readonly<Record<string, string>> = {
  auto: "auto",
  opus: "claude-opus-4-8-high",
};

/**
 * Pi thinking → Cursor listed Opus 4.8 id. Thinking is encoded in the listed
 * `--model` id (`…-thinking-high`), not a separate flag. `off` is effort-high
 * without thinking. `minimal` has no Cursor row and clamps to thinking-low.
 * `-fast` variants are unused (Pi has no fast axis).
 */
export const CURSOR_OPUS_BY_THINKING: Readonly<Record<PiThinkingLevel, string>> = {
  off: "claude-opus-4-8-high",
  minimal: "claude-opus-4-8-thinking-low",
  low: "claude-opus-4-8-thinking-low",
  medium: "claude-opus-4-8-thinking-medium",
  high: "claude-opus-4-8-thinking-high",
  xhigh: "claude-opus-4-8-thinking-xhigh",
  max: "claude-opus-4-8-thinking-max",
};

/** The Cursor `--model` values this driver may emit, accepted verbatim on input. */
const CURSOR_LISTED_IDS: ReadonlySet<string> = new Set([
  ...Object.values(CURSOR_MODEL_MAP),
  ...Object.values(CURSOR_OPUS_BY_THINKING),
]);

/**
 * Resolve a pi model id to the Cursor CLI `--model` value.
 *
 * Pi hands the driver the model string as written in the role file, which may
 * carry the `relay-cursor/` provider prefix and/or a pi thinking level
 * (`relay-cursor/opus:high`). Cursor's `--model` accepts listed ids only, so the
 * prefix is stripped and the thinking level selects the matching listed id
 * (`opus:high` → `claude-opus-4-8-thinking-high`). `auto` is passed through
 * unchanged (no thinking-encoded listed ids). An id that does not resolve to a
 * listed id throws here rather than reaching `--model`.
 */
export function resolveCursorModel(piId: string, thinking?: PiThinkingLevel): string {
  const parsed = parseModelThinking(piId);
  const level = thinking ?? parsed.thinking ?? "off";
  const id = parsed.bareId;
  if (id === "auto") return "auto";
  if (id === "opus") return CURSOR_OPUS_BY_THINKING[level];
  if (CURSOR_LISTED_IDS.has(id)) return id;
  throw new Error(
    `relay-cursor: \`${piId}\` is not a supported relay-cursor model. ` +
      `Use one of: ${Object.keys(CURSOR_MODEL_MAP).join(", ")}.`,
  );
}

/**
 * pi tool name → Cursor permission rules. Cursor's allowlist uses `Read` /
 * `Write` / `Shell` globs, not Claude-style tool names. This map is a DRIVER
 * function (D10). pi-only tools with no Cursor equivalent are absent and get
 * dropped.
 */
export const CURSOR_TOOL_PERMISSION_MAP: Readonly<Record<string, readonly string[]>> = {
  read: ["Read(**/*)"],
  bash: ["Shell(*)"],
  edit: ["Write(**/*)"],
  write: ["Write(**/*)"],
  grep: ["Read(**/*)"],
  find: ["Read(**/*)"],
};

/** Map a single pi tool name to Cursor permission rules, or `[]` if none. */
export function mapToolPermissions(piName: string): readonly string[] {
  return CURSOR_TOOL_PERMISSION_MAP[piName.trim().toLowerCase()] ?? [];
}

/**
 * Map pi tool names to Cursor `permissions.allow` rules, dropping pi-only
 * tools and de-duplicating while preserving order.
 */
export function mapAllowRules(piNames: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of piNames) {
    for (const rule of mapToolPermissions(name)) {
      if (!out.includes(rule)) out.push(rule);
    }
  }
  return out;
}

/**
 * Deny writes when the role did not declare `edit` / `write`. Deny takes
 * precedence over allow, so a read-only role cannot apply writes even if the
 * model tries.
 */
export function mapDenyRules(piNames: readonly string[]): string[] {
  const declared = new Set(piNames.map((name) => name.trim().toLowerCase()));
  if (declared.has("edit") || declared.has("write")) return [];
  return ["Write(**/*)"];
}

/** The JSON envelope emitted by `cursor-agent -p --output-format json`. */
export interface CursorResultEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  message?: string;
}

function buildPrompt(invocation: DriverInvocation): string {
  if (!invocation.systemPromptFile) return invocation.task;
  const content = fs.readFileSync(invocation.systemPromptFile, "utf8").trim();
  if (content.length === 0) return invocation.task;
  if (invocation.systemPromptMode === "append") {
    return `${invocation.task}\n\n${content}`;
  }
  return `${content}\n\n${invocation.task}`;
}

/** Prefix of the temp config home `env()` writes; the provider cleans these up. */
export const CURSOR_CONFIG_TEMP_PREFIX = "pi-relay-cursor-config-";

/** Skip oversized caches when seeding a temp Cursor config home. */
const CURSOR_SEED_MAX_FILE_BYTES = 5 * 1024 * 1024;

function cursorConfigSourceDir(): string {
  return process.env.CURSOR_CONFIG_DIR ?? path.join(os.homedir(), ".cursor");
}

function readJsonObject(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or invalid JSON — start from an empty object.
  }
  return {};
}

/** Copy top-level files from the user's Cursor config home into `destDir`. */
function seedCursorConfigHome(sourceDir: string, destDir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const from = path.join(sourceDir, entry.name);
    const to = path.join(destDir, entry.name);
    try {
      const st = fs.statSync(from);
      if (st.size > CURSOR_SEED_MAX_FILE_BYTES) continue;
      fs.copyFileSync(from, to);
    } catch {
      // Skip unreadable / raced entries.
    }
  }
}

function writeCursorConfigDir(invocation: DriverInvocation): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), CURSOR_CONFIG_TEMP_PREFIX));
  seedCursorConfigHome(cursorConfigSourceDir(), dir);
  const tools = invocation.tools ?? [];
  const configPath = path.join(dir, "cli-config.json");
  const config = readJsonObject(configPath);
  config.version = 1;
  config.approvalMode = "allowlist";
  config.permissions = {
    allow: mapAllowRules(tools),
    deny: mapDenyRules(tools),
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  return dir;
}

/**
 * `AgentDriver` implementation for Cursor Agent CLI: headless dispatch via
 * `cursor-agent -p`, `--output-format json`, `--trust`, never `--force` /
 * `--yolo` / `--sandbox`.
 */
export const cursorDriver: AgentDriver = {
  name: "cursor",
  bin: "cursor-agent",

  buildArgs(invocation: DriverInvocation): string[] {
    return [
      "-p",
      "--output-format",
      "json",
      "--model",
      resolveCursorModel(invocation.model, invocation.thinking),
      // Headless hang-avoidance for the workspace-trust prompt. Not a tool bypass.
      "--trust",
      buildPrompt(invocation),
    ];
  },

  env(invocation: DriverInvocation): Readonly<Record<string, string>> | undefined {
    // No declared tools → do not replace the user's config home with an empty
    // allowlist. That sparse overlay hangs `cursor-agent -p` on the first tool.
    if (invocation.tools === undefined || invocation.tools.length === 0) return undefined;
    return { CURSOR_CONFIG_DIR: writeCursorConfigDir(invocation) };
  },

  parseResult(stdout: string): DriverResult {
    let envelope: CursorResultEnvelope;
    try {
      envelope = JSON.parse(stdout) as CursorResultEnvelope;
    } catch {
      // Unparseable stdout (truncated/empty/non-JSON) is treated as an error
      // with no result — the caller's fail-safe (D6) then reports UNVERIFIED.
      return { result: "", isError: true };
    }

    if (envelope.type === "error") {
      return { result: String(envelope.message ?? envelope.result ?? ""), isError: true };
    }

    const text = typeof envelope.result === "string" ? envelope.result : "";
    const isError = envelope.is_error === true || text.length === 0;
    return { result: text, isError };
  },
};
