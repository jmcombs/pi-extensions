#!/usr/bin/env node
/**
 * live-session.mjs — Gate 2.1 (manual): live-session integration proof.
 *
 * Phase 1's `harness.mjs` proved the async substrate against a STUB
 * `ExtensionAPI`. It could not prove the one thing that only the real runtime
 * can: that `pi.sendMessage(…, { triggerTurn: true })` actually delivers the
 * asynchronous verdict back into a live session as a FOLLOW-UP TURN.
 *
 * This harness closes that gap end-to-end. It launches a real `pi` session in
 * RPC mode (`pi --mode rpc`) with the shipped extension loaded
 * (`-e ./packages/relay`), drives a user prompt that makes the session's model
 * call `verify_phase`, keeps the session ALIVE, and observes — from the real
 * runtime's own event stream — that:
 *
 *   1. verify_phase registered + invoked by the live model.
 *   2. execute() returned PENDING immediately, non-blocking (< 15 s).
 *   3. the agent went IDLE after the PENDING return (first agent_end), i.e. the
 *      tool did not block the turn (D4).
 *   4. an ASYNC follow-up turn carrying `VERDICT: PASS|FAIL` arrived via the
 *      `sendMessage(triggerTurn:true)` pushback (a fresh agent_start AFTER the
 *      session was idle, and a relay custom message with the verdict).
 *   5. Q1 timing: whether triggerTurn fired IMMEDIATELY on delivery (agent idle)
 *      or was queued until some later idle checkpoint.
 *
 * The verdict itself comes from a REAL subscription `claude -p` (Opus) spawned
 * by the extension; the driving pi-session model is a cheap Anthropic model used
 * only to invoke the tool and acknowledge the follow-up. This is NOT part of
 * `npm run check`. Run it manually with `pi` and `claude` both authed:
 *
 *   node packages/relay/scripts/live-session.mjs
 *
 * Exit code 0 iff the live async follow-up delivery is observed.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

// ── Config ─────────────────────────────────────────────────────────────

/** Absolute path to the shipped extension package (loaded via `pi -e`). */
const RELAY_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Cheap Anthropic model to DRIVE the session (invoke the tool + ack). The
 *  verify backend is always subscription Opus via `claude -p` inside the tool. */
const DRIVER_MODEL = "anthropic/claude-haiku-4-5";

/** A deterministic, tool-free verify prompt so the real Opus dispatch returns a
 *  verdict in seconds (mirrors harness.mjs). */
const FAST_VERDICT_PROMPT = "Respond with exactly one line and nothing else: VERDICT: PASS";

/** The user turn that instructs the driver model to call verify_phase now. */
const USER_PROMPT = [
  "Call the verify_phase tool immediately, exactly once, with these arguments and",
  "nothing else:",
  `{"phase":"live-smoke","prompt":${JSON.stringify(FAST_VERDICT_PROMPT)}}.`,
  "The tool returns PENDING right away; the real verdict arrives later as a",
  "follow-up message. When that verdict message arrives, reply with one short",
  "sentence acknowledging the verdict. Do not call any other tool.",
].join(" ");

/** Overall wall budget for the whole live test. */
const OVERALL_TIMEOUT_MS = 240_000;

const VERDICT_RE = /VERDICT:\s*(PASS|FAIL)/i;
const RELAY_CUSTOM_TYPE = "relay:verify_phase";

// ── Utilities ──────────────────────────────────────────────────────────

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);

const logPath = join(mkdtempSync(join(tmpdir(), "relay-live-")), "events.jsonl");
const rawLines = [];
function recordRaw(line) {
  rawLines.push(line);
}

/** JSONL reader per pi's RPC framing rules: split on \n only, strip trailing \r. */
function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  });
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
  });
}

