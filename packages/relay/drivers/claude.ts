/**
 * drivers/claude.ts — the driver/adapter seam (Locked Decision D10).
 *
 * `AgentDriver` is the backend-agnostic interface the relay core dispatches
 * through: it knows how to name the backend binary, build its argv, and pull the
 * raw text result out of the backend's stdout envelope. `claudeDriver` is the
 * SOLE implementation — headless subscription Opus via `claude -p`.
 *
 * Per D10, NO verdict parsing lives here. The driver only surfaces the backend's
 * `.result` text and its own error flag; interpreting that text (e.g. the
 * `verify_phase` VERDICT regex, D3) is the consumer's job in `index.ts`.
 */

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
 * Backend-agnostic dispatch adapter. The relay core (spawn, pushback, wall-cap,
 * signal handling) is written against this interface, never against `claude`
 * directly (D10).
 */
export interface AgentDriver {
  /** Stable identifier for the backend (used in logs/events). */
  readonly name: string;
  /** The executable to spawn. */
  readonly bin: string;
  /** Build the argv for a single headless, read-only dispatch of `prompt`. */
  buildArgs(prompt: string): string[];
  /** Extract the neutral result from the backend's raw stdout. */
  parseResult(stdout: string): DriverResult;
}

/**
 * The sole `AgentDriver` implementation: subscription **Opus via `claude -p`**
 * (D1), scoped read-only tools and never `--dangerously-skip-permissions` (D2),
 * `--model opus` + `--output-format json` (D3).
 */
export const claudeDriver: AgentDriver = {
  name: "claude",
  bin: "claude",

  buildArgs(prompt: string): string[] {
    return [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--model",
      "opus",
      // D2: scoped, read-only tools only. Never --dangerously-skip-permissions.
      "--allowedTools",
      "Bash Read Grep Glob",
      "--max-turns",
      "80",
    ];
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
      // no result — the consumer's fail-safe (D6) then reports UNVERIFIED.
      return { result: "", isError: true };
    }
  },
};
