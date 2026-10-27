/**
 * drivers/cursor.ts — the `AgentDriver` seam (Locked Decision D10) for
 * **Cursor Agent CLI** (binary `cursor-agent`). Headless dispatch via
 * `cursor-agent -p`, never a permission-bypass flag (D2).
 *
 * Field/behavior notes below were confirmed by running `cursor-agent`
 * 2026.09.10-fd3934a / 2026.09.18-9a7762b directly (not just `--help` or vendor
 * docs) — re-verify after a CLI upgrade:
 *
 * ── Output envelope (`--output-format stream-json`) ──
 * NDJSON. Success is the last `{ type: "result", subtype: "success", is_error:
 * false, result }` line — the answer is `.result`, same field name as Claude.
 * `--verbose` is not a cursor-agent flag (error). `--stream-partial-output` hung
 * with empty stdout in a live probe, so it is omitted; assistant text still
 * arrives as whole `type:"assistant"` messages. Errors may set `is_error: true`
 * or use a `{ type: "error" }` shape; unparseable/empty stdout is treated as an
 * error (D6). The historical `--output-format json` single object is still parsed.
 *
 * ── System prompt ──
 * Cursor has no `--system-prompt-file` / `--system-prompt-override`. Persona +
 * skills are prepended to the user prompt (`replace`) or appended (`append`).
 *
 * ── Model ids ──
 * Listed ids only. Parameterized forms such as
 * `claude-opus-4-8[context=300k,effort=high]` are rejected.
 *
 * Cursor Agent encodes effort/thinking IN the listed `--model` id (unlike Claude
 * Code, which uses `--model claude-opus-5-5` + `--effort`). Account catalogs are
 * live (`cursor-agent --list-models`); the shapes below match Cursor's published
 * Opus 5.5 / Composer catalog and the prior live Opus 4.8 verify:
 * Relay ids are `claude-opus-4-8`, `claude-opus-5-5`, and `claude-sonnet-5-5`.
 * Pi thinking selects the listed id: Opus 4.8 medium is
 * `claude-opus-4-8-thinking-medium`. Opus 5.5 and Sonnet 5.5 medium are
 * `claude-opus-5-5-medium` and `claude-sonnet-5-5-medium` (no `-thinking-` infix
 * in `cursor-agent --list-models`). Fuzzy ids are rejected.
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
 * tty) — reproduced in #254 against cursor-agent 2026.09.10-fd3934a. Always seed
 * from the real config home (never a sparse dir). No-tools roles still seed so
 * they do not hang, and overlay fail-closed deny-Write so skipping
 * `CURSOR_CONFIG_DIR` cannot fall through to `~/.cursor` and create files.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type AgentDriver,
  type DriverInvocation,
  type DriverResult,
  findLastNdjsonResult,
} from "./claude.js";
import {
  clampToSupported,
  type PiThinkingLevel,
  parseModelThinking,
  piThinkingMap,
} from "./thinking.js";

/** Pi levels Opus 4.8 can express. `off` is the non-thinking listed id. */
const CURSOR_OPUS_48_LEVELS: readonly PiThinkingLevel[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Pi levels Opus 5.5 and Sonnet 5.5 can express. There is no off listed id. */
const CURSOR_EFFORT_LEVELS: readonly PiThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** Pi levels for Cursor models with no thinking axis (`auto`, Composer 2.5). */
const CURSOR_FIXED_LEVELS: readonly PiThinkingLevel[] = ["off"];

/** Catalog map for Opus 4.8. Pi thinking selects `claude-opus-4-8-thinking-<level>`. */
export const CURSOR_OPUS_48_THINKING_MAP = piThinkingMap(CURSOR_OPUS_48_LEVELS);

/** Catalog map for Opus 5.5 and Sonnet 5.5. Pi `off` is hidden and clamps to `low`. */
export const CURSOR_EFFORT_THINKING_MAP = piThinkingMap(CURSOR_EFFORT_LEVELS);

/** Catalog map for Cursor models whose listed id does not change with thinking. */
export const CURSOR_FIXED_THINKING_MAP = piThinkingMap(CURSOR_FIXED_LEVELS);

/**
 * Relay Cursor models. Claude family ids are the base id; Pi thinking selects the
 * listed `cursor-agent --list-models` id. Confirmed 2026.09.28-64d2043.
 */
export const CURSOR_LISTED_MODELS: readonly {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly thinkingLevelMap: Readonly<Record<PiThinkingLevel, string | null>>;
}[] = [
  {
    id: "auto",
    name: "Relay Cursor Auto",
    contextWindow: 200_000,
    maxTokens: 64_000,
    thinkingLevelMap: CURSOR_FIXED_THINKING_MAP,
  },
  {
    id: "composer-2.5",
    name: "Relay Cursor Composer 2.5",
    contextWindow: 200_000,
    maxTokens: 64_000,
    thinkingLevelMap: CURSOR_FIXED_THINKING_MAP,
  },
  {
    id: "claude-opus-4-8",
    name: "Relay Cursor Opus 4.8",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinkingLevelMap: CURSOR_OPUS_48_THINKING_MAP,
  },
  {
    id: "claude-opus-5-5",
    name: "Relay Cursor Opus 5.5",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinkingLevelMap: CURSOR_EFFORT_THINKING_MAP,
  },
  {
    id: "claude-sonnet-5-5",
    name: "Relay Cursor Sonnet 5.5",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinkingLevelMap: CURSOR_EFFORT_THINKING_MAP,
  },
];

/**
 * Pi thinking → listed Opus 4.8 id. `cursor-agent --list-models` has
 * `claude-opus-4-8-thinking-<level>`. Pi `off` is the non-thinking listed id
 * `claude-opus-4-8-high`. `minimal` has no row and clamps to thinking-low.
 */
const CURSOR_OPUS_48_BY_THINKING: Readonly<Record<PiThinkingLevel, string>> = {
  off: "claude-opus-4-8-high",
  minimal: "claude-opus-4-8-thinking-low",
  low: "claude-opus-4-8-thinking-low",
  medium: "claude-opus-4-8-thinking-medium",
  high: "claude-opus-4-8-thinking-high",
  xhigh: "claude-opus-4-8-thinking-xhigh",
  max: "claude-opus-4-8-thinking-max",
};

/**
 * Pi thinking → listed Opus 5.5 id. The live list has `claude-opus-5-5-<level>`,
 * not `claude-opus-5-5-thinking-<level>`. Pi `off` and `minimal` clamp to `low`.
 */
const CURSOR_OPUS_55_BY_THINKING: Readonly<Record<PiThinkingLevel, string>> = {
  off: "claude-opus-5-5-low",
  minimal: "claude-opus-5-5-low",
  low: "claude-opus-5-5-low",
  medium: "claude-opus-5-5-medium",
  high: "claude-opus-5-5-high",
  xhigh: "claude-opus-5-5-xhigh",
  max: "claude-opus-5-5-max",
};

/**
 * Pi thinking → listed Sonnet 5.5 id. The live list has `claude-sonnet-5-5-<level>`,
 * not a `-thinking-` infix. Pi `off` and `minimal` clamp to `low`.
 */
const CURSOR_SONNET_55_BY_THINKING: Readonly<Record<PiThinkingLevel, string>> = {
  off: "claude-sonnet-5-5-low",
  minimal: "claude-sonnet-5-5-low",
  low: "claude-sonnet-5-5-low",
  medium: "claude-sonnet-5-5-medium",
  high: "claude-sonnet-5-5-high",
  xhigh: "claude-sonnet-5-5-xhigh",
  max: "claude-sonnet-5-5-max",
};

/** Exact `--model` values this driver may emit, also accepted verbatim on input. */
const CURSOR_EMITTED_IDS: ReadonlySet<string> = new Set([
  "auto",
  "composer-2.5",
  ...Object.values(CURSOR_OPUS_48_BY_THINKING),
  ...Object.values(CURSOR_OPUS_55_BY_THINKING),
  ...Object.values(CURSOR_SONNET_55_BY_THINKING),
]);

/**
 * Resolve a pi model id to the Cursor CLI `--model` value.
 *
 * `relay-cursor/claude-opus-4-8` plus Pi thinking `medium` is sent as
 * `claude-opus-4-8-thinking-medium`. Opus 5.5 and Sonnet 5.5 use the listed
 * `<id>-<level>` form. Fuzzy ids are not rewritten.
 */
export function resolveCursorModel(piId: string, thinking?: PiThinkingLevel): string {
  const parsed = parseModelThinking(piId);
  const requested = thinking ?? parsed.thinking;
  const id = parsed.bareId;
  if (id === "auto" || id === "composer-2.5") return id;
  if (id === "claude-opus-4-8") {
    return CURSOR_OPUS_48_BY_THINKING[clampToSupported(requested, CURSOR_OPUS_48_LEVELS)];
  }
  if (id === "claude-opus-5-5") {
    return CURSOR_OPUS_55_BY_THINKING[clampToSupported(requested, CURSOR_EFFORT_LEVELS)];
  }
  if (id === "claude-sonnet-5-5") {
    return CURSOR_SONNET_55_BY_THINKING[clampToSupported(requested, CURSOR_EFFORT_LEVELS)];
  }
  if (CURSOR_EMITTED_IDS.has(id)) return id;
  throw new Error(
    `relay-cursor: \`${piId}\` is not a supported relay-cursor model. ` +
      `Use auto, composer-2.5, claude-opus-4-8, claude-opus-5-5, or claude-sonnet-5-5.`,
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

/** The JSON envelope emitted by `cursor-agent -p --output-format stream-json`. */
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
 * `cursor-agent -p`, `--output-format stream-json`, `--trust`, never `--force` /
 * `--yolo` / `--sandbox` / `--stream-partial-output`.
 */
export const cursorDriver: AgentDriver = {
  name: "cursor",
  bin: "cursor-agent",

  buildArgs(invocation: DriverInvocation): string[] {
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--model",
      resolveCursorModel(invocation.model, invocation.thinking),
      // Headless hang-avoidance for the workspace-trust prompt. Not a tool bypass.
      "--trust",
      buildPrompt(invocation),
    ];
  },

  env(invocation: DriverInvocation): Readonly<Record<string, string>> | undefined {
    // Always seed + overlay. Sparse-only cli-config.json hangs on the first tool
    // call (#254). No-tools still gets a seeded home (no hang) and deny Write
    // (D2: do not fall through to ~/.cursor).
    return { CURSOR_CONFIG_DIR: writeCursorConfigDir(invocation) };
  },

  parseResult(stdout: string): DriverResult {
    const fromStream = findLastNdjsonResult(stdout);
    if (fromStream) {
      const text = String(fromStream.result ?? "");
      return { result: text, isError: fromStream.is_error === true || text.length === 0 };
    }

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
