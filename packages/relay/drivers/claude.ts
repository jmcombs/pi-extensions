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
 * read-only tool set (`Read Bash Grep Glob`); the driver relays exactly what it is
 * handed and adds no privilege-escalating flags.
 */

/**
 * A single, backend-neutral dispatch request. The relay provider assembles this
 * from the pi model id (→ {@link model}), the pi subagent's system prompt
 * (→ {@link systemPromptFile}), and its tool set (→ {@link allowedTools}).
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
   * External tool names, ALREADY mapped from pi tool names via the roles tool
   * map (e.g. `read` → `Read`). D2: for the verify role this is a read-only set.
   */
  readonly allowedTools?: readonly string[];
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

    if (invocation.allowedTools && invocation.allowedTools.length > 0) {
      // D2: a SCOPED allowlist only. Never --dangerously-skip-permissions.
      args.push("--allowedTools", invocation.allowedTools.join(" "));
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
