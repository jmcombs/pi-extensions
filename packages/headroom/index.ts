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
import { HeadroomClient, type OpenAIMessage, type RetrieveResult, simulate } from "headroom-ai";
import { type Static, Type } from "typebox";
import { augmentWithAutoRetrieve } from "./autoretrieve.js";
import { getClient, isHealthy, resetClient, resolveConfig } from "./client.js";
import { compressMessages } from "./compress.js";
import { filterByQuery } from "./query.js";
import {
  formatStatusLine,
  formatStatusWidget,
  getProxyStatus,
  humanizeTokens,
  type ProxyStatusState,
  type StatusDisplayState,
} from "./status.js";

const PROXY_START_HINT = "Start it with: ~/.headroom-venv/bin/headroom proxy --port 8787";

/** CLI flag that disables compression for the session (retrieve stays on, LD2). */
const DISABLE_FLAG = "headroom-no-compress";

/**
 * CLI flag that disables query-aware auto-retrieve. When compression crushes a
 * bulky result, the `context` hook normally re-injects the line(s) matching the
 * user's latest question so recall is model-independent (the model needn't call
 * `headroom_retrieve`). This flag reverts to retrieve-on-demand only.
 */
const AUTORETRIEVE_DISABLE_FLAG = "headroom-no-autoretrieve";

/** Max distinct CCR markers auto-retrieve will expand on one user turn. */
const AUTORETRIEVE_MAX_MARKERS = 3;

/** Stable key for the persistent above-editor status widget. */
const STATUS_WIDGET_KEY = "headroom";

/**
 * Delay before the one extra startup re-render of the status widget. The TUI
 * orders above-editor widgets by *last render*, and `setWidget` re-appends on
 * every call. When the proxy is reachable our snapshot probe takes two HTTP
 * round-trips, so our re-render naturally lands after other extensions' startup
 * widgets (e.g. a prompt enhancer) and we sit at the bottom. When the proxy is
 * **down**, the probe fails instantly, so without this our re-render would land
 * *before* those widgets and leave us stranded above them. A single deferred
 * re-render makes both paths settle identically — always last, always bottom.
 */
const WIDGET_SETTLE_MS = 300;

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

const STATS_TIMEOUT_MS = 3_000;

