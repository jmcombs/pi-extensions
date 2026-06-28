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
 *   - `/headroom-status`       — report proxy health + version + mode + key
 *     settings + session and proxy lifetime savings.
 *   - `/headroom-authenticate` — securely store the proxy API key.
 *
 * Tools:
 *   - `headroom_retrieve` — recover content that lossy compression elided, via
 *     the inline CCR marker hash (`… Retrieve more: hash=<hash>`). ALWAYS
 *     registered — never gated by the disable flag or by compression being off
 *     (LD2) — and never throws into the agent loop (LD3).
 *
 * Flags:
 *   - `--headroom-no-compress` — disable compression for the session. Retrieve
 *     (Phase 3) stays enabled (LD2); only compression is turned off.
 *
 * Display (Phase 4 — read-only, LD9):
 *   - A persistent above-editor widget shows compression enabled state, proxy
 *     reachability (+ version), the proxy's current settings (mode + key tuning),
 *     and live stats (session tokens saved + proxy lifetime savings). It only
 *     READS proxy settings (`health()` / `proxyStats()`); it never sets `mode`
 *     or any proxy-side config (that would relaunch the proxy → LD4). The user
 *     changes proxy settings on their own.
 *
 * Events:
 *   - `context`       — compress the conversation before each LLM call (LD1) and
 *     refresh the live session figure in the status display.
 *   - `session_start` — emits a one-time, non-fatal notice when the proxy is
 *     unreachable so the session stays usable in passthrough mode, and primes
 *     the status display + proxy snapshot.
 */

