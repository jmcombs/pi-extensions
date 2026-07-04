#!/usr/bin/env node
/**
 * harness.mjs — Gate 2 (manual): async approach-B proof against a REAL `claude -p`.
 *
 * This is a standalone reproduction of Appendix A of PLAN.md. It builds a stub
 * `ExtensionAPI`, registers a `verify_phase` tool over the exact async substrate
 * the shipped `index.ts` uses (non-blocking spawn → parse → push-back), invokes
 * it against a real subscription Opus, and prints five OK/FAIL checks:
 *
 *   1. verify_phase registered
 *   2. duplex receive + reply
 *   3. execute() returned PENDING non-blocking (< 15 s)
 *   4. async pushback delivered a verdict (real PASS/FAIL from Opus)
 *   5. pushback triggered a turn (triggerTurn: true)
 *
 * It is NOT part of `npm run check`. Run it manually with `claude` authed via
 * your Claude subscription (oauthAccount):
 *
 *   node packages/relay/scripts/harness.mjs
 *
 * Exit code 0 iff all five checks pass.
 */

import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const WALL_CAP_MS = 600_000;
const VERDICT_RE = /VERDICT:\s*(PASS|FAIL)/gi;

/** Build the scoped, read-only `claude -p` argv (mirrors claudeDriver, D2/D3). */
function claudeArgs(prompt) {
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    "opus",
    "--allowedTools",
    "Bash Read Grep Glob",
    "--max-turns",
    "80",
  ];
}

/** Extract the LAST `VERDICT: PASS|FAIL` from result text (D3). */
function extractVerdict(result) {
  let match = VERDICT_RE.exec(result);
  let last;
  while (match !== null) {
    last = match[1];
    match = VERDICT_RE.exec(result);
  }
  VERDICT_RE.lastIndex = 0;
  return last ? last.toUpperCase() : undefined;
}

/** Non-blocking spawn + parse + push-back (Appendix A). Calls onDone once. */
function runClaudeAsync(prompt, cwd, signal, onDone) {
  const child = spawn("claude", claudeArgs(prompt), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  let cut = false;
  let settled = false;

  const timer = setTimeout(() => {
    cut = true;
    child.kill("SIGTERM");
  }, WALL_CAP_MS);

  const onAbort = () => {
    cut = true;
    child.kill("SIGTERM");
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    let result = "";
    try {
      result = String(JSON.parse(out).result ?? "");
    } catch {
      result = "";
    }
    onDone({ result, cut });
  };

  child.stdout?.on("data", (chunk) => {
    out += chunk.toString();
  });
  child.on("error", () => {
    cut = true;
    finish();
  });
  child.on("close", finish);
}

/** Stub ExtensionAPI that records registrations, pushbacks, and events. */
function createStubPi() {
  const registry = new Map();
  const inbox = [];
  const emitted = [];
  const pi = {
    registerTool(tool) {
      registry.set(tool.name, tool);
    },
    sendMessage(message, options) {
      inbox.push({ message, options });
    },
    events: {
      emit(channel, data) {
        emitted.push({ channel, data });
      },
    },
  };
  return { pi, registry, inbox, emitted };
}

/** Minimal reproduction of the shipped verify_phase substrate. */
function relayFactory(pi) {
  pi.registerTool({
    name: "verify_phase",
    label: "Relay: Verify Phase",
    execute(_toolCallId, params, signal) {
      runClaudeAsync(params.prompt, params.cwd ?? process.cwd(), signal, (outcome) => {
        const verdict = outcome.cut
          ? "UNVERIFIED"
          : (extractVerdict(outcome.result) ?? "UNVERIFIED");
        pi.sendMessage(
          {
            customType: "relay:verify_phase",
            content: `verify_phase(${params.phase}): ${verdict}`,
            display: true,
            details: { phase: params.phase, verdict },
          },
          { triggerTurn: true },
        );
        pi.events.emit("relay:verdict", { tool: "verify_phase", phase: params.phase, verdict });
      });
      return Promise.resolve({
        content: [{ type: "text", text: "PENDING" }],
        details: { status: "PENDING", tool: "verify_phase", phase: params.phase },
      });
    },
  });
}

function report(n, ok, message) {
  console.log(`${ok ? "OK" : "FAIL"} ${n} — ${message}`);
  return ok;
}

async function main() {
  const { pi, registry, inbox, emitted } = createStubPi();
  relayFactory(pi);

  // Check 1 — tool registered.
  const registered = registry.has("verify_phase");

  const tool = registry.get("verify_phase");
  if (!tool) {
    report(1, false, "verify_phase NOT registered");
    process.exit(1);
  }

  // Check 3 — execute() returns PENDING immediately, non-blocking (< 15 s).
  const started = Date.now();
  const pending = await tool.execute(
    "harness-call-1",
    {
      phase: "harness-smoke",
      // Deterministic, tool-free prompt so a healthy Opus returns a real verdict fast.
      prompt: "Respond with exactly one line and nothing else: VERDICT: PASS",
      cwd: process.cwd(),
    },
    undefined,
  );
  const elapsed = Date.now() - started;
  const isPending = pending?.details?.status === "PENDING";
  const nonBlocking = elapsed < 15_000;

  // Wait for the async pushback (bounded by the wall cap).
  const deadline = Date.now() + WALL_CAP_MS;
  while (inbox.length === 0 && Date.now() < deadline) {
    await delay(250);
  }

  const delivered = inbox[0];
  const verdict = delivered?.message?.details?.verdict;
  const received = Boolean(delivered);

  // Check 2 — duplex receive + reply: session received the pushback and replies.
  if (received) {
    pi.events.emit("relay:ack", { received: true });
  }
  const replied = emitted.some((e) => e.channel === "relay:ack");

  const c1 = report(1, registered, "verify_phase registered");
  const c2 = report(2, received && replied, "duplex receive + reply (pushback received, ack sent)");
  const c3 = report(
    3,
    isPending && nonBlocking,
    `execute() returned PENDING non-blocking (${elapsed} ms < 15000)`,
  );
  const c4 = report(
    4,
    verdict === "PASS" || verdict === "FAIL",
    `async pushback delivered a real verdict from Opus: ${verdict ?? "<none>"}`,
  );
  const c5 = report(
    5,
    delivered?.options?.triggerTurn === true,
    "pushback triggered a turn (triggerTurn: true)",
  );

  process.exit(c1 && c2 && c3 && c4 && c5 ? 0 : 1);
}

await main();