/** Coerce to a finite number, or `undefined`. */
function asNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Coerce to a non-empty string, or `undefined`. */
function asStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Coerce to a `Record<string, number>` (drops non-numeric entries), or `undefined`. */
function asNumMap(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const n = asNum(v);
    if (n !== undefined) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ── headroom-stats: detailed on-demand statistics (LD9 read-only) ───────
// The DETAILED counterpart to the Phase 4 at-a-glance status display. It reads
// the FULL `client.proxyStats()` runtime object — richer than `formatStatusLine`
// — surfacing lifetime savings + compression %, request counts, the proxy's
// effective tuning, and a per-strategy savings breakdown. It only READS proxy
// state (LD9) and never throws into the loop (LD3).

/**
 * The detailed fields this extension reads from the live `proxyStats()` runtime
 * object. Field provenance was verified empirically against the live proxy
 * (v0.27.0) — the SDK's published `ProxyStats` type omits most of these:
 *   - `mode`                  ← `summary.mode`
 *   - `lifetimeTokensSaved`   ← `tokens.saved`
 *   - `savingsPercent`        ← `tokens.savingsPercent`
 *   - `apiRequests`           ← `summary.apiRequests`
 *   - `requestsCompressed`    ← `summary.compression.requestsCompressed`
 *   - `avgCompressionPct`     ← `summary.compression.avgCompressionPct`
 *   - `targetRatio`           ← `config.targetRatio`
 *   - `protectRecent`         ← `config.protectRecent`
 *   - `compressUserMessages`  ← `config.compressUserMessages`
 *   - `minTokensToCrush`      ← `config.minTokensToCrush`
 *   - `maxItemsAfterCrush`    ← `config.maxItemsAfterCrush`
 *   - `tokensSavedByStrategy` ← `tokensSavedByStrategy`
 *   - `compressionsByStrategy`← `compressionsByStrategy`
 */
export interface DetailedStats {
  mode?: string;
  lifetimeTokensSaved?: number;
  savingsPercent?: number;
  apiRequests?: number;
  requestsCompressed?: number;
  avgCompressionPct?: number;
  targetRatio?: number;
  protectRecent?: number;
  compressUserMessages?: boolean;
  minTokensToCrush?: number;
  maxItemsAfterCrush?: number;
  tokensSavedByStrategy?: Record<string, number>;
  compressionsByStrategy?: Record<string, number>;
}

/**
 * Map a live `proxyStats()` runtime object onto `DetailedStats`. Pure and
 * exported so the shaping can be unit-tested with an injected stub and **no
 * network**; tolerates missing/`null` fields (anything absent → `undefined`).
 */
export function extractDetailedStats(stats: unknown): DetailedStats {
  const raw = (stats ?? {}) as {
    summary?: {
      mode?: unknown;
      apiRequests?: unknown;
      compression?: { requestsCompressed?: unknown; avgCompressionPct?: unknown } | null;
    } | null;
    tokens?: { saved?: unknown; savingsPercent?: unknown } | null;
    config?: {
      targetRatio?: unknown;
      protectRecent?: unknown;
      compressUserMessages?: unknown;
      minTokensToCrush?: unknown;
      maxItemsAfterCrush?: unknown;
    } | null;
    tokensSavedByStrategy?: unknown;
    compressionsByStrategy?: unknown;
  };
  const summary = raw.summary ?? {};
  const compression = summary.compression ?? {};
  const tokens = raw.tokens ?? {};
  const config = raw.config ?? {};

  return {
    mode: asStr(summary.mode),
    lifetimeTokensSaved: asNum(tokens.saved),
    savingsPercent: asNum(tokens.savingsPercent),
    apiRequests: asNum(summary.apiRequests),
    requestsCompressed: asNum(compression.requestsCompressed),
    avgCompressionPct: asNum(compression.avgCompressionPct),
    targetRatio: asNum(config.targetRatio),
    protectRecent: asNum(config.protectRecent),
    compressUserMessages:
      typeof config.compressUserMessages === "boolean" ? config.compressUserMessages : undefined,
    minTokensToCrush: asNum(config.minTokensToCrush),
    maxItemsAfterCrush: asNum(config.maxItemsAfterCrush),
    tokensSavedByStrategy: asNumMap(raw.tokensSavedByStrategy),
    compressionsByStrategy: asNumMap(raw.compressionsByStrategy),
  };
}

/** State for the detailed stats report (proxy reachability + detail). */
export interface StatsReportState {
  reachable: boolean;
  version?: string;
  baseUrl: string;
  detail?: DetailedStats;
}

/** Round a 0..1 ratio or a 0..100 percent to a whole percent string. */
function asPercent(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const pct = value <= 1 ? value * 100 : value;
  return `${Math.round(pct)}%`;
}

/**
 * Render the multi-line detailed stats report. Pure — no I/O, never throws.
 * Shows the live session figure plus the proxy's lifetime savings, request
 * counts, effective tuning, and per-strategy breakdown when reachable; a single
 * unreachable line (keeping the free session figure) otherwise.
 */
export function formatStatsReport(state: StatsReportState, sessionTokensSaved: number): string {
  const session = Number.isFinite(sessionTokensSaved) ? sessionTokensSaved : 0;
  const sessionLine = `Session: saved ${humanizeTokens(session)} tokens this session`;

  if (!state.reachable) {
    return [
      `Headroom stats — proxy unreachable at ${state.baseUrl}`,
      sessionLine,
      PROXY_START_HINT,
    ].join("\n");
  }

  const d = state.detail ?? {};
  const lines: string[] = [];
  lines.push(
    `Headroom stats — proxy ${state.version ?? "unknown"}${d.mode ? ` · mode ${d.mode}` : ""}`,
  );
  lines.push(sessionLine);

  // Lifetime savings + request counts.
  if (d.lifetimeTokensSaved !== undefined) {
    const pct = asPercent(d.savingsPercent);
    lines.push(
      `Lifetime: saved ${humanizeTokens(d.lifetimeTokensSaved)} tokens${pct ? ` (${pct} compression)` : ""}`,
    );
  }
  if (d.apiRequests !== undefined || d.requestsCompressed !== undefined) {
    const reqParts: string[] = [];
    if (d.apiRequests !== undefined) reqParts.push(`${d.apiRequests} requests`);
    if (d.requestsCompressed !== undefined) reqParts.push(`${d.requestsCompressed} compressed`);
    const avg = asPercent(d.avgCompressionPct);
    if (avg && d.avgCompressionPct) reqParts.push(`avg ${avg}`);
    if (reqParts.length > 0) lines.push(`Requests: ${reqParts.join(" · ")}`);
  }

  // Effective proxy tuning (read-only; LD9).
  const cfg: string[] = [];
  cfg.push(`target ${d.targetRatio !== undefined ? d.targetRatio : "default"}`);
  cfg.push(`protect ${d.protectRecent !== undefined ? d.protectRecent : "default"}`);
  cfg.push(`user-msgs ${d.compressUserMessages ? "on" : "off"}`);
  if (d.minTokensToCrush !== undefined) cfg.push(`min-crush ${d.minTokensToCrush}`);
  if (d.maxItemsAfterCrush !== undefined) cfg.push(`max-items ${d.maxItemsAfterCrush}`);
  lines.push(`Config: ${cfg.join(" · ")}`);

  // Per-strategy breakdown (saved tokens + count), richest strategies first.
  const byStrategy = d.tokensSavedByStrategy;
  if (byStrategy && Object.keys(byStrategy).length > 0) {
    const counts = d.compressionsByStrategy ?? {};
    const entries = Object.entries(byStrategy)
      .sort((a, b) => b[1] - a[1])
      .map(([name, saved]) => {
        const count = counts[name];
        return `${name} ${humanizeTokens(saved)}${count !== undefined ? ` (${count})` : ""}`;
      });
    lines.push(`By strategy: ${entries.join(" · ")}`);
  }

  return lines.join("\n");
}

/**
 * Read the proxy's reachability + version + detailed stats. Read-only (LD9),
 * never manages the proxy (LD4), and **never throws** (LD3) — returns
 * `{ reachable: false }` on any error.
 */
async function getDetailedStats(
  baseUrl?: string,
  apiKey?: string,
): Promise<Omit<StatsReportState, "baseUrl">> {
  try {
    const client = new HeadroomClient({
      baseUrl,
      apiKey,
      fallback: true,
      timeout: STATS_TIMEOUT_MS,
    });
    const health = await client.health();
    if (health?.status !== "healthy") return { reachable: false };
    let detail: DetailedStats | undefined;
    try {
      detail = extractDetailedStats(await client.proxyStats());
    } catch {
      detail = undefined;
    }
    return { reachable: true, version: asStr(health.version), detail };
  } catch {
    return { reachable: false };
  }
}

// ── headroom-simulate: dry-run projection (no LLM call) ─────────────────
// `simulate()` is Headroom's documented **dry-run**: it tokenizes and runs the
// compression pipeline WITHOUT contacting any LLM, returning the projected token
// savings and the transforms that would fire. Headroom protects recent user
// turns (Phase 0), so a pasted blob is presented as a *stale tool result* (with
// a trailing user turn) — exactly the position compression actually operates on
// — to show what compression would do to that content.

/**
 * Wrap a pasted blob as a minimal conversation in which the blob is a stale
 * `read_file` tool result (not the most-recent, recency-protected message), so
 * `simulate()` projects the compression Headroom would really apply to it. The
 * blob is presented as bulky file output — the canonical thing compression
 * targets; the proxy protects recent turns and excludes its own intercept tools,
 * so a generic file-read result is the representative crushable case.
 */
export function buildSimulationMessages(blob: string): OpenAIMessage[] {
  return [
    { role: "user", content: "Please review the following output." },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "headroom_sim",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"pasted-input"}' },
        },
      ],
    },
    { role: "tool", content: blob, tool_call_id: "headroom_sim" },
    { role: "user", content: "Summarize the key points." },
  ];
}

