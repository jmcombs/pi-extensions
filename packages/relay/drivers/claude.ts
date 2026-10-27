/**
 * drivers/claude.ts — the driver/adapter seam (Locked Decision D10).
 *
 * `AgentDriver` is the backend-agnostic interface the relay provider dispatches
 * through: it knows how to name the backend binary, build its argv from a
 * standardized {@link DriverInvocation}, and pull the raw text result out of the
 * backend's stdout envelope. `claudeDriver` is the primary implementation —
 * headless subscription Opus via `claude -p` (`oauthAccount`, D1).
 *
 * Per D10, NO verdict parsing lives here. The driver only surfaces the backend's
 * `.result` text and its own error flag; interpreting that text (e.g. a
 * `VERDICT: PASS|FAIL` line) is the caller's job.
 *
 * D2 is preserved structurally: the driver always passes a SCOPED `--allowedTools`
 * rule list and NEVER `--dangerously-skip-permissions` or `--permission-mode
 * bypassPermissions`. Headless runs do not wait on a person: `--permission-mode
 * dontAsk` denies anything not pre-approved, and `--permission-prompts none`
 * denies a leftover print-mode prompt instead of waiting on a host. The verify
 * role supplies a read-only tool set (pi `read, bash, grep, find`); the driver
 * maps those to Claude permission rules (`Read,Bash(*),Grep,Glob`).
 *
 * ── Tool-name map lives HERE (D10) ──
 * Mapping pi's neutral tool names to a backend's tool names is a DRIVER concern,
 * not the resolver's. `claudeDriver` maps them to Claude permission rules
 * (`bash` → `Bash(*)`, not bare `Bash`); a future `codexDriver` maps the same
 * neutral list to its sandbox (`-s`).
 */

import {
  clampToSupported,
  type PiThinkingLevel,
  parseModelThinking,
  piThinkingMap,
} from "./thinking.js";

/** Pi levels Opus 4.8 can express. `off` omits `--effort` (Claude has no off flag). */
const CLAUDE_EFFORT_LEVELS: readonly PiThinkingLevel[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Pi levels for models that reject disabled thinking (Opus 5.5, Sonnet 5.5,
 * Haiku 5.5). `off` is hidden; a session left on off clamps to `low`.
 */
const CLAUDE_EFFORT_NO_OFF: readonly PiThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** Catalog map for Claude models that can omit `--effort` on Pi `off`. */
export const CLAUDE_THINKING_MAP = piThinkingMap(CLAUDE_EFFORT_LEVELS);

/** Catalog map for Claude models that reject disabled thinking. */
export const CLAUDE_THINKING_MAP_NO_OFF = piThinkingMap(CLAUDE_EFFORT_NO_OFF);

/** Exact Claude Code ids relay sends. Anything else fails. */
const CLAUDE_MODEL_IDS: ReadonlySet<string> = new Set([
  "claude-opus-4-8",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]);

/** Backend ids whose model card sets `rejects_disabled_thinking`. */
const CLAUDE_REJECTS_DISABLED_THINKING: ReadonlySet<string> = new Set([
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]);

/**
 * Pi levels this Claude `--model` id can express. Unknown ids return `undefined`
 * so a passthrough id is not clamped onto a family it may not belong to.
 */
export function claudeSupportedLevels(backendId: string): readonly PiThinkingLevel[] | undefined {
  if (backendId === "claude-opus-4-8") return CLAUDE_EFFORT_LEVELS;
  if (CLAUDE_REJECTS_DISABLED_THINKING.has(backendId)) return CLAUDE_EFFORT_NO_OFF;
  return undefined;
}

function unsupportedClaudeModel(piId: string): Error {
  return new Error(
    `relay-claude: \`${piId}\` is not a supported relay-claude model. ` +
      `Use the exact Claude model id. Unversioned aliases and partial ids are not relay models.`,
  );
}

/**
 * Resolve a pi model id to the Claude Code `--model` value.
 *
 * Strips a provider prefix and thinking suffix, then sends the bare id only
 * when it is one of the catalog ids. Never prefixes or otherwise constructs an
 * id. `claude-opus` and `claude-foo` fail.
 */
export function resolveClaudeModel(piId: string): string {
  const id = parseModelThinking(piId).bareId;
  if (!CLAUDE_MODEL_IDS.has(id)) throw unsupportedClaudeModel(piId);
  return id;
}

/**
 * A single, backend-neutral dispatch request. The relay provider assembles this
 * from the pi model id (→ {@link model}), the pi subagent's system prompt
 * (→ {@link systemPromptFile}), and its **pi-neutral** tool set (→ {@link tools}).
 */
export interface DriverInvocation {
  /** The task / final user message text handed to the external agent. */
  readonly task: string;
  /** External model id parsed from the pi model id (e.g. `relay-claude/claude-opus-5-5`). */
  readonly model: string;
  /**
   * Pi thinking level for this run (`off`…`max`). When omitted, the driver
   * falls back to a `:<level>` suffix on {@link model} (the shape pi appends
   * when a role declares `thinking: high`).
   */
  readonly thinking?: PiThinkingLevel;
  /**
   * Path to the assembled system-prompt file (persona body + skills). When
   * omitted, the backend runs with its own default system prompt.
   */
  readonly systemPromptFile?: string;
  /**
   * Whether {@link systemPromptFile} replaces the backend's default system prompt
   * (`replace`, the subagent default) or is appended to it (`append`).
   */
  readonly systemPromptMode?: "replace" | "append";
  /**
   * **pi-neutral** tool names (e.g. `read`, `bash`, `grep`, `find`). Each driver
   * maps these onto its own backend (D10) — `claudeDriver` → `--allowedTools`
   * (`Read Bash …`). D2: for the verify role this is a read-only set.
   */
  readonly tools?: readonly string[];
}

/**
 * pi tool name → Claude (`claude -p`) tool name. This map is a DRIVER function
 * (D10). pi-only tools with no Claude equivalent (e.g. `subagent`, `ls`) are
 * intentionally absent and get dropped by {@link mapToolNames}. Note pi has no
 * `glob` tool — its glob-style tool is `find`, which maps to Claude's `Glob`.
 */
export const CLAUDE_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Glob",
};

