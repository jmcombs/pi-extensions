/**
 * The drift probe's Node half: reading a process's live command line, caching it
 * for as long as that process lives, and — above all — degrading honestly.
 *
 * Everything here runs against an injected `ps`, never this machine's real
 * `llama-server`: the probe's contract is about what it does when the world does
 * NOT cooperate (no pid, no `ps`, a permission error, a truncated line), and none
 * of those are reproducible against a healthy local server.
 *
 * The sharpest case is a read that fails ONCE. `unknown` renders nothing, so a
 * check that quietly stopped running is indistinguishable on screen from a
 * machine that is fine — which is the exact failure this phase exists to delete.
 * A failed read must therefore be retried, never remembered as an answer.
 */

import { describe, expect, it, vi } from "vitest";
import { createDriftProbe } from "./drift-probe.js";

const ARGV = [
  "/opt/homebrew/bin/llama-server",
  "--host",
  "127.0.0.1",
  "--port",
  "8080",
  "--metrics",
];
const LINE = ARGV.join(" ");

const PID = 4821;

describe("createDriftProbe", () => {
  it("reports clean when the process still carries the recorded argv", async () => {
    const probe = createDriftProbe({ launchArgv: ARGV, readArgv: async () => LINE });

    expect(await probe(PID)).toEqual({
      status: "clean",
      added: [],
      removed: [],
      program: null,
      reason: null,
    });
  });

  it("names the flag the running process no longer has", async () => {
    const probe = createDriftProbe({
      launchArgv: ARGV,
      readArgv: async () => LINE.replace(" --metrics", ""),
    });

    const drift = await probe(PID);
    expect(drift.status).toBe("drifted");
    expect(drift.removed).toEqual(["--metrics"]);
  });

  it("reports unknown — not clean — when no pid was resolved", async () => {
    const readArgv = vi.fn(async () => LINE);
    const probe = createDriftProbe({ launchArgv: ARGV, readArgv });

    const drift = await probe(null);
    expect(drift.status).toBe("unknown");
    expect(drift.reason).toBe("the listening process could not be identified");
    // With no pid there is nothing to read, so `ps` is never run.
    expect(readArgv).not.toHaveBeenCalled();
  });

  it("reports unknown when `ps` cannot read the command line", async () => {
    // A missing `ps`, a process that exited before it was read, or a permission
    // error all arrive here as "no line". None of them is evidence about the
    // flags, so none of them may produce a verdict.
    const probe = createDriftProbe({ launchArgv: ARGV, readArgv: async () => null });

    const drift = await probe(PID);
    expect(drift.status).toBe("unknown");
    expect(drift.reason).toBe("the launch command line could not be read");
  });

  it("reports unknown when the argv read itself throws", async () => {
    const probe = createDriftProbe({
      launchArgv: ARGV,
      readArgv: async () => {
        throw new Error("ps exploded");
      },
    });

    await expect(probe(PID)).resolves.toMatchObject({
      status: "unknown",
      reason: "the launch command line could not be read",
    });
  });

  it("retries after a read that failed, instead of going quiet for the process's life", async () => {
    // One timed-out `ps` (the 1.5 s deadline, under load) must not pin `unknown`
    // — and with it an empty, all-clear-looking dashboard — for as long as the
    // server runs.
    const readArgv = vi
      .fn<(pid: number) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(LINE);
    const probe = createDriftProbe({ launchArgv: ARGV, readArgv });

    expect((await probe(PID)).status).toBe("unknown");
    expect((await probe(PID)).status).toBe("clean");
    expect(readArgv).toHaveBeenCalledTimes(2);
  });

  it("still reports drift that only the retry could see", async () => {
    const readArgv = vi
      .fn<(pid: number) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(LINE.replace(" --metrics", ""));
    const probe = createDriftProbe({ launchArgv: ARGV, readArgv });

    expect((await probe(PID)).status).toBe("unknown");
    const drift = await probe(PID);
    expect(drift.status).toBe("drifted");
    expect(drift.removed).toEqual(["--metrics"]);
  });

  it("backs off a read that keeps failing, but never stops retrying", async () => {
    // A process we genuinely cannot inspect must not cost a subprocess every
    // 1.6 s — and must still be re-attempted, because whatever is blocking the
    // read may clear.
    const readArgv = vi.fn(async () => null);
    const probe = createDriftProbe({ launchArgv: ARGV, readArgv });

    for (let poll = 0; poll < 30; poll += 1) {
      expect((await probe(PID)).status).toBe("unknown");
    }
    expect(readArgv.mock.calls.length).toBeGreaterThan(1);
    expect(readArgv.mock.calls.length).toBeLessThan(15);
  });

  it("reports a truncated line as unknown rather than as removed flags", async () => {
    const probe = createDriftProbe({
      launchArgv: ARGV,
      readArgv: async () => LINE.slice(0, LINE.length - 3),
    });

    const drift = await probe(PID);
    expect(drift.status).toBe("unknown");
    expect(drift.reason).toBe("the process list truncated the command line");
  });

  it("runs `ps` once per pid, however often it is polled", async () => {
    // The check runs on every snapshot (~1.6 s). A process's command line
    // cannot change while it lives, so re-reading it would be pure cost.
    const readArgv = vi.fn(async () => LINE);
    const probe = createDriftProbe({ launchArgv: ARGV, readArgv });

    for (let poll = 0; poll < 5; poll += 1) expect((await probe(PID)).status).toBe("clean");
    expect(readArgv).toHaveBeenCalledTimes(1);
  });

  it("re-reads when the pid changes, so a restart is not judged on stale argv", async () => {
    const readArgv = vi.fn(async (pid: number) =>
      pid === PID ? LINE : LINE.replace(" --metrics", ""),
    );
    const probe = createDriftProbe({ launchArgv: ARGV, readArgv });

    expect((await probe(PID)).status).toBe("clean");
    // The service was restarted from an edited plist: same port, new process,
    // fewer flags. Serving the cached line here would report the machine
    // compliant while it is not.
    const drift = await probe(5309);
    expect(drift.status).toBe("drifted");
    expect(drift.removed).toEqual(["--metrics"]);
    expect(readArgv).toHaveBeenCalledTimes(2);
  });

  it("drops the cache when the service goes away", async () => {
    const readArgv = vi.fn(async () => LINE);
    const probe = createDriftProbe({ launchArgv: ARGV, readArgv });

    expect((await probe(PID)).status).toBe("clean");
    expect((await probe(null)).status).toBe("unknown");
    // The same pid coming back is a NEW process (pids are reused), so the line
    // is read again rather than served from a cache that outlived its process.
    expect((await probe(PID)).status).toBe("clean");
    expect(readArgv).toHaveBeenCalledTimes(2);
  });

  it("reads a real command line through the shipped `ps` invocation", async () => {
    // The one case that exercises the default `ps` path, and the reason it can
    // be deterministic: this test process IS a process, so the probe is pointed
    // at its own pid. If `ps -ww -o args=` did not work the verdict would be
    // `unknown`, so a `drifted` answer proves a real command line came back.
    const probe = createDriftProbe({ launchArgv: ["/definitely/not/the/test/runner"] });

    const drift = await probe(process.pid);
    expect(drift.status).toBe("drifted");
    expect(drift.reason).toBeNull();
    expect(drift.program?.observed).toContain(process.execPath);
  });
});
