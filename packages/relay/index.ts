/**
 * @jmcombs/pi-relay — run any Pi subagent on an external coding agent.
 *
 * Relay registers pi **providers** (`relay-claude`, `relay-grok`). A pi-subagent
 * runs on a headless external agent — subscription **Claude Opus via `claude -p`**,
 * or **Grok Build via `grok -p`** — simply by setting its `model` to
 * `relay-claude/opus` or `relay-grok/grok-4.5`: pi's native `resolveModel` routes
 * the completion to relay's `streamSimple` handler, which runs ONE headless CLI
 * invocation and streams the external agent's final assistant text back. Persona +
 * skills reach the backend deterministically via its own system-prompt mechanism
 * (`--system-prompt-file` for Claude, `--system-prompt-override`/`--rules` for
 * Grok — no re-echo, no drift).
 *
 * The flagship consumer is phase **verification**: the `verifier` subagent runs as
 * a relayed subagent (`model: relay-claude/opus`, read-only tools per D2) through
 * pi's native subagent-async layer — no bespoke tool, no inline prompt. This
 * supersedes the Phase-1/2 `verify_phase`/`dispatch` tools and their custom
 * `sendMessage` pushback. Adding a second live driver does not change this: per D1,
 * the verify quality bar stays Claude-Opus-only until another backend clears the
 * accuracy benchmark.
 *
 * Each backend is reached exclusively through the driver seam (`claudeDriver`,
 * `grokDriver`, D10; `codexDriver` is a documented seam-only stub). D1 (Opus for
 * verify), D2 (read-only, never a permission-bypass flag), and D6 (fail-safe
 * UNVERIFIED on a cut run, never auto-PASS) are preserved by the provider/drivers.
 *
 * Not affiliated with or endorsed by Anthropic or xAI. Claude and Opus are
 * trademarks of Anthropic, PBC; Grok is a trademark of xAI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRelayClaudeProvider, registerRelayGrokProvider } from "./provider.js";

export default function (pi: ExtensionAPI): void {
  registerRelayClaudeProvider(pi);
  registerRelayGrokProvider(pi);
}