/**
 * The fields this extension reads from the live `simulate()` runtime object.
 * Verified empirically against the live proxy (v0.27.0): the published
 * `SimulationResult` type is stale (it names `transforms`/`estimatedSavings`/
 * `wasteSignals`, all `undefined` at runtime); the real dry-run returns
 * `tokensBefore`/`tokensAfter`/`tokensSaved`/`compressionRatio`/
 * `transformsApplied`/`transformsSummary`/`ccrHashes`.
 */
export interface SimulationSummary {
  tokensBefore?: number;
  tokensAfter?: number;
  tokensSaved?: number;
  compressionRatio?: number;
  transformsSummary?: Record<string, number>;
}

/** Map a live `simulate()` runtime object onto `SimulationSummary` (pure). */
export function extractSimulation(raw: unknown): SimulationSummary {
  const r = (raw ?? {}) as {
    tokensBefore?: unknown;
    tokensAfter?: unknown;
    tokensSaved?: unknown;
    compressionRatio?: unknown;
    transformsSummary?: unknown;
  };
  return {
    tokensBefore: asNum(r.tokensBefore),
    tokensAfter: asNum(r.tokensAfter),
    tokensSaved: asNum(r.tokensSaved),
    compressionRatio: asNum(r.compressionRatio),
    transformsSummary: asNumMap(r.transformsSummary),
  };
}

