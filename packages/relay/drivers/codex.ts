/**
 * drivers/codex.ts — SEAM-ONLY stub for an OpenAI Codex CLI backend (D10).
 *
 * This is a deferred build: there is no codex account in this environment, so the
 * driver is NOT wired into the provider and is NEVER spawned. It exists to prove
 * the `AgentDriver` seam is backend-agnostic and to document, field-by-field, how
 * a pi-subagent's standardized definition maps onto `codex exec`. When a codex
 * account is available, fill in `buildArgs`/`parseResult` and register a
 * `relay-codex` provider alongside `relay-claude`.
 *
 * ── Field → flag mapping (pi subagent → `codex exec`) ──
 *   DriverInvocation.task            → positional prompt argument to `codex exec`
 *   DriverInvocation.model           → `-m <model>`            (e.g. gpt-5-codex)
 *   DriverInvocation.systemPromptFile→ `-c instructions="$(cat <file>)"` or a
 *                                       generated `AGENTS.md` in the run cwd
 *                                       (codex reads project `AGENTS.md`); the
 *                                       assembled persona+skills go there.
 *   DriverInvocation.systemPromptMode→ replace: write AGENTS.md as the whole
 *                                       instruction; append: prepend to codex's
 *                                       default via the `-c instructions` layer.
 *   DriverInvocation.tools           → the pi-neutral tool list. codex has no
 *                                       per-tool allowlist flag; the read-only
 *                                       guarantee (D2) is expressed with the
 *                                       sandbox instead: `-s read-only`
 *                                       (`--sandbox read-only`). Codex's built-in
 *                                       tools are gated by the sandbox, not by an
 *                                       allowlist, so mapping the neutral list is
 *                                       advisory only (this is why the tool-name
 *                                       map is a per-driver function, D10).
 *   (output)                         → `--json` (JSONL event stream) plus
 *                                       `-o <file>` / `--output-last-message <file>`
 *                                       to capture the final assistant message.
 *
 * Read-only + non-interactive (mirrors D2): `codex exec` is already
 * non-interactive; `-s read-only` forbids writes/network; NO
 * `--dangerously-bypass-approvals-and-sandbox` (the codex analogue of
 * `--dangerously-skip-permissions`) is ever passed.
 */

import type { AgentDriver, DriverInvocation, DriverResult } from "./claude.js";

/**
 * Placeholder codex driver. `buildArgs`/`parseResult` intentionally throw: the
 * seam and the mapping are documented above, but no live codex invocation is
 * built in this phase.
 */
export const codexDriver: AgentDriver = {
  name: "codex",
  bin: "codex",

  buildArgs(_invocation: DriverInvocation): string[] {
    throw new Error(
      "codexDriver is a documented seam-only stub (no codex account in this phase); " +
        "see drivers/codex.ts for the field→flag mapping.",
    );
  },

  parseResult(_stdout: string): DriverResult {
    throw new Error("codexDriver is a documented seam-only stub; parseResult is not implemented.");
  },
};
