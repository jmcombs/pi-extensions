/**
 * @jmcombs/pi-relay — async agent-dispatch primitive for the Pi coding agent.
 *
 * Registers two LLM-callable tools:
 *   - `verify_phase` — dispatch a read-only phase verification to headless
 *     Claude Opus (`claude -p`) and relay the PASS/FAIL verdict back mid-turn.
 *   - `dispatch` — a thin generic escape hatch over the same substrate: hand any
 *     prompt to headless Claude Opus and relay the result back mid-turn.
 *
 * Both tools are **async / non-blocking** (D4): `execute()` returns `PENDING`
 * immediately and the real result arrives later as a follow-up turn via
 * `pi.sendMessage(…, { triggerTurn: true })`.
 *
 * The backend is reached exclusively through the driver seam (`claudeDriver`,
 * D10). Verdict interpretation (D3) lives here in the consumer, not the driver.
 *
 * Not affiliated with or endorsed by Anthropic. Claude and Opus are trademarks
 * of Anthropic, PBC.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { type AgentDriver, claudeDriver } from "./drivers/claude.js";

// ── Constants ──────────────────────────────────────────────────────────

/**
 * Re-entrancy sentinel (D8). Set at the top of the factory and propagated into
 * every spawned child's environment so a dispatched agent that itself loads this
 * extension does not re-register the tools and recurse.
 */
const REENTRANCY_SENTINEL = "PI_RELAY_ACTIVE";

/** Wall-cap backstop (D6): default 600 s, overridable via `PI_RELAY_WALL_MS`. */
const DEFAULT_WALL_CAP_MS = 600_000;

/** Verdict extraction (D3): the LAST `VERDICT: PASS|FAIL` wins. */
const VERDICT_RE = /VERDICT:\s*(PASS|FAIL)/gi;

// ── Tool parameter schemas ─────────────────────────────────────────────

const verifyPhaseSchema = Type.Object({
  phase: Type.String({
    description: "Identifier of the phase to verify (e.g. a phase name or number).",
    minLength: 1,
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the verification. Defaults to the session cwd.",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description:
        "Override the verification prompt. When omitted, a default read-only verify prompt is used. The verifier must end its output with a line `VERDICT: PASS` or `VERDICT: FAIL`.",
    }),
  ),
});

const dispatchSchema = Type.Object({
  prompt: Type.String({
    description: "The task to hand to a headless Claude Opus agent.",
    minLength: 1,
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the dispatched agent. Defaults to the session cwd.",
    }),
  ),
});

export type VerifyPhaseInput = Static<typeof verifyPhaseSchema>;
export type DispatchInput = Static<typeof dispatchSchema>;

// ── Dispatch core (driver-agnostic, D10) ───────────────────────────────

/** Neutral outcome handed to a dispatch's completion callback. */
interface DispatchOutcome {
  /** The backend's free-text result. */
  readonly result: string;
  /** Whether the backend flagged an error. */
  readonly isError: boolean;
  /** Whether the run was cut short (wall-cap or abort) — forces fail-safe (D6). */
  readonly cut: boolean;
}

/** Resolve the configured wall-cap in milliseconds (D6). */
function wallCapMs(): number {
  const raw = process.env.PI_RELAY_WALL_MS;
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WALL_CAP_MS;
}

/**
 * Spawn the driver's backend for a single dispatch WITHOUT awaiting it (D4),
 * enforcing the wall-cap backstop and the abort signal (D6). Calls `onDone`
 * exactly once when the child settles, is cut, or fails to spawn.
 */
function runDriverAsync(
  driver: AgentDriver,
  prompt: string,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  onDone: (outcome: DispatchOutcome) => void,
): void {
  const child = spawn(driver.bin, driver.buildArgs(prompt), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // Propagate the re-entrancy sentinel into the child (D8).
    env: { ...process.env, [REENTRANCY_SENTINEL]: "1" },
  });

  let out = "";
  let cut = false;
  let settled = false;

  const timer = setTimeout(() => {
    cut = true;
    child.kill("SIGTERM");
  }, wallCapMs());

  const onAbort = (): void => {
    cut = true;
    child.kill("SIGTERM");
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const finish = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    const parsed = driver.parseResult(out);
    onDone({ result: parsed.result, isError: parsed.isError || cut, cut });
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  // A spawn failure (e.g. missing binary) surfaces here; treat it as a cut so
  // the consumer reports the fail-safe verdict rather than auto-PASS (D6).
  child.on("error", () => {
    cut = true;
    finish();
  });
  child.on("close", finish);
}

/** Extract the LAST `VERDICT: PASS|FAIL` from result text (D3). */
function extractVerdict(result: string): "PASS" | "FAIL" | undefined {
  let match: RegExpExecArray | null = VERDICT_RE.exec(result);
  let last: string | undefined;
  while (match !== null) {
    last = match[1];
    match = VERDICT_RE.exec(result);
  }
  VERDICT_RE.lastIndex = 0;
  return last?.toUpperCase() === "PASS"
    ? "PASS"
    : last?.toUpperCase() === "FAIL"
      ? "FAIL"
      : undefined;
}

