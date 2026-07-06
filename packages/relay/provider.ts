/**
 * provider.ts — registers the `relay-claude` pi provider (Option B, Phase 3).
 *
 * A pi-subagent runs on an external coding agent simply by setting its `model` to
 * `relay-claude/<id>` (e.g. `relay-claude/opus`). pi's native `resolveModel` routes
 * that model to the custom `streamSimple` handler registered here; the handler
 * runs ONE headless `claude -p` through {@link claudeDriver} and streams the
 * external agent's final assistant text back as the completion.
 *
 * ── Single completion = one full `claude -p` run (single-turn) ──
 * The relayed subagent has NO pi-side tools; the external agent runs its OWN tool
 * loop and returns final text. So `streamSimple` emits exactly one assistant
 * message (`stop`), the child pi agent loop ends after one turn, and pi's native
 * subagent-async layer delivers the result. This supersedes relay's Phase-1/2
 * bespoke `verify_phase` tool + custom `sendMessage` pushback.
 *
 * ── Persona + skills (context → inlined content) ──
 * pi-subagents assembles the subagent persona body + a skill INJECTION into the
 * child pi's system prompt, which arrives here as `context.systemPrompt`. pi
 * injects skills as `<available_skills>` *references* (name/description/location),
 * expecting an on-demand `Read`. A headless `claude -p` may never read them, so we
 * {@link expandSkillReferences | inline each referenced `SKILL.md`'s full body}
 * before relaying the prompt to `claude` via `--system-prompt-file` (deterministic;
 * no re-echo, no drift). See `roles/resolver.ts` for the off-path fallback resolver.
 *
 * ── Stream (D11: use pi's API, never reinvent) ──
 * The completion is delivered through pi's own
 * `createAssistantMessageEventStream()` (`@earendil-works/pi-ai`, "for use in
 * extensions") — relay does NOT hand-roll the `AssistantMessageEventStream`
 * contract. Provider types are derived from `@earendil-works/pi-coding-agent`'s
 * `ProviderConfig`.
 *
 * Not affiliated with or endorsed by Anthropic. Claude and Opus are trademarks of
 * Anthropic, PBC.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { type AgentDriver, claudeDriver } from "./drivers/claude.js";
import { expandSkillReferences } from "./roles/resolver.js";

// ── Types derived from pi's ProviderConfig (resolve via its nested pi-ai) ──────
type StreamSimpleFn = NonNullable<ProviderConfig["streamSimple"]>;
type RelayModel = Parameters<StreamSimpleFn>[0];
type RelayContext = Parameters<StreamSimpleFn>[1];
type RelayStreamOptions = Parameters<StreamSimpleFn>[2];
type RelayStreamReturn = ReturnType<StreamSimpleFn>;
type RelayAssistantMessage = Awaited<ReturnType<RelayStreamReturn["result"]>>;

/** The pi provider name. `model: relay-claude/<id>` routes to this provider. */
export const RELAY_CLAUDE_PROVIDER = "relay-claude";

/** Wall-cap backstop (D6): default 600 s, overridable via `PI_RELAY_WALL_MS`. */
const DEFAULT_WALL_CAP_MS = 600_000;

/**
 * Heartbeat interval: default 20 s, overridable via `PI_RELAY_HEARTBEAT_MS`
 * (set to `0` to disable). A single `claude -p` run is one provider completion
 * that emits nothing until it finishes (~50–80 s for a verify), so pi-subagents'
 * parent run would otherwise see "no observed activity" and flip the child to
 * `needs_attention` at its 60 s threshold — a FALSE stall on a healthy loop.
 * We keep the run visibly alive by pushing periodic no-op stream beats (see
 * {@link streamViaDriver}); 20 s gives a comfortable margin under 60 s.
 */
const DEFAULT_HEARTBEAT_MS = 20_000;

/**
 * Models exposed by the provider. The pi model id after the slash (`opus`,
 * `sonnet`, `haiku`) is passed through as the driver's `--model` value. D1: the
 * verify role uses `relay-claude/opus`.
 */
