/**
 * @jmcombs/pi-relay — run any Pi subagent on an external coding agent.
 *
 * Relay registers a pi **provider** (`relay-claude`). A pi-subagent runs on a
 * headless external agent — subscription **Claude Opus via `claude -p`** — simply
 * by setting its `model` to `relay-claude/opus`: pi's native `resolveModel` routes
 * the completion to relay's `streamSimple` handler, which runs ONE `claude -p` and
 * streams the external agent's final assistant text back. Persona + skills reach
 * `claude` deterministically via `--system-prompt-file` (no re-echo, no drift).
 *
 * The flagship consumer is phase **verification**: the `verifier` subagent runs as
 * a relayed subagent (`model: relay-claude/opus`, read-only tools per D2) through
 * pi's native subagent-async layer — no bespoke tool, no inline prompt. This
 * supersedes the Phase-1/2 `verify_phase`/`dispatch` tools and their custom
 * `sendMessage` pushback.
 *
 * The backend is reached exclusively through the driver seam (`claudeDriver`, D10;
 * `codexDriver` is a documented seam-only stub). D1 (Opus for verify), D2
 * (read-only, never `--dangerously-skip-permissions`), and D6 (fail-safe
 * UNVERIFIED on a cut run, never auto-PASS) are preserved by the provider/driver.
 *
 * Not affiliated with or endorsed by Anthropic. Claude and Opus are trademarks of
 * Anthropic, PBC.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRelayClaudeProvider } from "./provider.js";

export default function (pi: ExtensionAPI): void {
  registerRelayClaudeProvider(pi);
}