/** Pull every text fragment out of an AgentMessage-ish object. */
function messageText(message) {
  if (!message || typeof message !== "object") return "";
  const parts = [];
  if (typeof message.content === "string") parts.push(message.content);
  else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block && typeof block === "object" && typeof block.text === "string")
        parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function report(n, ok, message) {
  console.log(`${ok ? "OK  " : "FAIL"} ${n} — ${message}`);
  return ok;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const child = spawn(
    "pi",
    [
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions", // no auto-discovered extensions…
      "-e",
      RELAY_DIR, // …except the one under test
      "--model",
      DRIVER_MODEL,
      "--tools",
      "verify_phase", // force the driver model to the tool under test
      "-np", // no prompt templates
      "-ns", // no skills
      "-nc", // no AGENTS.md/CLAUDE.md context
    ],
    { stdio: ["pipe", "pipe", "pipe"], cwd: RELAY_DIR },
  );

  const send = (cmd) => child.stdin.write(`${JSON.stringify(cmd)}\n`);

  // Observed markers (all timestamps in ms from t0).
  const marks = {
    toolStart: undefined,
    toolPending: undefined, // verify_phase returned (tool_execution_end)
    pendingText: undefined,
    firstAgentEnd: undefined, // session became idle after the PENDING return
    pushbackMsg: undefined, // relay custom message with the verdict observed
    pushbackVerdict: undefined,
    followUpAgentStart: undefined, // fresh turn triggered by the pushback
    secondAgentEnd: undefined,
  };
  let agentStartCount = 0;
  let agentEndCount = 0;
  let toolCallCount = 0;
  let finished = false;
  let stderrBuf = "";

  const done = new Promise((resolve) => {
    const finish = (reason) => {
      if (finished) return;
      finished = true;
      resolve(reason);
    };

    const overall = setTimeout(() => finish("timeout"), OVERALL_TIMEOUT_MS);

    child.on("exit", () => {
      clearTimeout(overall);
      finish("exit");
    });

    child.stderr.on("data", (c) => {
      stderrBuf += c.toString();
    });

    attachJsonlReader(child.stdout, (line) => {
      if (!line.trim()) return;
      recordRaw(line);
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }

      switch (evt.type) {
        case "agent_start":
          agentStartCount += 1;
          if (agentStartCount >= 2 && marks.followUpAgentStart === undefined) {
            marks.followUpAgentStart = ms();
          }
          break;
        case "agent_end":
          agentEndCount += 1;
          if (agentEndCount === 1) marks.firstAgentEnd = ms();
          if (agentEndCount >= 2) marks.secondAgentEnd = ms();
          break;
        case "tool_execution_start":
          if (evt.toolName === "verify_phase") {
            toolCallCount += 1;
            if (marks.toolStart === undefined) marks.toolStart = ms();
          }
          break;
        case "tool_execution_end":
          if (evt.toolName === "verify_phase" && marks.toolPending === undefined) {
            marks.toolPending = ms();
            marks.pendingText = messageText(evt.result);
          }
          break;
        case "message_start":
        case "message_end": {
          const m = evt.message;
          const isRelayCustom = m && m.role === "custom" && m.customType === RELAY_CUSTOM_TYPE;
          const text = messageText(m);
          if ((isRelayCustom || VERDICT_RE.test(text)) && marks.pushbackMsg === undefined) {
            // Only count a pushback that arrives AFTER the tool returned PENDING.
            if (marks.toolPending !== undefined) {
              marks.pushbackMsg = ms();
              const vm = VERDICT_RE.exec(text) ?? /:\s*(PASS|FAIL)\b/i.exec(text);
              marks.pushbackVerdict = vm ? vm[1].toUpperCase() : "UNKNOWN";
            }
          }
          break;
        }
        default:
          break;
      }

      // Success condition: PENDING seen, agent went idle, pushback verdict seen,
      // and a follow-up turn (2nd agent_start) plus its completion.
      if (
        marks.toolPending !== undefined &&
        marks.firstAgentEnd !== undefined &&
        marks.pushbackMsg !== undefined &&
        marks.followUpAgentStart !== undefined &&
        marks.secondAgentEnd !== undefined
      ) {
        finish("observed");
      }
    });
  });

  // Kick off the turn once the process is up.
  setTimeout(() => send({ id: "turn-1", type: "prompt", message: USER_PROMPT }), 800);

  const reason = await done;

  // Authoritative cross-check: dump the conversation and locate the relay
  // pushback message carrying the verdict.
  let dumpedVerdict;
  let dumpedRelayContent;
  if (reason === "observed") {
    const got = await new Promise((resolve) => {
      const to = setTimeout(() => resolve(undefined), 8000);
      const onLine = (line) => {
        recordRaw(line);
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          return;
        }
        if (evt.type === "response" && evt.command === "get_messages" && evt.success) {
          clearTimeout(to);
          resolve(evt.data?.messages ?? []);
        }
      };
      attachJsonlReader(child.stdout, onLine);
      send({ id: "dump", type: "get_messages" });
    });
    if (Array.isArray(got)) {
      for (const m of got) {
        const text = messageText(m);
        if (
          m?.customType === RELAY_CUSTOM_TYPE ||
          (VERDICT_RE.test(text) && m?.role === "custom")
        ) {
          dumpedRelayContent = text;
          const vm = VERDICT_RE.exec(text) ?? /:\s*(PASS|FAIL)\b/i.exec(text);
          if (vm) dumpedVerdict = vm[1].toUpperCase();
          break;
        }
      }
    }
  }

  // Tear down the live session.
  try {
    send({ type: "abort" });
    send({ id: "bye", type: "shutdown" });
  } catch {
    /* stdin may be closed */
  }
  setTimeout(() => child.kill("SIGTERM"), 500);

  writeFileSync(logPath, `${rawLines.join("\n")}\n`);

  // ── Checks ────────────────────────────────────────────────────────────
  const pendingNonBlocking =
    marks.toolPending !== undefined &&
    marks.toolStart !== undefined &&
    marks.toolPending - marks.toolStart < 15_000;
  const pendingTextOk = (marks.pendingText ?? "").toUpperCase().includes("PENDING");
  const wentIdle =
    marks.firstAgentEnd !== undefined &&
    marks.toolPending !== undefined &&
    marks.firstAgentEnd >= marks.toolPending;
  const verdict = dumpedVerdict ?? marks.pushbackVerdict;
  const verdictOk = verdict === "PASS" || verdict === "FAIL";
  const followUpTurnOk =
    marks.followUpAgentStart !== undefined &&
    marks.firstAgentEnd !== undefined &&
    marks.followUpAgentStart > marks.firstAgentEnd;

  // Q1: was the pushback delivered immediately on arrival while the agent was
  // idle, or held until a later checkpoint? The agent has been idle since
  // firstAgentEnd; the follow-up turn fires at followUpAgentStart. A small gap
  // between the pushback message and the follow-up agent_start == immediate.
  const idleGap =
    marks.pushbackMsg !== undefined && marks.firstAgentEnd !== undefined
      ? marks.pushbackMsg - marks.firstAgentEnd
      : undefined;
  const triggerGap =
    marks.followUpAgentStart !== undefined && marks.pushbackMsg !== undefined
      ? marks.followUpAgentStart - marks.pushbackMsg
      : undefined;
  const immediate = followUpTurnOk && triggerGap !== undefined && Math.abs(triggerGap) < 2_000;

  console.log("");
  const c1 = report(
    1,
    toolCallCount >= 1,
    `verify_phase registered + invoked by the live model (calls=${toolCallCount})`,
  );
  const c2 = report(
    2,
    pendingNonBlocking && pendingTextOk,
    `execute() returned PENDING non-blocking (${marks.toolPending !== undefined && marks.toolStart !== undefined ? marks.toolPending - marks.toolStart : "?"} ms < 15000; result contains PENDING=${pendingTextOk})`,
  );
  const c3 = report(
    3,
    wentIdle,
    `session went idle after PENDING (first agent_end @ ${marks.firstAgentEnd ?? "?"} ms, D4 non-blocking)`,
  );
  const c4 = report(
    4,
    verdictOk && marks.pushbackMsg !== undefined && followUpTurnOk,
    `async follow-up turn delivered VERDICT: ${verdict ?? "<none>"} via sendMessage(triggerTurn) pushback ` +
      `(pushback @ ${marks.pushbackMsg ?? "?"} ms, follow-up agent_start @ ${marks.followUpAgentStart ?? "?"} ms)`,
  );
  const c5 = report(
    5,
    immediate,
    `Q1: triggerTurn fired ${immediate ? "IMMEDIATELY on delivery while idle" : "NOT immediately"} ` +
      `(agent idle for ${idleGap ?? "?"} ms before pushback; follow-up turn started ${triggerGap ?? "?"} ms after the pushback message)`,
  );

  console.log("");
  console.log(`reason=${reason}  event-log=${logPath}`);
  if (dumpedRelayContent) {
    console.log("relay pushback message (from get_messages):");
    console.log(dumpedRelayContent.split("\n").slice(0, 4).join("\n"));
  }
  if (!c1 && stderrBuf.trim()) {
    console.log("--- pi stderr (tail) ---");
    console.log(stderrBuf.split("\n").slice(-15).join("\n"));
  }

  process.exit(c1 && c2 && c3 && c4 && c5 ? 0 : 1);
}

await main();