/** Default read-only verify prompt when the caller does not supply one. */
function defaultVerifyPrompt(phase: string): string {
  return [
    `You are a strict, read-only phase verifier. Verify phase "${phase}" in the current`,
    "working directory using only Bash, Read, Grep, and Glob. Do not modify anything.",
    "Assess whether the phase's work is complete and correct against its spec/plan.",
    "End your reply with exactly one line: `VERDICT: PASS` or `VERDICT: FAIL`.",
  ].join(" ");
}

// ── Extension factory ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // Re-entrancy guard (D8) — MUST be the first thing the factory does so a
  // dispatched child that reloads this extension exits before re-registering.
  if (process.env[REENTRANCY_SENTINEL] === "1") return;
  process.env[REENTRANCY_SENTINEL] = "1";

  pi.registerTool({
    name: "verify_phase",
    label: "Relay: Verify Phase",
    description:
      "Dispatch a read-only phase verification to a headless Claude Opus agent (`claude -p`) and relay the PASS/FAIL verdict back as a follow-up turn. Returns immediately as PENDING; the verdict arrives asynchronously. Reports the verdict and evidence only — it never merges or ticks anything.",
    parameters: verifyPhaseSchema,
    execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = params.cwd ?? ctx.cwd;
      const prompt = params.prompt ?? defaultVerifyPrompt(params.phase);

      try {
        runDriverAsync(claudeDriver, prompt, cwd, signal, (outcome) => {
          // Fail-safe (D6): a cut run is UNVERIFIED, never auto-PASS. A completed
          // run with no VERDICT line is likewise UNVERIFIED.
          const verdict = outcome.cut
            ? "UNVERIFIED"
            : (extractVerdict(outcome.result) ?? "UNVERIFIED");
          const text = outcome.cut
            ? `verify_phase(${params.phase}): UNVERIFIED — the verification was cut short (wall-cap or abort) before producing a verdict.`
            : `verify_phase(${params.phase}): ${verdict}\n\n${outcome.result}`;

          pi.sendMessage(
            {
              customType: "relay:verify_phase",
              content: text,
              display: true,
              details: {
                phase: params.phase,
                verdict,
                cut: outcome.cut,
                isError: outcome.isError,
              },
            },
            { triggerTurn: true },
          );
          pi.events.emit("relay:verdict", { tool: "verify_phase", phase: params.phase, verdict });
        });
      } catch (error) {
        // D9: signal dispatch-setup errors via content text + details.error + isError.
        const message = error instanceof Error ? error.message : String(error);
        return Promise.resolve({
          content: [{ type: "text", text: `Failed to dispatch verify_phase: ${message}` }],
          details: { status: "ERROR", tool: "verify_phase", phase: params.phase, error: message },
          isError: true,
        });
      }

      // D4: return immediately, non-blocking.
      return Promise.resolve({
        content: [
          {
            type: "text",
            text: `verify_phase dispatched for "${params.phase}". Status: PENDING — the verdict will arrive as a follow-up turn.`,
          },
        ],
        details: { status: "PENDING", tool: "verify_phase", phase: params.phase },
      });
    },
  });

  pi.registerTool({
    name: "dispatch",
    label: "Relay: Dispatch",
    description:
      "Hand an arbitrary task to a headless Claude Opus agent (`claude -p`) and relay its result back as a follow-up turn. Returns immediately as PENDING; the result arrives asynchronously. A generic escape hatch over the same async substrate as verify_phase.",
    parameters: dispatchSchema,
    execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = params.cwd ?? ctx.cwd;

      try {
        runDriverAsync(claudeDriver, params.prompt, cwd, signal, (outcome) => {
          const text = outcome.cut
            ? "dispatch: UNVERIFIED — the dispatched agent was cut short (wall-cap or abort) before completing."
            : outcome.result.trim().length > 0
              ? outcome.result
              : "dispatch completed with no output.";

          pi.sendMessage(
            {
              customType: "relay:dispatch",
              content: text,
              display: true,
              details: { cut: outcome.cut, isError: outcome.isError },
            },
            { triggerTurn: true },
          );
          pi.events.emit("relay:result", { tool: "dispatch", cut: outcome.cut });
        });
      } catch (error) {
        // D9: signal dispatch-setup errors via content text + details.error + isError.
        const message = error instanceof Error ? error.message : String(error);
        return Promise.resolve({
          content: [{ type: "text", text: `Failed to dispatch: ${message}` }],
          details: { status: "ERROR", tool: "dispatch", error: message },
          isError: true,
        });
      }

      // D4: return immediately, non-blocking.
      return Promise.resolve({
        content: [
          {
            type: "text",
            text: "dispatch accepted. Status: PENDING — the result will arrive as a follow-up turn.",
          },
        ],
        details: { status: "PENDING", tool: "dispatch" },
      });
    },
  });
}
