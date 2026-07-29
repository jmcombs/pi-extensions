/**
 * The launch-argv comparison — the half of the drift check that decides what
 * counts as a mismatch.
 *
 * Both failure directions are proven here, because they cost the same trust: a
 * machine that is configured correctly must never be nagged (order, `=`
 * spelling, and a line `ps` cut short are all NOT drift), and a machine that
 * really lost a flag must never be told it is fine (the most likely real edit —
 * deleting the LAST flag — is the one a naive truncation guard would swallow).
 */

import { describe, expect, it } from "vitest";
import { diffLaunchArgv } from "./drift.js";

/** A realistic router launch line, as `/initialize-steward` would record it. */
const ARGV = [
  "/opt/homebrew/bin/llama-server",
  "--host",
  "127.0.0.1",
  "--port",
  "8080",
  "--jinja",
  "--metrics",
  "--models",
  "/Users/op/models",
];

const LINE = ARGV.join(" ");

describe("diffLaunchArgv", () => {
  it("reports a clean match when the live argv is the recorded one", () => {
    const drift = diffLaunchArgv(ARGV, LINE);
    expect(drift).toEqual({
      status: "clean",
      added: [],
      removed: [],
      program: null,
      reason: null,
    });
  });

  it("tolerates the whitespace `ps` puts between arguments", () => {
    // A leading/trailing pad or a double space is a formatting artefact of the
    // process list, not a change to how the server was launched.
    expect(diffLaunchArgv(ARGV, `  ${LINE}  `).status).toBe("clean");
    expect(diffLaunchArgv(ARGV, LINE.replace("--jinja", " --jinja ")).status).toBe("clean");
  });

  it("does not call a reordered launch line drift", () => {
    // The same flags in a different order run the same server. Nagging over it
    // would spend exactly the trust the notice needs to keep.
    const reordered = ["/opt/homebrew/bin/llama-server", "--metrics", "--jinja"];
    const drift = diffLaunchArgv(reordered, "/opt/homebrew/bin/llama-server --jinja --metrics");
    expect(drift.status).toBe("clean");
  });

  it("treats `--flag=value` and `--flag value` as the same flag", () => {
    const drift = diffLaunchArgv(ARGV, LINE.replace("--port 8080", "--port=8080"));
    expect(drift.status).toBe("clean");
  });

  it("names the flag that was removed", () => {
    // The case the whole phase exists for: a plist edited to drop `--metrics`
    // leaves throughput dark AND, without this, an implicit all-clear.
    const drift = diffLaunchArgv(ARGV, LINE.replace(" --metrics", ""));
    expect(drift.status).toBe("drifted");
    expect(drift.removed).toEqual(["--metrics"]);
    expect(drift.added).toEqual([]);
    expect(drift.program).toBeNull();
  });

  it("names a flag removed from the END of the line", () => {
    // This line is a strict prefix of the recorded one — exactly what a
    // truncated read looks like — but it ends on a token boundary, so it is a
    // real edit and must be reported. A guard that swallowed it would miss the
    // most common hand-edit there is.
    const drift = diffLaunchArgv(ARGV, LINE.replace(" --models /Users/op/models", ""));
    expect(drift.status).toBe("drifted");
    expect(drift.removed).toEqual(["--models /Users/op/models"]);
  });

  it("names a flag that was added", () => {
    const drift = diffLaunchArgv(ARGV, `${LINE} --no-slots`);
    expect(drift.status).toBe("drifted");
    expect(drift.added).toEqual(["--no-slots"]);
    expect(drift.removed).toEqual([]);
  });

  it("reports a changed value as the whole flag group, not a loose token", () => {
    // `8081` alone would be meaningless on screen; `--port 8080` → `--port 8081`
    // is something an operator can act on.
    const drift = diffLaunchArgv(ARGV, LINE.replace("--port 8080", "--port 8081"));
    expect(drift.status).toBe("drifted");
    expect(drift.removed).toEqual(["--port 8080"]);
    expect(drift.added).toEqual(["--port 8081"]);
  });

  it("counts duplicates, so losing one of a repeated flag is drift", () => {
    const repeated = ["llama-server", "--override-kv", "a=int:1", "--override-kv", "b=int:2"];
    const drift = diffLaunchArgv(repeated, "llama-server --override-kv a=int:1");
    expect(drift.status).toBe("drifted");
    expect(drift.removed).toEqual(["--override-kv b=int:2"]);
  });

  it("reports a changed binary separately from the flags", () => {
    const drift = diffLaunchArgv(ARGV, LINE.replace("/opt/homebrew/bin/", "/usr/local/bin/"));
    expect(drift.status).toBe("drifted");
    expect(drift.program).toEqual({
      recorded: "/opt/homebrew/bin/llama-server",
      observed: "/usr/local/bin/llama-server",
    });
    expect(drift.added).toEqual([]);
    expect(drift.removed).toEqual([]);
  });

  it("reports a line cut mid-argument as unknown, never as removed flags", () => {
    // `ps` truncating at a display width is not an operator edit. Reporting it
    // as drift would nag a correctly configured machine on every poll.
    const drift = diffLaunchArgv(ARGV, LINE.slice(0, LINE.length - 4));
    expect(drift.status).toBe("unknown");
    expect(drift.reason).toBe("the process list truncated the command line");
    expect(drift.removed).toEqual([]);
  });

  it("reports an empty command line as unknown, not as everything removed", () => {
    for (const line of ["", "   ", "\n"]) {
      const drift = diffLaunchArgv(ARGV, line);
      expect(drift.status).toBe("unknown");
      expect(drift.reason).toBe("the process list reported no command line");
    }
  });

  it("reports a `ps` placeholder as unknown, not as a wholly different server", () => {
    // A zombie process, or Linux `/proc` mounted with `hidepid`, prints
    // `(llama-server)` / `[llama-server]` instead of an argv. Diffing against
    // that would claim every recorded flag was removed AND that the binary
    // changed — the loudest possible false alarm on a machine that did nothing.
    for (const line of ["(llama-server)", "[llama-server]"]) {
      const drift = diffLaunchArgv(ARGV, line);
      expect(drift.status).toBe("unknown");
      expect(drift.removed).toEqual([]);
      expect(drift.program).toBeNull();
    }
  });

  it("reports nothing recorded as unknown, not as clean", () => {
    // No baseline means no verdict. "Clean" here would be the silent false
    // all-clear this check exists to remove.
    const drift = diffLaunchArgv([], LINE);
    expect(drift.status).toBe("unknown");
    expect(drift.reason).toBe("no launch command was recorded for this machine");
  });
});
