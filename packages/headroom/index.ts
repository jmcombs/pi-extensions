/**
 * @jmcombs/pi-headroom — context compression for the Pi coding agent.
 *
 * Phase 2: compresses the **whole conversation** before each LLM call via Pi's
 * `context` event (LD1), accumulates per-session token savings, and exposes a
 * flag to disable compression. The status/auth commands and proxy client land
 * in Phase 1.
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
 *     stays enabled (LD2); this only turns off the `context` compression pass.
 *
 * Events:
 *   - `session_start` — emits a one-time, non-fatal notice when the proxy is
 *     unreachable so the session stays usable in passthrough mode.
 *   - `context` — compresses the whole `messages` array before each LLM call;
 *     pure passthrough when disabled, the proxy is down, or anything throws.
 */

import { AuthStorage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getClient, isHealthy, resolveConfig } from "./client.js";
import { compressMessages } from "./compress.js";

const PROXY_START_HINT = "Start it with: ~/.headroom-venv/bin/headroom proxy --port 8787";

/** CLI flag that disables compression (but never retrieve — LD2). */
const DISABLE_COMPRESSION_FLAG = "headroom-no-compress";

// ── Session savings accumulator (pure, no network) ─────────────────────

/** A read-only snapshot of accumulated session savings. */
export interface SavingsSnapshot {
  /** Total tokens saved across every compression this session. */
  totalTokensSaved: number;
  /** Number of compression passes that ran (regardless of savings). */
  compressions: number;
}

/** Accumulates token savings across `context`-event compressions. */
export interface SavingsAccumulator {
  /** Record one compression pass's `tokensSaved` (negatives clamp to 0). */
  record(tokensSaved: number): void;
  /** Current totals. */
  snapshot(): SavingsSnapshot;
}

/**
 * Create a pure in-memory savings accumulator. Non-finite or negative values
 * are clamped to `0` so a misbehaving proxy can never corrupt the running
 * total. Exported so the unit suite can exercise it with no network.
 */
export function createSavingsAccumulator(): SavingsAccumulator {
  let totalTokensSaved = 0;
  let compressions = 0;

  return {
    record(tokensSaved: number): void {
      compressions += 1;
      if (Number.isFinite(tokensSaved) && tokensSaved > 0) {
        totalTokensSaved += tokensSaved;
      }
    },
    snapshot(): SavingsSnapshot {
      return { totalTokensSaved, compressions };
    },
  };
}

// ── Extension factory ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  const authStorage = AuthStorage.create();
  const savings = createSavingsAccumulator();

  // LD2: compression may be disabled per session; retrieve is never gated here.
  pi.registerFlag(DISABLE_COMPRESSION_FLAG, {
    description: "Disable Headroom conversation compression for this session.",
    type: "boolean",
    default: false,
  });

  // Fires at most once per session (the factory runs once per session). We
  // only flip the flag when we actually emit a notice, so a proxy that goes
  // down after a healthy start still surfaces a single warning.
  let noticeShown = false;

  pi.registerCommand("headroom-status", {
    description: "Report Headroom proxy health, version, and session savings.",
    handler: async (_args, ctx) => {
      const cfg = await resolveConfig({ authStorage });
      const healthy = await isHealthy({ authStorage });
      const { totalTokensSaved, compressions } = savings.snapshot();
      const savingsLine = `Session savings: ${totalTokensSaved} tokens across ${compressions} compressions.`;

      if (!healthy) {
        ctx.ui.notify(
          `Headroom proxy unreachable at ${cfg.baseUrl}. Compression runs in passthrough mode. ${savingsLine} ${PROXY_START_HINT}`,
          "warning",
        );
        return;
      }

      try {
        const client = await getClient({ authStorage });
        const status = await client.health();
        ctx.ui.notify(
          `Headroom proxy healthy at ${cfg.baseUrl} (version ${status.version}). ${savingsLine}`,
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

  // LD1: compress the whole conversation before each LLM call.
  pi.on("context", async (event, ctx) => {
    // LD2: a session may disable compression; retrieve is unaffected.
    if (pi.getFlag(DISABLE_COMPRESSION_FLAG) === true) {
      return; // passthrough — leave event.messages untouched.
    }

    try {
      // LD3: when the cached probe says the proxy is down, do no network work.
      if (!(await isHealthy({ authStorage }))) {
        return; // passthrough.
      }

      const cfg = await resolveConfig({ authStorage });
      const { messages, tokensSaved } = await compressMessages(event.messages, {
        model: ctx.model?.id,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
      });

      savings.record(tokensSaved);
      // compress() returns messages in the same format it received them.
      return { messages: messages as typeof event.messages };
    } catch {
      // LD3 — never throw into the agent loop; passthrough on any error.
      return;
    }
  });
}
