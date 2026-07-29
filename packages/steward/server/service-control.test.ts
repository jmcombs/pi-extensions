/**
 * The control executor's contract is: run the declared command once, bounded,
 * and ALWAYS settle — whatever the command does. These tests run REAL processes
 * (a `node -e` stand-in for `launchctl`, never a real service), because the
 * failure modes that matter are the ones the OS produces: a binary that is not
 * installed, a command that ignores the signal sent to it, one that floods its
 * output, and one that exits non-zero with its reason on stderr. Each must come
 * back as a readable detail an operator can act on, not as a rejected promise
 * and not as a promise that never resolves — an unsettled run here would hang
 * the API request, the browser's fetch, and the control row behind them.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServiceController } from "./service-control.js";

/** A command that runs `body` in a fresh Node, standing in for a service tool. */
function node(body: string, ...args: string[]): string[] {
  return [process.execPath, "-e", body, ...args];
}

const SUCCEEDS = node("process.exit(0)");
const REFUSES = node(
  "process.stderr.write('Load failed: 5: Input/output error\\n');process.exit(1)",
);
const QUIET_FAILURE = node("process.exit(3)");
const HANGS = node("setTimeout(() => {}, 30000)");
const MISSING = ["steward-no-such-binary-6f3a1c", "restart"];

/**
 * A child that records its pid, traps SIGTERM, and keeps running — the wrapper
 * script with `trap '' TERM` an operator really can declare. Only a SIGKILL
 * stops it, so it proves the escalation rather than the polite path.
 */
function stubborn(pidFile: string): string[] {
  return node(
    "require('node:fs').writeFileSync(process.argv[1], String(process.pid));" +
      "process.on('SIGTERM', () => {});setInterval(() => {}, 1000)",
    pidFile,
  );
}

/** True while the process exists (signal 0 probes without delivering). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits for `check` to hold, so a reap that is merely async is not a failure. */
async function until(check: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "steward-control-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createServiceController", () => {
  it("offers exactly the actions it was given a command for", () => {
    const controller = createServiceController({ restart: SUCCEEDS });
    expect(controller.actions).toEqual(["restart"]);

    const all = createServiceController({ stop: SUCCEEDS, start: SUCCEEDS, restart: SUCCEEDS });
    // Always start/stop/restart order, whatever order they were declared in.
    expect(all.actions).toEqual(["start", "stop", "restart"]);

    // An empty argv is not a command; it is never offered.
    expect(createServiceController({ start: [] }).actions).toEqual([]);
  });

  it("reports a clean exit as success", async () => {
    const controller = createServiceController({ start: SUCCEEDS });
    await expect(controller.run("start")).resolves.toEqual({ ok: true, detail: null });
  });

  it("reports a non-zero exit as a failure carrying the command's own words", async () => {
    const controller = createServiceController({ stop: REFUSES });
    const result = await controller.run("stop");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Load failed: 5: Input/output error");
  });

  it("falls back to the exit status when the command failed silently", async () => {
    const controller = createServiceController({ stop: QUIET_FAILURE });
    const result = await controller.run("stop");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("exited with status 3");
  });

  it("kills a command that hangs and says so, rather than blocking forever", async () => {
    const controller = createServiceController({ restart: HANGS }, { timeoutMs: 150 });
    const started = Date.now();
    const result = await controller.run("restart");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("timed out after 150ms");
    // It really did come back on the timeout, not on the command's own exit.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("escalates to SIGKILL on a command that ignores SIGTERM, and still settles", async () => {
    // The case a single SIGTERM cannot end: the child traps it and runs on. The
    // run must answer anyway, or the API request behind it never returns.
    const pidFile = join(dir, "stubborn.pid");
    const controller = createServiceController({ restart: stubborn(pidFile) }, { timeoutMs: 200 });

    const started = Date.now();
    const result = await controller.run("restart");
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("timed out after 200ms");
    // Settled on our own deadline plus the kill grace, not on the child's exit
    // (it had 30s of work left and was ignoring the polite signal).
    expect(elapsed).toBeLessThan(5000);

    // And it was actually killed: a child left running would be an orphan the
    // operator never asked for, holding whatever the command was doing.
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it("reaps a wrapper script's own children, not just the wrapper", async () => {
    // The shape an operator actually writes: a shell wrapper that traps the
    // polite signal and waits on a real tool. Killing only the direct child
    // would leave that tool running while the dashboard reports it killed.
    const pidFile = join(dir, "grandchild.pid");
    const controller = createServiceController(
      {
        restart: ["/bin/sh", "-c", `trap '' TERM; sleep 25 & echo $! > ${pidFile}; wait`],
      },
      { timeoutMs: 200 },
    );

    const result = await controller.run("restart");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("timed out");

    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it("names the output flood as the reason, never the flood itself", async () => {
    // A chatty command is killed by the buffer cap mid-run. Its truncated
    // output is not why it failed, and reporting it would fabricate a reason
    // out of ordinary chatter.
    const controller = createServiceController({
      // Written in sustained bursts, not one blast-and-exit: a child that exits
      // immediately drops its own buffered pipe writes and never reaches the cap.
      start: node(
        "const b='A'.repeat(64 * 1024);let i = 0;" +
          "const t = setInterval(() => {process.stdout.write(b);if (++i > 40) clearInterval(t)}, 5);" +
          "setTimeout(() => process.exit(0), 4000)",
      ),
    });
    const result = await controller.run("start");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("produced more than 256 KB of output");
    expect(result.detail).not.toContain("AAAA");
  });

  it("bounds the whole detail and strips control characters from it", async () => {
    // A terminal-shaped tool colours its errors; those escapes are invisible on
    // screen but a screen reader reads them out of the alert region.
    const controller = createServiceController({
      stop: node(
        "process.stderr.write('\\u001b[31m' + 'refused '.repeat(60) + '\\u001b[0m\\n');process.exit(1)",
      ),
    });
    const result = await controller.run("stop");
    const text = result.detail ?? "";
    // Scanned by code point rather than matched by regex: the assertion is about
    // characters a screen reader would voice, and the escapes are the subject.
    expect([...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)).toBe(false);
    expect(text).toContain("refused");
    expect(result.detail?.length).toBeLessThanOrEqual(160);
  });

  it("reports a missing binary as not found instead of throwing", async () => {
    const controller = createServiceController({ restart: MISSING });
    const result = await controller.run("restart");
    expect(result).toEqual({
      ok: false,
      detail: "steward-no-such-binary-6f3a1c: command not found",
    });
  });

  it("refuses an action it has no consented command for", async () => {
    const controller = createServiceController({ restart: SUCCEEDS });
    const result = await controller.run("stop");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no consented stop command");
    expect(result.detail).toContain("/initialize-steward");
  });

  it("passes the argv as arguments, never through a shell", async () => {
    // A shell would expand `$(…)` and the `;`; execFile hands them to the
    // program verbatim, so the marker prints exactly as written.
    const marker = "$(echo pwned); rm -rf /";
    const controller = createServiceController({
      start: [
        process.execPath,
        "-e",
        "process.stderr.write(process.argv[1]);process.exit(1)",
        marker,
      ],
    });
    const result = await controller.run("start");
    expect(result.detail).toContain(marker);
  });
});
