/**
 * drivers/grok.ts — the `AgentDriver` seam (Locked Decision D10) for xAI's
 * **Grok Build** CLI (binary `grok`). Headless dispatch via `grok -p`, scoped
 * read-only tools and never a permission-bypass mode (D2).
 *
 * Field/behavior notes below were confirmed by running `grok` v0.2.93 directly
 * (not just its `--help` text or vendor docs) — re-verify after a CLI upgrade:
 *
 * ── Output envelope (`--output-format json`) ──
 * Success: `{ text, stopReason, sessionId, requestId, thought }` — the answer is
 * `.text`, not `.result`. A clean finish is `stopReason: "EndTurn"`; a tool call
 * blocked by the permission model (or a max-turns cutoff) still uses this SAME
 * shape but with `stopReason: "Cancelled"` and often empty `text` — it is NOT
 * flagged via an error type, so `parseResult` must check `stopReason`, not just
 * look for an error envelope. A hard failure (e.g. an invalid `--model`) uses a
 * DIFFERENT shape: `{ "type": "error", "message": "..." }`.
 *
 * ── System prompt ──
 * Grok has no `--system-prompt-file`; both of its equivalents take the prompt
 * INLINE as a string: `--system-prompt-override <text>` (replaces the default
 * prompt) and `--rules <text>` (appended extra rules on top of the default
 * prompt) — mapping directly onto `systemPromptMode: "replace" | "append"`.
 *
 * ── Tool/permission model — the important gotcha ──
 * `--tools <list>` / `--disallowed-tools <list>` (restrict the built-in tool
 * SET) reproducibly fail in v0.2.93 with an unrelated internal error
 * (`run_terminal_cmd ... auto_background_on_timeout requires enabled_background`),
 * regardless of the value passed. Do not use them. Instead, use the permission
 * RULE flags `--allow <Tool>` / `--deny <Tool>` (the CLI's own `--help` labels
 * these "Claude Code: --allowedTools" / "--disallowedTools"), which take
 * Claude-style capitalized tool names — confirmed via direct testing to require
 * one `--allow` per tool name (a single space-joined value silently fails).
 * Paired with `--permission-mode dontAsk`, this is a verified fail-closed,
 * non-interactive scoped allowlist: unlisted tools (e.g. Write/Edit) are
 * silently declined (`stopReason: "Cancelled"`, no hang), exactly mirroring
 * Claude's `--allowedTools` semantics. Never use `--permission-mode auto` /
 * `bypassPermissions` or `--always-approve` — verified to auto-approve
 * everything with no allowlist, the Grok analogue of
 * `--dangerously-skip-permissions` (D2).
 */

import * as fs from "node:fs";
import type { AgentDriver, DriverInvocation, DriverResult } from "./claude.js";

/**
 * The JSON envelope emitted by `grok -p --output-format json`. Only the fields
 * the driver reads are modelled; everything else (e.g. `sessionId`,
 * `requestId`, `thought`) is ignored.
 */
export interface GrokResultEnvelope {
  type?: string;
  message?: string;
  text?: string;
  stopReason?: string;
}

/**
 * pi tool name → Grok (`--allow`) tool name. Grok's `--allow`/`--deny` rules
 * use the same capitalized names as Claude's `--allowedTools` (confirmed via
 * direct testing), so this map mirrors `CLAUDE_TOOL_NAME_MAP` in
 * `drivers/claude.ts`. Kept as its own map (D10 — tool-name mapping is a
 * per-driver function) rather than imported, so a future rename on either
 * backend can't silently break the other.
 */
export const GROK_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Glob",
};

/** Map a single pi tool name to its Grok equivalent, or `undefined` if none. */
export function mapToolName(piName: string): string | undefined {
  return GROK_TOOL_NAME_MAP[piName.trim().toLowerCase()];
}

/**
 * Map pi tool names to Grok `--allow` tool names, dropping pi-only tools with
 * no Grok equivalent and de-duplicating while preserving order.
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
 * `AgentDriver` implementation for Grok Build: headless dispatch via `grok -p`,
 * scoped read-only tools via repeated `--allow` flags (D2), `--output-format
 * json` for a machine-parseable envelope.
 */
export const grokDriver: AgentDriver = {
  name: "grok",
  bin: "grok",

  buildArgs(invocation: DriverInvocation): string[] {
    const args = [
      "-p",
      invocation.task,
      "--output-format",
      "json",
      "--model",
      invocation.model,
      "--no-auto-update",
      // D2: fail-closed, non-interactive. Verified: with no --allow flags this
      // silently declines tool calls (no hang) rather than auto-approving them.
      "--permission-mode",
      "dontAsk",
    ];

    if (invocation.systemPromptFile) {
      const content = fs.readFileSync(invocation.systemPromptFile, "utf8");
      args.push(
        invocation.systemPromptMode === "append" ? "--rules" : "--system-prompt-override",
        content,
      );
    }

    // D10: the pi→Grok tool-name map is applied HERE, in the driver. D2: one
    // --allow per tool (verified — a single space-joined value does not work).
    for (const tool of mapToolNames(invocation.tools ?? [])) {
      args.push("--allow", tool);
    }

    return args;
  },

  parseResult(stdout: string): DriverResult {
    let envelope: GrokResultEnvelope;
    try {
      envelope = JSON.parse(stdout) as GrokResultEnvelope;
    } catch {
      // Unparseable stdout (truncated/empty/non-JSON) is treated as an error
      // with no result — the caller's fail-safe (D6) then reports UNVERIFIED.
      return { result: "", isError: true };
    }

    if (envelope.type === "error") {
      return { result: String(envelope.message ?? ""), isError: true };
    }

    const text = typeof envelope.text === "string" ? envelope.text : "";
    // D6: only a clean EndTurn with non-empty text is a pass. A blocked/cut
    // tool call reuses this same envelope shape with a non-"EndTurn"
    // stopReason (e.g. "Cancelled") and must not be read as a silent success.
    const isError = envelope.stopReason !== "EndTurn" || text.length === 0;
    return { result: text, isError };
  },
};