/** Map a single pi tool name to its Claude equivalent, or `undefined` if none. */
export function mapToolName(piName: string): string | undefined {
  return CLAUDE_TOOL_NAME_MAP[piName.trim().toLowerCase()];
}

/**
 * Map pi tool names to Claude `--allowedTools` names, dropping pi-only tools with
 * no Claude equivalent and de-duplicating while preserving order.
 */
export function mapToolNames(piNames: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of piNames) {
    const mapped = mapToolName(name);
    if (mapped !== undefined && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/**
 * Pi tool → Claude permission rule. Bare `Bash` only exposes the tool; Claude Code
 * 2.1 still prompts per command unless a pattern pre-approves it. `Bash(*)` is the
 * scoped form of "this role's bash tool may run." Other mapped tools stay bare
 * names. Unmapped pi-only tools are dropped.
 */
export function mapClaudePermissionRule(piName: string): string | undefined {
  const tool = mapToolName(piName);
  if (tool === undefined) return undefined;
  if (tool === "Bash") return "Bash(*)";
  return tool;
}

/**
 * Map pi tool names to comma-ready Claude permission rules, dropping unmapped
 * names and de-duplicating while preserving order.
 */
export function mapClaudePermissionRules(piNames: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of piNames) {
    const mapped = mapClaudePermissionRule(name);
    if (mapped !== undefined && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/**
 * Pi thinking → Claude `--effort`. Claude accepts `low|medium|high|xhigh|max`.
 * `off` omits the flag (Claude's own default). `minimal` has no Claude equivalent
 * and clamps to `low`.
 */
export function mapClaudeEffort(level: PiThinkingLevel | undefined): string | undefined {
  if (level === undefined || level === "off") return undefined;
  if (level === "minimal") return "low";
  return level;
}

/**
 * The JSON envelope emitted by `claude -p --output-format stream-json` (and the
 * historical `--output-format json` object / 2.1.220+ array). Stream-json is
 * NDJSON whose last `{ type: "result", result, is_error }` line is the parse
 * target. Only the fields the driver reads are modelled; everything else is ignored.
 */
export interface ClaudeResultEnvelope {
  type?: string;
  result?: string;
  is_error?: boolean;
}

/** The parsed, backend-neutral outcome of a single dispatch. */
export interface DriverResult {
  /** The agent's final free-text result (the envelope's `.result`). */
  result: string;
  /** Whether the backend itself flagged the run as an error. */
  isError: boolean;
}

/**
 * Backend-agnostic dispatch adapter. The relay provider (spawn, stream, wall-cap,
 * signal handling) is written against this interface, never against `claude`
 * directly (D10).
 */
export interface AgentDriver {
  /** Stable identifier for the backend (used in logs/events). */
  readonly name: string;
  /** The executable to spawn. */
  readonly bin: string;
  /** Build the argv for a single headless dispatch. */
  buildArgs(invocation: DriverInvocation): string[];
  /** Extract the neutral result from the backend's raw stdout. */
  parseResult(stdout: string): DriverResult;
  /**
   * Extra env vars merged into the spawned process. Optional. Used by backends
   * that configure permissions via a config dir (e.g. `CURSOR_CONFIG_DIR`)
   * rather than argv flags.
   */
  env?(invocation: DriverInvocation): Readonly<Record<string, string>> | undefined;
}

function asEnvelope(value: unknown): ClaudeResultEnvelope | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as ClaudeResultEnvelope;
}

/**
 * Pull the terminal `{ type: "result" }` event from a 2.1.220+ stream array, or
 * accept the historical single-object envelope. A missing result event (or a
 * non-object parse) is `undefined` so the caller can fail closed (D6).
 */
function extractResultEnvelope(parsed: unknown): ClaudeResultEnvelope | undefined {
  if (Array.isArray(parsed)) {
    return asEnvelope(parsed.findLast((entry: unknown) => asEnvelope(entry)?.type === "result"));
  }
  return asEnvelope(parsed);
}

/**
 * Scan NDJSON stdout for the last `{ type: "result" }` object. Does not fall back
 * to `JSON.parse` of the whole buffer — backends still on a single json envelope
 * keep their own whole-stdout parser.
 */
export function findLastNdjsonResult(stdout: string): ClaudeResultEnvelope | undefined {
  let last: ClaudeResultEnvelope | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const env = asEnvelope(JSON.parse(trimmed) as unknown);
      if (env?.type === "result") last = env;
    } catch {
      // Non-JSON lines are ignored; parseResult fails closed if nothing matches.
    }
  }
  return last;
}

/**
 * Claude/Cursor-style result: last NDJSON `type:"result"`, else the historical
 * whole-stdout JSON object or 2.1.220+ array.
 */
export function parseClaudeStyleResult(stdout: string): DriverResult {
  const fromLines = findLastNdjsonResult(stdout);
  if (fromLines) {
    return {
      result: String(fromLines.result ?? ""),
      isError: fromLines.is_error === true,
    };
  }
  try {
    const parsed: unknown = JSON.parse(stdout);
    const envelope = extractResultEnvelope(parsed);
    if (!envelope) return { result: "", isError: true };
    return {
      result: String(envelope.result ?? ""),
      isError: envelope.is_error === true,
    };
  } catch {
    // Unparseable stdout (truncated/empty/non-JSON) is treated as an error with
    // no result — the caller's fail-safe (D6) then reports UNVERIFIED, never PASS.
    return { result: "", isError: true };
  }
}

/**
 * The primary `AgentDriver` implementation: subscription **Opus via `claude -p`**
 * (D1), scoped read-only tools and never `--dangerously-skip-permissions` (D2),
 * `--output-format stream-json --verbose` so print mode emits NDJSON as it runs
 * (`--include-partial-messages` because the provider forwards `text_delta`).
 *
 * The persona + skills reach `claude` deterministically via
 * `--system-prompt-file` (our code writes the file — no model re-echo, no drift).
 */
export const claudeDriver: AgentDriver = {
  name: "claude",
  bin: "claude",

  buildArgs(invocation: DriverInvocation): string[] {
    const parsed = parseModelThinking(invocation.model);
    const backendId = resolveClaudeModel(invocation.model);
    const supported = claudeSupportedLevels(backendId);
    const requested = invocation.thinking ?? parsed.thinking;
    const level = supported === undefined ? requested : clampToSupported(requested, supported);
    const effort = mapClaudeEffort(level);
    const args = [
      "-p",
      invocation.task,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      backendId,
    ];
    if (effort !== undefined) args.push("--effort", effort);

    if (invocation.systemPromptFile) {
      // `--system-prompt-file` replaces claude's default system prompt with the
      // assembled persona+skills (the subagent default `systemPromptMode: replace`);
      // `--append-system-prompt-file` layers it on top instead.
      args.push(
        invocation.systemPromptMode === "append"
          ? "--append-system-prompt-file"
          : "--system-prompt-file",
        invocation.systemPromptFile,
      );
    }

    // Headless in every environment: a plain terminal, a Pi child, CI, and cmux.
    // dontAsk denies anything not pre-approved. It is not a permission bypass.
    // permission-prompts none denies a leftover print-mode prompt instead of
    // waiting on an SDK host that relay does not implement.
    args.push("--permission-mode", "dontAsk", "--permission-prompts", "none");

    // D10: the pi→Claude permission-rule map is applied HERE, in the driver.
    const allowedTools = mapClaudePermissionRules(invocation.tools ?? []);
    if (allowedTools.length > 0) {
      // D2: a SCOPED allowlist only. Never --dangerously-skip-permissions.
      // Comma-separated so a rule that contains a space cannot be split.
      args.push("--allowedTools", allowedTools.join(","));
    }

    return args;
  },

  /**
   * Headless children must not block on an interactive permission UI. cmux's
   * wrapper injects a 125s PermissionRequest hook unless this is set; the real
   * `claude` binary ignores the variable, so it is a no-op outside cmux.
   */
  env(_invocation: DriverInvocation): Readonly<Record<string, string>> {
    return { CMUX_CLAUDE_HOOKS_DISABLED: "1" };
  },

  parseResult(stdout: string): DriverResult {
    return parseClaudeStyleResult(stdout);
  },
};