const RELAY_CLAUDE_MODELS = [
  { id: "opus", name: "Relay Claude Opus" },
  { id: "sonnet", name: "Relay Claude Sonnet" },
  { id: "haiku", name: "Relay Claude Haiku" },
] as const;

/** Resolve the configured wall-cap in milliseconds (D6). */
function wallCapMs(): number {
  const raw = process.env.PI_RELAY_WALL_MS;
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WALL_CAP_MS;
}

/**
 * Resolve the heartbeat interval in milliseconds. A parsed value of `0` (or any
 * non-positive) DISABLES heartbeats (opt-out / A-B rollback); an absent or
 * unparseable value falls back to {@link DEFAULT_HEARTBEAT_MS}.
 */
function heartbeatMs(): number {
  const raw = process.env.PI_RELAY_HEARTBEAT_MS;
  if (raw === undefined) return DEFAULT_HEARTBEAT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_HEARTBEAT_MS;
  return parsed > 0 ? parsed : 0;
}

/** Extract the task text (concatenated user-message text) from the pi context. */
function extractTask(context: RelayContext): string {
  const parts: string[] = [];
  for (const message of context.messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") {
      parts.push(message.content);
    } else {
      for (const chunk of message.content) {
        if (chunk.type === "text") parts.push(chunk.text);
      }
    }
  }
  return parts.join("\n\n").trim();
}

