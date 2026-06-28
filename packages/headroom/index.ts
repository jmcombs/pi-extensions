/**
 * @jmcombs/pi-headroom — context compression for the Pi coding agent.
 *
 * Phase 2: compresses the **whole conversation** before each LLM call via Pi's
 * `context` hook (LD1). Pi's `AgentMessage[]` is converted to OpenAI, compressed
 * through the Headroom proxy, and the compressed text is swapped back in place
 * onto the original Pi messages (LD8); see `pi-format.ts` / `compress.ts`. When
 * the cached health probe says the proxy is down, the handler is a pure
 * passthrough — no network call (LD3).
 *
 * The extension never throws into the agent loop (LD3) and never manages the
 * Headroom proxy lifecycle (LD4). The Python proxy is a user-managed
 * prerequisite documented in the README.
 *
 * Commands:
 *   - `/headroom-status`       — report proxy health + version + session savings.
 *   - `/headroom-authenticate` — securely store the proxy API key.
 *
 * Flags:
 *   - `--headroom-no-compress` — disable compression for the session. Retrieve
 *     (Phase 3) stays enabled (LD2); only compression is turned off.
 *
 * Events:
 *   - `context`       — compress the conversation before each LLM call (LD1).
 *   - `session_start` — emits a one-time, non-fatal notice when the proxy is
 *     unreachable so the session stays usable in passthrough mode.
 */

import { AuthStorage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getClient, isHealthy, resolveConfig } from "./client.js";
import { compressMessages } from "./compress.js";

const PROXY_START_HINT = "Start it with: ~/.headroom-venv/bin/headroom proxy --port 8787";

/** CLI flag that disables compression for the session (retrieve stays on, LD2). */
const DISABLE_FLAG = "headroom-no-compress";

/**
 * Fold a single call's `tokensSaved` into the running session total. Pure and
 * exported so the accumulator can be unit-tested with no network. Non-positive
 * or non-finite deltas (passthrough, fallback, errors) leave the total
 * unchanged.
 */
export function accumulateSavings(previous: number, tokensSaved: number): number {
  if (!Number.isFinite(tokensSaved) || tokensSaved <= 0) return previous;
  return previous + tokensSaved;
}

// ── Extension factory ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  const authStorage = AuthStorage.create();

  // Fires at most once per session (the factory runs once per session). We
  // only flip the flag when we actually emit a notice, so a proxy that goes
  // down after a healthy start still surfaces a single warning.
  let noticeShown = false;

  // Running total of tokens saved by compression across this session (LD8).
  let sessionTokensSaved = 0;

  // Disable compression for the session (retrieve stays enabled, LD2).
  pi.registerFlag(DISABLE_FLAG, {
    description: "Disable Headroom context compression for this session (retrieve stays enabled).",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("headroom-status", {
    description: "Report Headroom proxy health, version, and session token savings.",
    handler: async (_args, ctx) => {
      const cfg = await resolveConfig({ authStorage });
      const healthy = await isHealthy({ authStorage });
      const savingsNote = `Session tokens saved so far: ${sessionTokensSaved.toLocaleString()}.`;
      const compressionNote =
        pi.getFlag(DISABLE_FLAG) === true ? " Compression is disabled for this session." : "";

      if (!healthy) {
        ctx.ui.notify(
          `Headroom proxy unreachable at ${cfg.baseUrl}. Compression runs in passthrough mode. ${savingsNote} ${PROXY_START_HINT}`,
          "warning",
        );
        return;
      }

      try {
        const client = await getClient({ authStorage });
        const status = await client.health();
        ctx.ui.notify(
          `Headroom proxy healthy at ${cfg.baseUrl} (version ${status.version}). ${savingsNote}${compressionNote}`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Headroom proxy health check failed: ${message}`, "warning");
      }
    },
  });

  pi.registerCommand("headroom-authenticate", {
    description: "Securely save your Headroom proxy API key (input never visible to LLM).",
    handler: async (_args, ctx) => {
      const apiKey = await ctx.ui.input("Enter your Headroom proxy API key:");
      if (apiKey) {
        authStorage.set("headroom", { type: "api_key" as const, key: apiKey });
        ctx.ui.notify("Headroom API key saved successfully.", "info");
      } else {
        ctx.ui.notify("Authentication cancelled.", "warning");
      }
    },
  });

  // Compress the whole conversation before each LLM call (LD1). On a disabled
  // flag, a down proxy, or any failure this is a pure passthrough — returning
  // nothing leaves `event.messages` untouched (LD3).
  pi.on("context", async (event, ctx) => {
    try {
      if (pi.getFlag(DISABLE_FLAG) === true) return;
      if (!(await isHealthy({ authStorage }))) return;

      const cfg = await resolveConfig({ authStorage });
      const { messages, tokensSaved } = await compressMessages(event.messages, {
        model: ctx.model?.id,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
      });

      sessionTokensSaved = accumulateSavings(sessionTokensSaved, tokensSaved);
      return { messages };
    } catch {
      // Never throw into the agent loop (LD3); leave the conversation untouched.
      return;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    if (noticeShown) return;
    try {
      const healthy = await isHealthy({ authStorage });
      if (!healthy) {
        const cfg = await resolveConfig({ authStorage });
        noticeShown = true;
        ctx.ui.notify(
          `Headroom proxy not reachable at ${cfg.baseUrl}; running in passthrough mode (no compression). ${PROXY_START_HINT}`,
          "warning",
        );
      }
    } catch {
      // Never throw into the agent loop (LD3).
    }
  });
}