/**
 * Render the dry-run projection. Pure — no I/O, never throws. Honest about a
 * non-compressible blob (`saved 0`). Example:
 *
 *   Headroom simulate (dry-run, no LLM call) — 18,360 chars in
 *   Projected: 27.3k → 8k tokens · saved 19.4k (71%)
 *   Transforms: smartCrusher ×1 · protected:userMessage ×2
 */
export function formatSimulationReport(sim: SimulationSummary, blobChars: number): string {
  const before = sim.tokensBefore ?? 0;
  const after = sim.tokensAfter ?? 0;
  const saved = sim.tokensSaved ?? 0;
  const pct = before > 0 ? `${Math.round((saved / before) * 100)}%` : "0%";

  const lines: string[] = [];
  lines.push(
    `Headroom simulate (dry-run, no LLM call) — ${blobChars.toLocaleString("en-US")} chars in`,
  );
  lines.push(
    `Projected: ${humanizeTokens(before)} → ${humanizeTokens(after)} tokens · saved ${humanizeTokens(saved)} (${pct})${
      saved <= 0 ? " — this content would not compress" : ""
    }`,
  );

  const summary = sim.transformsSummary;
  if (summary && Object.keys(summary).length > 0) {
    const entries = Object.entries(summary)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name.replace(/^router:/, "")} ×${count}`);
    lines.push(`Transforms: ${entries.join(" · ")}`);
  }

  return lines.join("\n");
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
    description: "The CCR hash from a Headroom compression marker (the value after `hash=`).",
  }),
  query: Type.Optional(
    Type.String({
      description:
        "A few words describing the specific detail or line you need (e.g. an id, hostname, error, or filename). The tool returns the matching line(s) from the recovered original instead of the whole thing — strongly recommended for large outputs. Omit to get the full original.",
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
  /** Set when a query matched nothing and we fell back to the full original. */
  fellBackToFull?: boolean;
  /** Set when a query was satisfied by client-side line filtering of the original. */
  filteredClientSide?: boolean;
}

/** Minimal client surface this tool needs — lets tests inject a no-network stub. */
type RetrieveClient = Pick<HeadroomClient, "retrieve">;

/** Shape a full RetrieveResult into a tool result carrying the original content. */
function fullRetrieveResult(
  hash: string,
  result: RetrieveResult,
  query: string | undefined,
): RetrieveToolResult {
  return {
    content: [{ type: "text", text: result.originalContent }],
    details: {
      hash,
      query,
      toolName: result.toolName,
      originalTokens: result.originalTokens,
      originalItemCount: result.originalItemCount,
      compressedItemCount: result.compressedItemCount,
      retrievalCount: result.retrievalCount,
    },
  };
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
export async function retrieveExecute(
  params: RetrieveInput,
  args: { authStorage?: AuthStorage; client?: RetrieveClient } = {},
): Promise<RetrieveToolResult> {
  const hash = params.hash;
  const query = params.query;
  try {
    const client = args.client ?? (await getClient({ authStorage: args.authStorage }));
    // Always fetch the full original (it is content-addressed and local). We
    // filter client-side rather than rely on the proxy's semantic query search,
    // which misses ordinary substrings (e.g. `txn 147`).
    const full = await client.retrieve(hash);

    if (!("originalContent" in full)) {
      // Defensive: proxy responded but with no original content. Non-throwing (LD3).
      return {
        content: [
          { type: "text", text: `Headroom could not retrieve the original for hash ${hash}.` },
        ],
        details: { hash, query },
      };
    }

    // With a query, return only the matching line(s) so the model gets a short,
    // focused result it can actually read — not a huge dump it gives up on.
    if (query) {
      const matches = filterByQuery(full.originalContent, query);
      if (matches && matches.length > 0) {
        const header = `(Showing ${matches.length} line${matches.length === 1 ? "" : "s"} matching "${query}" from the recovered original. Call again without a query for the full content.)\n\n`;
        return {
          content: [{ type: "text", text: header + matches.join("\n") }],
          details: {
            hash,
            query,
            toolName: full.toolName,
            originalTokens: full.originalTokens,
            originalItemCount: full.originalItemCount,
            compressedItemCount: full.compressedItemCount,
            retrievalCount: full.retrievalCount,
            matchCount: matches.length,
            filteredClientSide: true,
          },
        };
      }
      // Query carried no signal / matched no line → return the full original so
      // the detail is never lost.
      const prefix = `(Query "${query}" matched no lines; showing the full recovered original below.)\n\n`;
      return {
        content: [{ type: "text", text: prefix + full.originalContent }],
        details: {
          hash,
          query,
          toolName: full.toolName,
          originalTokens: full.originalTokens,
          originalItemCount: full.originalItemCount,
          compressedItemCount: full.compressedItemCount,
          retrievalCount: full.retrievalCount,
          matchCount: 0,
          fellBackToFull: true,
        },
      };
    }

    // No query → the full original.
    return fullRetrieveResult(hash, full, query);
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
      ctx.ui.setWidget(STATUS_WIDGET_KEY, [formatStatusWidget(state, sessionTokensSaved)], {
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

  // Query-aware auto-retrieve (Phase 6): on by default so recall works across
  // models without the model having to call `headroom_retrieve`. The flag turns
  // it off, reverting to retrieve-on-demand.
  pi.registerFlag(AUTORETRIEVE_DISABLE_FLAG, {
    description:
      "Disable Headroom query-aware auto-retrieve (re-injecting compressed lines that match your question).",
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
      "Recover original content that Headroom's lossy compression elided. When a tool result shows a marker naming this tool with a `hash=<hash>`, call this with that hash. Pass a `query` describing the specific detail you need (an id, hostname, error, filename, …) to get back just the matching line(s) instead of the whole original — recommended for large outputs.",
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

  // Detailed, on-demand statistics — the richer counterpart to the Phase 4
  // at-a-glance status display. Reads the FULL proxyStats() runtime (LD9
  // read-only) and folds in the live in-memory session figure. Never throws
  // into the loop (LD3).
  pi.registerCommand("headroom-stats", {
    description:
      "Show detailed Headroom statistics: session + lifetime savings, request counts, proxy tuning, and a per-strategy breakdown.",
    handler: async (_args, ctx) => {
      const cfg = await resolveConfig({ authStorage });
      const stats = await getDetailedStats(cfg.baseUrl, cfg.apiKey);
      const report = formatStatsReport({ ...stats, baseUrl: cfg.baseUrl }, sessionTokensSaved);
      ctx.ui.notify(report, stats.reachable ? "info" : "warning");
    },
  });

  // Dry-run projection of what compression WOULD do to a pasted blob — no LLM
  // call (`simulate()` only tokenizes + runs the pipeline). Never throws (LD3).
  pi.registerCommand("headroom-simulate", {
    description:
      "Dry-run Headroom compression on pasted text (no LLM call): projected token savings + transforms.",
    handler: async (args, ctx) => {
      const blob = (args ?? "").trim();
      if (!blob) {
        ctx.ui.notify(
          "Headroom simulate: paste text after the command, e.g. `/headroom-simulate <blob>`.",
          "warning",
        );
        return;
      }
      try {
        const cfg = await resolveConfig({ authStorage });
        const raw = await simulate(buildSimulationMessages(blob), {
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          timeout: STATS_TIMEOUT_MS,
        });
        const report = formatSimulationReport(extractSimulation(raw), blob.length);
        ctx.ui.notify(report, "info");
      } catch {
        // Dry-run only; a down/unreachable proxy must not throw into the loop (LD3).
        ctx.ui.notify(
          `Headroom simulate failed — the proxy may be unreachable. ${PROXY_START_HINT}`,
          "warning",
        );
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

      // Query-aware auto-retrieve (Phase 6): when the latest turn is a user
      // question against compressed content, re-inject the line(s) that match it
      // so recall is model-independent. Only touches messages on a real match;
      // never throws (the helper swallows retrieve errors, LD3).
      if (pi.getFlag(AUTORETRIEVE_DISABLE_FLAG) !== true) {
        const client = await getClient({ authStorage });
        const augmented = await augmentWithAutoRetrieve(messages, client, {
          maxMarkers: AUTORETRIEVE_MAX_MARKERS,
        });
        return { messages: augmented.messages };
      }
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
    // One deferred re-render so we reliably land at the bottom of the
    // above-editor stack even when the proxy is down (see WIDGET_SETTLE_MS).
    setTimeout(() => renderStatusDisplay(ctx), WIDGET_SETTLE_MS);

    if (noticeShown) return;
    try {
      // Retry health check up to 3 times with 500ms backoff to handle
      // startup race where proxy binds after Pi loads extensions (LD3).
      let healthy = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) resetClient();
        healthy = await isHealthy({ authStorage });
        if (healthy) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
      }
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
