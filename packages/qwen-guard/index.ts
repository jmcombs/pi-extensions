/**
 * @jmcombs/pi-qwen-guard
 *
 * Automatically detects when a Qwen model (via Ollama) is active inside Pi and
 * injects strict incremental-mode rules into the system prompt. The rules are
 * only active while a Qwen model is selected and are removed when you switch
 * to a different model.
 *
 * The guard provides:
 * - Automatic activation notice when a Qwen model is selected
 * - Strong behavioral constraints to reduce streaming terminations
 * - Consistent `🛡️ pi-qwen-guard:` signaling (✅ for progress, ❌ for self-correction)
 *
 * Works with or without a separate plan-first / TODO workflow (though results
 * are generally better when combined with one).
 *
 * See:
 *   - packages/qwen-guard/TESTING.md
 *   - CONTRIBUTING.md and TEMPLATE.md at the repo root
 *   - https://pi.dev/docs/extensions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const QWEN_INSTRUCTIONS = `
Qwen-safe incremental mode is now active.

Hard rules (these exist to prevent your responses from being killed by Ollama streaming limits):

- Never output more than ~60 lines of code or changes in a single response.
- After completing any meaningful piece of work (a function, a logical change, a file section, etc.), you must immediately output a single line that starts with exactly "🛡️ pi-qwen-guard: " followed by either ✅ (successful small chunk) or ❌ (you had to stop or self-correct because you were approaching limits).
- Prefer the edit tool over write for any existing file.
- Work in small, focused increments. Do not attempt large refactors, multiple files, or broad architectural changes in one response.
- You may continue to the next small chunk after signaling. You do **not** need explicit user approval after every signal.

For best results with Qwen models on Ollama, strongly consider using a plan-first workflow: create or maintain a TODO.md (or task_plan.md) with small atomic tasks, get the user's explicit approval on the plan before starting major work, and execute one task at a time while keeping the plan updated. This guard will still enforce the size limits and signaling even if you are not using a plan, but combining both is significantly more reliable and prevents streaming failures.

Violating the response size limit or failing to use the required signaling prefix will cause "Stream ended without finish_reason" or similar fatal errors.
`;

export default function (pi: ExtensionAPI): void {
  let isQwenModel = false;

  const updateQwenStatus = (modelId: string | undefined) => {
    isQwenModel = (modelId?.toLowerCase() ?? "").includes("qwen");
  };

  pi.on("session_start", (_event, ctx) => {
    updateQwenStatus(ctx.model?.id);

    if (isQwenModel) {
      ctx.ui.notify("🛡️ pi-qwen-guard: Qwen3.6 incremental mode enabled", "info");
    }
  });

  pi.on("model_select", (event: unknown) => {
    // event shape is typically { model: { id: string } }
    const e = event as { model?: { id?: string }; id?: string };
    const modelId = e.model?.id ?? e.id;
    updateQwenStatus(modelId);
  });

  pi.on("before_agent_start", (event) => {
    if (!isQwenModel) return;

    const instructions = QWEN_INSTRUCTIONS.trim();

    // Avoid appending multiple times if the prompt is rebuilt
    if ((event.systemPrompt || "").includes("🛡️ pi-qwen-guard")) {
      return;
    }

    return {
      systemPrompt: (event.systemPrompt || "") + "\n\n" + instructions,
    };
  });
}