/** Build a minimal final assistant message carrying `text`. */
function assistantMessage(model: RelayModel, text: string, isError = false): RelayAssistantMessage {
  const message = {
    role: "assistant",
    content: text.length > 0 ? [{ type: "text", text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: isError ? "error" : "stop",
    timestamp: Date.now(),
    ...(isError ? { errorMessage: text || "relay run produced no result" } : {}),
  };
  return message as unknown as RelayAssistantMessage;
}

/**
 * Run a single dispatch through `driver` and return an assistant-message event
 * stream. The stream opens with a `start` and then emits periodic no-op
 * `text_delta` beats (heartbeat — keeps a long, single-completion run from being
 * misread as a 60s stall; see the interval below) until it terminates with a
 * `done` event (the external agent's final text) or, on a cut / spawn-failure /
 * unparseable result, an `error` event — NEVER a silent success (D6 fail-safe: no
 * auto-PASS on a cut run). The verdict rides ONLY on the terminal event.
 */
export function streamViaDriver(
  driver: AgentDriver,
  model: RelayModel,
  context: RelayContext,
  signal?: AbortSignal,
): RelayStreamReturn {
  // D11: pi's own event-stream contract (for use in extensions) — not hand-rolled.
  const stream = createAssistantMessageEventStream();
  // Push events typed against our (structurally identical) message shape. The
  // `text_delta` beat carries an empty partial and drives pi's `message_update`
  // (heartbeat, below); the terminal result rides only on `done`/`error`.
  const push = stream.push.bind(stream) as (event: {
    type: "start" | "text_delta" | "done" | "error";
    reason?: string;
    contentIndex?: number;
    delta?: string;
    partial?: RelayAssistantMessage;
    message?: RelayAssistantMessage;
    error?: RelayAssistantMessage;
  }) => void;

  // Inline each referenced SKILL.md's full body into the child pi's assembled
  // system prompt (fidelity), then relay it to `claude` via --system-prompt-file.
  let systemPromptFile: string | undefined;
  let tempDir: string | undefined;
  const systemPrompt = expandSkillReferences(context.systemPrompt).trim();
  if (systemPrompt.length > 0) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-relay-"));
    systemPromptFile = path.join(tempDir, "system-prompt.md");
    fs.writeFileSync(systemPromptFile, systemPrompt, { mode: 0o600 });
  }

  // pi-neutral tool names; the driver applies the pi→backend tool map (D10).
  const tools = (context.tools ?? []).map((tool) => tool.name);

  const args = driver.buildArgs({
    task: extractTask(context),
    model: model.id,
    ...(systemPromptFile ? { systemPromptFile, systemPromptMode: "replace" as const } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  });

  const child = spawn(driver.bin, args, { stdio: ["ignore", "pipe", "pipe"] });

  let out = "";
  let cut = false;
  let settled = false;

  // ── Heartbeat (keeps a long, single-completion run visibly "active") ─────────
  // A `claude -p` run emits nothing on the stream until it finishes, so the
  // parent pi-subagent run would otherwise observe >60 s of "no activity" and
  // FALSELY flip the child to `needs_attention`. We open the stream with `start`
  // (so pi's agent-loop has a partial to update), then push a no-op `text_delta`
  // beat every `heartbeatMs()`. Each beat becomes a pi `message_update` — a JSONL
  // line on the child's stdout — which advances the parent's `lastActivityAt`.
  // The beats carry an EMPTY partial and are discarded when `done` swaps in the
  // real final message, so the verdict (D6/D10) is untouched. `settle` clears the
  // interval before pushing the terminal event; `push()` also no-ops post-settle.
  push({ type: "start", partial: assistantMessage(model, "") });
  const beatMs = heartbeatMs();
  const heartbeat =
    beatMs > 0
      ? setInterval(() => {
          if (settled) return;
          push({
            type: "text_delta",
            contentIndex: 0,
            delta: "",
            partial: assistantMessage(model, ""),
          });
        }, beatMs)
      : undefined;
  heartbeat?.unref?.();

  const cleanupTemp = (): void => {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort temp cleanup.
      }
    }
  };

  const timer = setTimeout(() => {
    cut = true;
    child.kill("SIGTERM");
  }, wallCapMs());

  const onAbort = (): void => {
    cut = true;
    child.kill("SIGTERM");
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const settle = (final: RelayAssistantMessage, isError: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    signal?.removeEventListener("abort", onAbort);
    cleanupTemp();
    // `start` was already pushed when the stream opened (see heartbeat, above);
    // the terminal event replaces the partial with the real final message.
    if (isError) {
      push({ type: "error", reason: "error", error: final });
    } else {
      push({ type: "done", reason: "stop", message: final });
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });

  child.on("error", (error: Error) => {
    // Spawn failure (e.g. missing binary) → fail-safe error, never auto-success.
    settle(
      assistantMessage(model, `relay: failed to run ${driver.bin} — ${error.message}`, true),
      true,
    );
  });

  child.on("close", () => {
    if (cut) {
      // D6: a cut run (wall-cap or abort) is UNVERIFIED, never PASS.
      settle(
        assistantMessage(
          model,
          "relay: run cut short (wall-cap or abort) before producing a result — UNVERIFIED",
          true,
        ),
        true,
      );
      return;
    }
    const parsed = driver.parseResult(out);
    if (parsed.isError) {
      // D6: ANY errored run is UNVERIFIED — never surface an is_error envelope as a
      // clean completion, even when it carries result text (an errored run's output
      // is untrustworthy and must not leak a verdict). This respects the envelope's
      // structured is_error flag, not the result text — D10-safe (the provider never
      // interprets verdict content).
      const detail =
        parsed.result.length === 0
          ? "backend produced no parseable result"
          : "backend reported is_error";
      settle(assistantMessage(model, `relay: ${detail} — UNVERIFIED`, true), true);
      return;
    }
    settle(assistantMessage(model, parsed.result), false);
  });

  return stream as unknown as RelayStreamReturn;
}

/** Register the `relay-claude` provider on the given pi extension API. */
export function registerRelayClaudeProvider(pi: ExtensionAPI): void {
  const config: ProviderConfig = {
    name: "Relay (Claude)",
    // `api` is required when registering a custom `streamSimple` handler.
    api: RELAY_CLAUDE_PROVIDER,
    // baseUrl + apiKey are required by provider validation when models are
    // defined, but are UNUSED here: the streamSimple handler shells out to
    // `claude -p`, which authenticates via its own subscription `oauthAccount`
    // (D1 — never an API key, never a network baseUrl from relay).
    baseUrl: "http://relay.invalid",
    apiKey: "relay-unused",
    streamSimple: (model, context, options: RelayStreamOptions) =>
      streamViaDriver(claudeDriver, model, context, options?.signal),
    models: RELAY_CLAUDE_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    })),
  };
  pi.registerProvider(RELAY_CLAUDE_PROVIDER, config);
}
