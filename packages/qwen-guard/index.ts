/**
 * @jmcombs/pi-qwen-guard
 *
 * Automatically detects Qwen 3.6 (or any Qwen model via Ollama) and injects
 * strict incremental-mode rules at the start of every agent turn. This prevents
 * "error: terminated" and "Stream ended without finish_reason" errors caused by
 * Ollama streaming limits when the model tries to output very large responses.
 *
 * Just install and forget — the guard activates silently for Qwen sessions only.
 *
 * See:
 *   - CONTRIBUTING.md and TEMPLATE.md at the repo root
 *   - https://pi.dev/docs/extensions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const QWEN_INSTRUCTIONS = `
CRITICAL QWEN3.6 / OLLAMA INCREMENTAL MODE (enforced every turn):

You MUST follow these rules strictly for the rest of this session:
- Never output more than ~70–80 lines of code in any single response.
- Prefer the edit tool over write for any file that already exists.
- Build large files in tiny logical chunks (imports → helpers → one tool → next tool).
- After every successful edit/write, reply with exactly: "✅ Chunk complete. File is now X lines. Ready for next?"
- Do NOT continue until the user replies.

This prevents "error: terminated" and "Stream ended without finish_reason".
Only ignore this if the user explicitly says "write the whole file at once".
`;

export default function (pi: ExtensionAPI): void {
  let isQwen = false;

  pi.on("session_start", (_event, ctx) => {
    const modelId = (ctx.model?.id ?? "").toLowerCase();
    if (modelId.includes("qwen")) {
      isQwen = true;
      ctx.ui.notify("🛡️ pi-qwen-guard activated — Qwen3.6 incremental mode enabled", "success");
    }
  });

  pi.on("before_agent_start", (event) => {
    if (!isQwen) return;
    return {
      systemPrompt: (event.systemPrompt || "") + "\n\n" + QWEN_INSTRUCTIONS.trim(),
    };
  });
}
