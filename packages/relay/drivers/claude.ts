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
 * allowlist and NEVER `--dangerously-skip-permissions`. The verify role supplies a
 * read-only tool set (pi `read, bash, grep, find`); the driver maps those neutral
 * names to Claude's (`Read Bash Grep Glob`) and adds no privilege-escalating flags.
 *
 * ── Tool-name map lives HERE (D10) ──
 * Mapping pi's neutral tool names to a backend's tool names is a DRIVER concern,
 * not the resolver's. `claudeDriver` maps them to `claude`'s `--allowedTools`
 * names; a future `codexDriver` maps the same neutral list to its sandbox (`-s`).
 */

/**
 * A single, backend-neutral dispatch request. The relay provider assembles this
 * from the pi model id (→ {@link model}), the pi subagent's system prompt
 * (→ {@link systemPromptFile}), and its **pi-neutral** tool set (→ {@link tools}).
 */
export interface DriverInvocation {
  /** The task / final user message text handed to the external agent. */
  readonly task: string;
  /** External model id parsed from the pi model id (e.g. `relay-claude/opus` → `opus`). */
  readonly model: string;
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
  /**
   * Absolute path to the working tree the dispatched agent runs against. Used by
   * the driver to derive a **read-only posture's** filesystem-mutation guard (D12):
   * for a read-only role the driver denies writes to this path in the backend's
   * native sandbox. Defaults to `process.cwd()` when omitted. Should equal the
   * `cwd` the provider passes to `spawn`.
   */
  readonly cwd?: string;
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
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/**
 * ── Per-role execution posture (D12) ──────────────────────────────────────────
 * pi tool names that grant filesystem **mutation**. A role whose declared tools
 * omit ALL of these runs **read-only** — the driver must then enforce that posture
 * in the backend so the external agent cannot mutate the working tree, not merely
 * withhold the Edit/Write tools (`bash` can still `echo > file`; that is the bug
 * D12 closes).
 */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["edit", "write"]);

/**
 * Derive a role's execution posture from its **pi-neutral** declared tool set (D12).
 * A role is **read-only** when it declares a scoped tool set that withholds every
 * mutation tool (`edit`/`write`). An empty/undefined set is NOT read-only: with no
 * declared allowlist the backend runs its full default (write-capable) tool set, so
 * that is a write posture — the driver only claims read-only when it can actually
 * scope the backend down.
 */
export function isReadOnlyPosture(tools: readonly string[] | undefined): boolean {
  if (!tools || tools.length === 0) return false;
  return !tools.some((name) => WRITE_TOOL_NAMES.has(name.trim().toLowerCase()));
}

/**
 * Build `claude`'s **native** sandbox settings for a read-only role (D12): deny all
 * writes to the working tree (`cwd`) while still permitting reads everywhere and
 * command **execution** (build/test). The sandbox runs the agent in place, so it
 * still sees the real, **uncommitted** working-tree state (design tension option
 * (i) — best: no copy, no worktree, full fidelity).
 *
 * - `enabled` — turn on OS-level sandboxing (macOS Seatbelt).
 * - `failIfUnavailable` — if the OS sandbox is unavailable, FAIL rather than
 *   silently run unsandboxed: a read-only guarantee that isn't enforced must not
 *   ship (fail-safe).
 * - `allowUnsandboxedCommands: false` — a command blocked by the sandbox cannot be
 *   retried outside it.
 * - `filesystem.denyWrite: [cwd]` — the working tree is read-only; `$TMPDIR` and
 *   other default-writable scratch remain writable so build/test tooling still runs.
 */
export function readOnlySandboxSettings(cwd: string): string {
  return JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: [cwd] },
    },
  });
}

/**
 * The JSON envelope emitted by `claude -p --output-format json`. Only the fields
 * the driver reads are modelled; everything else in the envelope is ignored.
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
}

/**
 * The primary `AgentDriver` implementation: subscription **Opus via `claude -p`**
 * (D1), scoped read-only tools and never `--dangerously-skip-permissions` (D2),
 * `--output-format json` for a machine-parseable envelope.
 *
 * The persona + skills reach `claude` deterministically via
 * `--system-prompt-file` (our code writes the file — no model re-echo, no drift).
 */
export const claudeDriver: AgentDriver = {
  name: "claude",
  bin: "claude",

  buildArgs(invocation: DriverInvocation): string[] {
    const args = ["-p", invocation.task, "--output-format", "json", "--model", invocation.model];

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

    // D10: the pi→Claude tool-name map is applied HERE, in the driver.
    const allowedTools = mapToolNames(invocation.tools ?? []);
    if (allowedTools.length > 0) {
      // D2: a SCOPED allowlist only. Never --dangerously-skip-permissions.
      args.push("--allowedTools", allowedTools.join(" "));
    }

    // D12: translate the role's POSTURE into claude's native enforcement. For a
    // read-only role we (1) explicitly deny the mutation tools (close the tool
    // path) and (2) enable the OS sandbox denying writes to the working tree
    // (close the `bash` path — the actual bug: withholding Edit/Write is not
    // enough because `bash` can still mutate). Execution (build/test) is still
    // allowed; the agent still sees uncommitted state (in-place sandbox).
    if (isReadOnlyPosture(invocation.tools)) {
      args.push("--disallowedTools", "Edit Write NotebookEdit");
      args.push("--settings", readOnlySandboxSettings(invocation.cwd ?? process.cwd()));
    }

    return args;
  },

  parseResult(stdout: string): DriverResult {
    try {
      const envelope = JSON.parse(stdout) as ClaudeResultEnvelope;
      return {
        result: String(envelope.result ?? ""),
        isError: envelope.is_error === true,
      };
    } catch {
      // Unparseable stdout (truncated/empty/non-JSON) is treated as an error with
      // no result — the caller's fail-safe (D6) then reports UNVERIFIED, never PASS.
      return { result: "", isError: true };
    }
  },
};
