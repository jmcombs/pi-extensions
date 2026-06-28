// Headless verification driver for the headroom extension via Pi's RPC mode.
//
// Pi's `--mode rpc` speaks JSONL over stdio: commands in on stdin, events out on
// stdout. A `{ type: "prompt", message: "/some-command" }` is routed through
// `session.prompt()`, which executes registered extension commands *immediately
// and without any LLM call*. Crucially, `ctx.ui.notify(...)` surfaces as an
// `extension_ui_request` event with `method: "notify"` on stdout — so command
// output and `session_start` notices are fully observable headlessly, with no
// API key or interactive TUI.
//
// This is what turns the "manual `pi -e`" Testing Gates into automatable
// HEADLESS-RPC gates for the build/verify loop.
//
// Usage:
//   node docs/headroom/rpc-verify.mjs <extPath> [slashCommand]
//
//   node docs/headroom/rpc-verify.mjs ./packages/headroom "/headroom-status"
//   node docs/headroom/rpc-verify.mjs ./packages/headroom        # capture startup notices only
//
// Output: JSON { notifies: [{notifyType, message}], eventTypes, stderrTail }.
// Filter `notifies` for messages beginning with "Headroom" — other globally
// installed extensions (e.g. qwen-guard) also emit session_start notices.

import { spawn } from "node:child_process";

const extPath = process.argv[2];
const slash = process.argv[3];

if (!extPath) {
  console.error("Usage: node rpc-verify.mjs <extPath> [slashCommand]");
  process.exit(2);
}

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

const child = spawn("pi", ["--mode", "rpc", "--no-session", "--offline", "-e", extPath], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: REPO_ROOT,
});

const notifies = [];
const eventTypes = new Set();
let buf = "";
let stderr = "";

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl = buf.indexOf("\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf("\n");
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      eventTypes.add(event.type);
      if (event.type === "extension_ui_request" && event.method === "notify") {
        notifies.push({ notifyType: event.notifyType, message: event.message });
      }
    } catch {
      // Non-JSON line — ignore.
    }
  }
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

// Let the session start (fires session_start), then optionally invoke the command.
setTimeout(() => {
  if (slash) send({ id: "1", type: "prompt", message: slash });
}, 2500);

// Collect, then tear down and report.
setTimeout(() => {
  child.kill("SIGTERM");
  console.log(
    JSON.stringify(
      { notifies, eventTypes: [...eventTypes], stderrTail: stderr.slice(-400) },
      null,
      2,
    ),
  );
  process.exit(0);
}, 6500);