import {
  AuthStorage,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { getClient, isHealthy, resolveConfig } from "./client.js";
import { compressMessages } from "./compress.js";
import {
  formatStatusLine,
  getProxyStatus,
  type ProxyStatusState,
  type StatusDisplayState,
} from "./status.js";

const PROXY_START_HINT = "Start it with: ~/.headroom-venv/bin/headroom proxy --port 8787";

/** CLI flag that disables compression for the session (retrieve stays on, LD2). */
const DISABLE_FLAG = "headroom-no-compress";

/** Stable key for the persistent above-editor status widget. */
const STATUS_WIDGET_KEY = "headroom";

/**
 * Minimum gap between proxy-snapshot refreshes. The session figure updates for
 * free on every compression pass; the proxy snapshot is an HTTP call, so it is
 * throttled and never fetched on every `context` event (no added agent-loop
 * latency; LD3).
 */
const PROXY_SNAPSHOT_TTL_MS = 30_000;

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

// ── headroom_retrieve tool (reversibility — LD2) ───────────────────────
// Compression is lossy on the surface: bulky tool results are crushed and the
// proxy embeds an inline CCR marker (`… Retrieve more: hash=<hash>`) into the
// compressed text. This tool lets the model recover the full original via that
// hash, so no detail elided by compression is ever truly lost. It is ALWAYS
// registered — never gated by `--headroom-no-compress` or by compression being
// off (LD2) — and it never throws into the agent loop (LD3).

/** Tool name the model calls; matches the proxy's CCR retrieval tool. */
const RETRIEVE_TOOL_NAME = "headroom_retrieve";

const retrieveSchema = Type.Object({
  hash: Type.String({
    description:
      "The CCR hash from a compression marker (the value after `hash=` in `… Retrieve more: hash=<hash>`).",
  }),
  query: Type.Optional(
    Type.String({
      description:
        "Optional search query to retrieve only the matching items from the stored original instead of the full content.",
    }),
  ),
});
type RetrieveInput = Static<typeof retrieveSchema>;

interface RetrieveDetails {
  hash: string;
  query?: string;
  error?: boolean;
  toolName?: string;
  originalTokens?: number;
  originalItemCount?: number;
  compressedItemCount?: number;
  retrievalCount?: number;
  matchCount?: number;
}

interface RetrieveToolResult {
  content: { type: "text"; text: string }[];
  details: RetrieveDetails;
}

/**
 * Execute a CCR retrieval against the proxy. Returns the original content as a
 * text result. An invalid/missing hash, a down proxy, or any other failure
 * returns a clear **non-throwing** error result (LD3) — never throws into the
 * agent loop. Retrieve is independent of compression: it works whenever the
 * proxy is reachable, regardless of the disable flag.
 */
async function retrieveExecute(
  params: RetrieveInput,
  args: { authStorage?: AuthStorage } = {},
): Promise<RetrieveToolResult> {
  const hash = params.hash;
  try {
    const client = await getClient({ authStorage: args.authStorage });
    const result = await client.retrieve(hash, params.query ? { query: params.query } : undefined);

    // Full retrieval (RetrieveResult) → the original content as text.
    if ("originalContent" in result) {
      return {
        content: [{ type: "text", text: result.originalContent }],
        details: {
          hash,
          query: params.query,
          toolName: result.toolName,
          originalTokens: result.originalTokens,
          originalItemCount: result.originalItemCount,
          compressedItemCount: result.compressedItemCount,
          retrievalCount: result.retrievalCount,
        },
      };
    }

    // Query retrieval (RetrieveSearchResult) → the matching items as text.
    const items = Array.isArray(result.results) ? result.results : [];
    const text = items
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item, null, 2)))
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: text || `No items matched query "${result.query}" for hash ${hash}.`,
        },
      ],
      details: { hash, query: result.query, matchCount: result.count },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Headroom retrieve failed for hash ${hash}: ${message}. The hash may be invalid/expired, or the Headroom proxy may be unreachable.`,
        },
      ],
      details: { hash, query: params.query, error: true },
    };
  }
}

/** Header line for a retrieve call, e.g. "headroom_retrieve 3e790a64…". */
function renderRetrieveCall(args: RetrieveInput, theme: Theme): Component {
  const shortHash = args.hash.length > 12 ? `${args.hash.slice(0, 12)}…` : args.hash;
  const detail = args.query ? `${shortHash} (query: ${args.query})` : shortHash;
  const label = theme.fg("toolTitle", theme.bold(RETRIEVE_TOOL_NAME));
  return new Text(`${label} ${theme.fg("accent", detail)}`, 0, 0);
}

/** Render the retrieved original text, truncated unless the row is expanded. */
function renderRetrieveResult(
  result: { content: readonly { type: string; text?: string }[] },
  isError: boolean,
  expanded: boolean,
  theme: Theme,
): Component {
  const full = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  if (!full) return new Container();

  const lines = full.split("\n");
  const limit = expanded ? lines.length : 20;
  const role = isError ? "error" : "toolOutput";
  let body = theme.fg(role, lines.slice(0, limit).join("\n"));

  const remaining = lines.length - limit;
  if (remaining > 0) {
    body += theme.fg(
      "muted",
      `\n… ${String(remaining)} more line${remaining === 1 ? "" : "s"} — expand to view`,
    );
  }
  return new Text(body, 0, 0);
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

  // Cached read-only snapshot of proxy reachability + settings + lifetime
  // savings (LD9). Refreshed at sensible points (session_start, disable-flag
  // toggle, short-TTL throttle) — never on every `context` call.
  let proxySnapshot: ProxyStatusState = { reachable: false };
  let proxySnapshotAt = 0;
  let proxyRefreshInFlight = false;
  // Last rendered enabled state, so a disable-flag toggle can force a refresh.
  let lastEnabled: boolean | undefined;

  /** Current enabled state (compression on unless the disable flag is set). */
  const isEnabled = (): boolean => pi.getFlag(DISABLE_FLAG) !== true;

  /**
   * Render the persistent status widget from the cached snapshot + the live
   * in-memory session figure. No-op (and never throws) when there's no UI;
   * additive only — never touches compression behavior.
   */
  const renderStatusDisplay = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const state: StatusDisplayState = { enabled: isEnabled(), ...proxySnapshot };
    try {
      ctx.ui.setWidget(STATUS_WIDGET_KEY, [formatStatusLine(state, sessionTokensSaved)], {
        placement: "aboveEditor",
      });
    } catch {
      // The display is purely informational; never let it disturb the loop (LD3).
    }
  };

  /**
   * Refresh the proxy snapshot in the background when stale (or forced), then
   * re-render. Fire-and-forget: never awaited from the `context` handler, so it
   * adds no latency to the agent loop (LD3). Read-only (LD9).
   */
  const refreshProxySnapshot = (ctx: ExtensionContext, force = false): void => {
    const stale = force || Date.now() - proxySnapshotAt > PROXY_SNAPSHOT_TTL_MS;
    if (!stale || proxyRefreshInFlight) return;
    proxyRefreshInFlight = true;
    void (async () => {
      try {
        const cfg = await resolveConfig({ authStorage });
        proxySnapshot = await getProxyStatus(cfg.baseUrl, cfg.apiKey);
        proxySnapshotAt = Date.now();
        renderStatusDisplay(ctx);
      } catch {
        // getProxyStatus never throws, but guard the config resolution too (LD3).
      } finally {
        proxyRefreshInFlight = false;
      }
    })();
  };

  /**
   * Update the display after a compression pass: re-render the (free) session
   * figure immediately, force a snapshot refresh on a disable-flag toggle, and
   * otherwise let the short-TTL throttle decide.
   */
  const updateDisplay = (ctx: ExtensionContext): void => {
    const enabled = isEnabled();
    const toggled = lastEnabled !== undefined && lastEnabled !== enabled;
    lastEnabled = enabled;
    renderStatusDisplay(ctx);
    refreshProxySnapshot(ctx, toggled);
  };

  // Disable compression for the session (retrieve stays enabled, LD2).
  pi.registerFlag(DISABLE_FLAG, {
    description: "Disable Headroom context compression for this session (retrieve stays enabled).",
    type: "boolean",
    default: false,
  });

  // Reversibility tool (LD2): ALWAYS registered, independent of the disable flag
  // and of whether compression ran — so any detail elided by lossy compression
  // is recoverable via its inline CCR hash. Never throws into the loop (LD3).
  pi.registerTool({
    name: RETRIEVE_TOOL_NAME,
    label: "Headroom Retrieve",
    description:
      "Recover original content that Headroom's lossy compression elided. When a tool result shows a marker like `… Retrieve more: hash=<hash>`, call this with that hash to get the full original text back. Pass an optional `query` to retrieve only matching items.",
    parameters: retrieveSchema,
    execute: (_toolCallId, params) => retrieveExecute(params, { authStorage }),
    renderCall: (args, theme) => renderRetrieveCall(args, theme),
    renderResult: (result, options, theme, context) =>
      renderRetrieveResult(result, context.isError, options.expanded, theme),
  });

  pi.registerCommand("headroom-status", {
    description:
      "Report Headroom proxy health, version, mode, key settings, and session + proxy token savings.",
    handler: async (_args, ctx) => {
      const cfg = await resolveConfig({ authStorage });
      // Read-only status snapshot (LD9): health + version + mode + tuning +
      // proxy lifetime savings. Refresh the cached snapshot so the command and
      // the persistent widget agree.
      const status = await getProxyStatus(cfg.baseUrl, cfg.apiKey);
      proxySnapshot = status;
      proxySnapshotAt = Date.now();
      renderStatusDisplay(ctx);

      const line = formatStatusLine({ enabled: isEnabled(), ...status }, sessionTokensSaved);

      if (!status.reachable) {
        ctx.ui.notify(`${line} (at ${cfg.baseUrl}). ${PROXY_START_HINT}`, "warning");
        return;
      }
      ctx.ui.notify(`${line} (at ${cfg.baseUrl}).`, "info");
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
      if (pi.getFlag(DISABLE_FLAG) === true) {
        // Compression is off, but keep the display honest: reflect the toggle
        // and (only on a real change) refresh the proxy snapshot.
        updateDisplay(ctx);
        return;
      }
      if (!(await isHealthy({ authStorage }))) {
        updateDisplay(ctx);
        return;
      }

      const cfg = await resolveConfig({ authStorage });
      const { messages, tokensSaved } = await compressMessages(event.messages, {
        model: ctx.model?.id,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
      });

      sessionTokensSaved = accumulateSavings(sessionTokensSaved, tokensSaved);
      // Refresh the live session figure (free) and let the throttle decide on
      // the proxy snapshot — never an extra blocking HTTP call here (LD3).
      updateDisplay(ctx);
      return { messages };
    } catch {
      // Never throw into the agent loop (LD3); leave the conversation untouched.
      return;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    // Prime the proxy snapshot + persistent display once per session, then
    // render. Read-only (LD9) and never throws into the loop (LD3).
    lastEnabled = isEnabled();
    refreshProxySnapshot(ctx, true);
    renderStatusDisplay(ctx);

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
