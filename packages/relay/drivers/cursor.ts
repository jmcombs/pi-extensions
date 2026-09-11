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
 * `claude-opus-4-8[context=300k,effort=high]` are rejected. Pi `opus` maps to
 * the listed id `claude-opus-4-8-high` ("Claude Opus 4.8 1M"). `auto` is
 * passed through. `resolveCursorModel` first strips the `relay-cursor/`
 * provider prefix and any pi thinking suffix (`:high`, `:off`, …) that pi
 * appends to the model id, since Cursor accepts neither; an id that does not
 * resolve to a listed id throws instead of being forwarded to `--model`.
 *
 * ── Tool/permission model ──
 * `--print` has access to all tools, including write and shell. `--force` /
 * `--yolo` is the Cursor analogue of `--dangerously-skip-permissions` and is
 * NEVER passed (D2). `--sandbox` is NEVER passed (D12). `--trust` is passed so
 * headless runs do not hang on the workspace-trust prompt (not a tool bypass).
 *
 * Cursor has no `--allowedTools` argv flag. Permissions live in
 * `~/.cursor/cli-config.json` / `<project>/.cursor/cli.json`. To scope a run
 * without mutating the workspace, `env()` writes a temp `cli-config.json` with
 * mapped allow/deny rules and points `CURSOR_CONFIG_DIR` at it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver, DriverInvocation, DriverResult } from "./claude.js";

/** Pi model id → Cursor `--model` id. */
export const CURSOR_MODEL_MAP: Readonly<Record<string, string>> = {
  auto: "auto",
  opus: "claude-opus-4-8-high",
};

/** The Cursor `--model` values this driver may emit, accepted verbatim on input. */
const CURSOR_LISTED_IDS: ReadonlySet<string> = new Set(Object.values(CURSOR_MODEL_MAP));

/** A leading `<provider>/` segment, e.g. the `relay-cursor/` in `relay-cursor/opus`. */
const PROVIDER_PREFIX = /^[^/]*\//;

/** A pi thinking level appended to the model id, e.g. the `:high` in `opus:high`. */
const PI_THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;

/**
 * Resolve a pi model id to the Cursor CLI `--model` value.
 *
 * Pi hands the driver the model string as written in the role file, which may
 * carry the `relay-cursor/` provider prefix and/or a pi thinking level
 * (`relay-cursor/opus:high`). Cursor's `--model` accepts neither, so both are
 * stripped before the lookup. An id that is still unrecognized throws here
 * rather than reaching `--model`, where Cursor would reject it after the run
 * has already been dispatched.
 */
export function resolveCursorModel(piId: string): string {
  const id = piId.trim().toLowerCase().replace(PROVIDER_PREFIX, "").replace(PI_THINKING_SUFFIX, "");
  const mapped = CURSOR_MODEL_MAP[id];
  if (mapped) return mapped;
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

function writeCursorConfigDir(invocation: DriverInvocation): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-relay-cursor-config-"));
  const tools = invocation.tools ?? [];
  const config = {
    version: 1,
    approvalMode: "allowlist",
    permissions: {
      allow: mapAllowRules(tools),
      deny: mapDenyRules(tools),
    },
  };
  fs.writeFileSync(path.join(dir, "cli-config.json"), `${JSON.stringify(config, null, 2)}\n`, {
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
      resolveCursorModel(invocation.model),
      // Headless hang-avoidance for the workspace-trust prompt. Not a tool bypass.
      "--trust",
      buildPrompt(invocation),
    ];
  },

  env(invocation: DriverInvocation): Readonly<Record<string, string>> {
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
