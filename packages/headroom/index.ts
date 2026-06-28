/**
 * @jmcombs/pi-headroom — context compression for the Pi coding agent.
 *
 * Phase 1 scaffold: stands up the package, a thin typed proxy client
 * (`client.ts`), and status/auth commands. No compression is wired yet — the
 * `context` hook arrives in Phase 2.
 *
 * The extension never throws into the agent loop (LD3) and never manages the
 * Headroom proxy lifecycle (LD4). The Python proxy is a user-managed
 * prerequisite documented in the README.
 *
 * Commands:
 *   - `/headroom-status`       — report proxy health + version.
 *   - `/headroom-authenticate` — securely store the proxy API key.
 *
 * Events:
 *   - `session_start` — emits a one-time, non-fatal notice when the proxy is
 *     unreachable so the session stays usable in passthrough mode.
 */

import { AuthStorage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getClient, isHealthy, resolveConfig } from "./client.js";

const PROXY_START_HINT = "Start it with: ~/.headroom-venv/bin/headroom proxy --port 8787";

// ── Extension factory ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  const authStorage = AuthStorage.create();

  // Fires at most once per session (the factory runs once per session). We
  // only flip the flag when we actually emit a notice, so a proxy that goes
  // down after a healthy start still surfaces a single warning.
  let noticeShown = false;

  pi.registerCommand("headroom-status", {
    description: "Report Headroom proxy health and version.",
    handler: async (_args, ctx) => {
      const cfg = await resolveConfig({ authStorage });
      const healthy = await isHealthy({ authStorage });

      if (!healthy) {
        ctx.ui.notify(
          `Headroom proxy unreachable at ${cfg.baseUrl}. Compression runs in passthrough mode. ${PROXY_START_HINT}`,
          "warning",
        );
        return;
      }

      try {
        const client = await getClient({ authStorage });
        const status = await client.health();
        ctx.ui.notify(
          `Headroom proxy healthy at ${cfg.baseUrl} (version ${status.version}).`,
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
}
