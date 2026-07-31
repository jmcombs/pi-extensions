/**
 * The `/initialize-steward` helper script. It is the part of the skill that must
 * not be improvised: the consent hashes Steward matches against, the file mode
 * the reader refuses without, the atomic write, and the measurements that decide
 * whether a collector really streams.
 *
 * It is exercised as a real subprocess, the way the skill invokes it, so the
 * argument parsing and exit codes are proven too — a helper the model calls and
 * whose non-zero exit it never sees is worse than no helper.
 *
 * The load-bearing invariant is the last test in this file: the hash the script
 * writes MUST equal `hashCommand` from the server's config reader. If the two
 * ever diverge, every gauge and every button goes silently dark.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashCommand } from "../../../server/steward-config.js";

const SCRIPT = join(import.meta.dirname, "steward-setup.mjs");
/** The controllable fake producer the host collector's own tests use. */
const PRODUCER = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "server",
  "__fixtures__",
  "host-collector",
  "producer.mjs",
);

const COMPLIANT_ARGV = [
  "/opt/homebrew/bin/llama-server",
  "--models-dir",
  "/models",
  "--metrics",
  "--host",
  "127.0.0.1",
  "--port",
  "8080",
];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "steward-skill-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], input?: string): Run {
  const result: SpawnSyncReturns<string> = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    input: input ?? "",
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Writes a JSON document into the temp dir and returns its path. */
function fixture(name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

/** A minimal, valid proposal whose collector is the fake producer. */
function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memoryTopology: "unified",
    hostCollector: { command: [process.execPath, PRODUCER, "emit"], intervalMs: 20 },
    ...overrides,
  };
}

describe("usage", () => {
  it("prints the subcommands and exits 0", () => {
    const result = run(["help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("probe-collector");
    expect(result.stdout).toContain("apply");
  });

  it("exits 2 with the usage text on an unknown subcommand", () => {
    const result = run(["frobnicate"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown subcommand: frobnicate");
  });
});

describe("check-argv", () => {
  it("passes a compliant router argv", () => {
    const result = run(["check-argv", "--argv-json", fixture("argv.json", COMPLIANT_ARGV)]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("router mode");
    expect(result.stdout).not.toContain("FAIL");
  });

  it("fails, and names each breach, on a non-compliant argv", () => {
    const argv = [
      "llama-server",
      "-m",
      "/models/a.gguf",
      "--no-slots",
      "--log-file",
      "/tmp/llama.log",
    ];
    const result = run(["check-argv", "--argv-json", fixture("argv.json", argv)]);
    expect(result.status).toBe(1);
    // Single-model mode, the missing metrics flag, disabled slots and the
    // log-file trap are four independent breaches; all four must be reported,
    // not just the first.
    expect(result.stdout).toContain("not router mode");
    expect(result.stdout).toContain("--metrics is missing");
    expect(result.stdout).toContain("--no-slots disables");
    expect(result.stdout).toContain("--log-file is present");
  });

  it("catches the log-file trap in its environment-variable spelling", () => {
    const argv = [
      "env",
      "LLAMA_ARG_LOG_FILE=/tmp/x.log",
      "llama-server",
      "--models-dir",
      "/m",
      "--metrics",
    ];
    const result = run(["check-argv", "--argv-json", fixture("argv.json", argv)]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("--log-file is present");
  });

  it("reads the argv of a live process", () => {
    const result = run(["check-argv", "--pid", String(process.pid)]);
    // This process is not a compliant llama-server, so the verdict is a failure;
    // what is proven here is that the pid path reads a real command line at all.
    expect(result.stdout).toContain(`pid ${process.pid}`);
    expect(result.stdout).toContain("node");
  });
});

describe("probe-collector", () => {
  it("reports a healthy stream", () => {
    const command = [process.execPath, PRODUCER, "emit"];
    const result = run([
      "probe-collector",
      "--command-json",
      fixture("cmd.json", command),
      "--seconds",
      "1",
      "--topology",
      "unified",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/valid reading\(s\) in 1s/u);
    expect(result.stdout).toContain("no VRAM fields on unified memory");
  });

  it("fails a producer that stays alive and emits nothing", () => {
    // The block-buffering trap: `macmon … | jq -c …` behaves exactly like this.
    const command = [process.execPath, PRODUCER, "silent", join(dir, "starts")];
    const result = run([
      "probe-collector",
      "--command-json",
      fixture("cmd.json", command),
      "--seconds",
      "1",
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("emitted NOTHING");
    expect(result.stdout).toContain("--unbuffered");
  });

  it("fails a producer whose lines carry no Steward schema", () => {
    const command = [
      process.execPath,
      "-e",
      "setInterval(() => process.stdout.write('{\"cpu\":1}\\n'), 20)",
    ];
    const result = run([
      "probe-collector",
      "--command-json",
      fixture("cmd.json", command),
      "--seconds",
      "1",
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("none of them a steward.hostmetrics/1 reading");
  });

  it("fails VRAM reported on unified memory", () => {
    const line =
      "JSON.stringify({schema:'steward.hostmetrics/1',ts:Date.now(),ramUsedGB:64,ramTotalGB:128,vramUsedGB:8,vramTotalGB:24})";
    const command = [
      process.execPath,
      "-e",
      `setInterval(() => process.stdout.write(${line} + '\\n'), 20)`,
    ];
    const result = run([
      "probe-collector",
      "--command-json",
      fixture("cmd.json", command),
      "--seconds",
      "1",
      "--topology",
      "unified",
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("VRAM is being reported on unified memory");
  });
});

describe("plan", () => {
  it("shows the diff and writes nothing", () => {
    const target = join(dir, "steward.json");
    const result = run([
      "plan",
      "--input",
      fixture("proposal.json", proposal()),
      "--config",
      target,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("(no config exists today)");
    expect(result.stdout).toContain('+   "memoryTopology": "unified",');
    expect(() => statSync(target)).toThrow();
  });

  it("reads the proposal from stdin", () => {
    const result = run(
      ["plan", "--input", "-", "--config", join(dir, "steward.json")],
      JSON.stringify(proposal()),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Diff");
  });

  it("refuses a proposal with a bad topology", () => {
    const result = run([
      "plan",
      "--input",
      fixture("proposal.json", proposal({ memoryTopology: "shared" })),
      "--config",
      join(dir, "steward.json"),
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('memoryTopology must be "unified" or "discrete"');
    expect(result.stdout).toContain("nothing would be written");
  });

  it("refuses a half-written control block rather than dropping an action", () => {
    const result = run([
      "plan",
      "--input",
      fixture("proposal.json", proposal({ control: { start: ["a"], stop: ["b"] } })),
      "--config",
      join(dir, "steward.json"),
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("control needs all three");
  });

  it("carries the launch-argv breaches through into the proposal review", () => {
    const result = run([
      "plan",
      "--input",
      fixture(
        "proposal.json",
        proposal({
          llama: { launchArgv: ["llama-server", "-m", "/a.gguf"], mechanism: "launchd" },
        }),
      ),
      "--config",
      join(dir, "steward.json"),
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("not router mode");
  });

  it("warns statically about the two collector shapes that emit nothing", () => {
    // Both are reviewed without running anything: jq block-buffers behind a pipe
    // and produces zero lines, and `-s 1` exits after one sample instead of
    // streaming. Neither blocks the write — the probe is the real verdict.
    const result = run([
      "plan",
      "--input",
      fixture(
        "proposal.json",
        proposal({
          hostCollector: {
            command: ["sh", "-c", "macmon pipe -s 1 | jq -c '.'"],
            intervalMs: 1000,
          },
        }),
      ),
      "--config",
      join(dir, "steward.json"),
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("without --unbuffered");
    expect(result.stdout).toContain("macmon without `-s 0`");
  });

  it("warns about a log under /tmp without blocking it", () => {
    const result = run([
      "plan",
      "--input",
      fixture("proposal.json", proposal({ log: { path: "/tmp/llama-router.log" } })),
      "--config",
      join(dir, "steward.json"),
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("the log lives under /tmp");
  });

  it("warns that launchd's bootout breaks a later start", () => {
    const control = {
      start: ["launchctl", "kickstart", "gui/501/x"],
      stop: ["launchctl", "bootout", "gui/501/x"],
      restart: ["launchctl", "kickstart", "-k", "gui/501/x"],
    };
    const result = run([
      "plan",
      "--input",
      fixture("proposal.json", proposal({ control })),
      "--config",
      join(dir, "steward.json"),
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("bootout");
    expect(result.stdout).toContain("kill SIGTERM");
  });
});

describe("apply", () => {
  it("writes the artifact at mode 600 and prints how to revert", () => {
    const target = join(dir, "nested", "steward.json");
    const result = run([
      "apply",
      "--input",
      fixture("proposal.json", proposal({ log: { path: "/var/log/llama.log" } })),
      "--config",
      target,
    ]);
    expect(result.status).toBe(0);
    expect((statSync(target).mode & 0o777).toString(8)).toBe("600");
    expect(result.stdout).toContain(`rm ${target}`);

    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written.memoryTopology).toBe("unified");
    expect(written.log).toEqual({ path: "/var/log/llama.log" });
  });

  it("backs the previous config up and names the restore command", () => {
    const target = join(dir, "steward.json");
    writeFileSync(target, JSON.stringify({ memoryTopology: "discrete" }));
    const result = run([
      "apply",
      "--input",
      fixture("proposal.json", proposal()),
      "--config",
      target,
    ]);
    expect(result.status).toBe(0);
    const backup = /cp (\S+) /u.exec(result.stdout)?.[1];
    expect(backup).toBeDefined();
    expect(JSON.parse(readFileSync(backup as string, "utf8"))).toEqual({
      memoryTopology: "discrete",
    });
  });

  it("writes nothing when the proposal is invalid", () => {
    const target = join(dir, "steward.json");
    const result = run([
      "apply",
      "--input",
      fixture("proposal.json", { memoryTopology: "unified" }),
      "--config",
      target,
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("nothing was written");
    expect(() => statSync(target)).toThrow();
  });
});

describe("verify", () => {
  /** Applies a proposal and returns the config path it landed at. */
  function applied(overrides: Record<string, unknown> = {}): string {
    const target = join(dir, "steward.json");
    const result = run([
      "apply",
      "--input",
      fixture("proposal.json", proposal(overrides)),
      "--config",
      target,
    ]);
    expect(result.status).toBe(0);
    return target;
  }

  it("passes a freshly applied config", () => {
    const target = applied();
    const result = run(["verify", "--config", target, "--seconds", "1"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("the collector command is consented");
    expect(result.stdout).toContain("All checks passed");
  });

  it("reports a missing config rather than throwing", () => {
    const result = run(["verify", "--config", join(dir, "absent.json")]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("no config at");
  });

  it("fails when a command was edited after consent was recorded", () => {
    const target = applied();
    const config = JSON.parse(readFileSync(target, "utf8"));
    config.hostCollector.command = [process.execPath, PRODUCER, "noise"];
    writeFileSync(target, JSON.stringify(config, null, 2), { mode: 0o600 });

    const result = run(["verify", "--config", target, "--skip-collector"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("no matching consent hash");
  });

  it("fails a world-writable config, as the reader does", () => {
    const target = applied();
    // 0o666 is what a careless `chmod` leaves behind; Steward refuses it because
    // anyone on the box could then choose what it executes.
    spawnSync("chmod", ["666", target]);
    const result = run(["verify", "--config", target, "--skip-collector"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("world-writable");
  });

  it("proves stderr capture from a real combined log", () => {
    const log = join(dir, "router.log");
    writeFileSync(
      log,
      [
        "0.08.955.549 I srv          load:   --alias",
        "[54241] 0.00.051.128 I srv    load_model: loading model 'x.gguf'",
        "0.17.590.624 I srv  proxy_reques: proxying request to model X on port 54241",
      ].join("\n"),
    );
    const target = applied({ log: { path: log } });
    const result = run(["verify", "--config", target, "--skip-collector"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stderr IS captured");
    expect(result.stdout).toContain("stdout IS captured");
  });

  it("fails a log that only ever caught stdout", () => {
    const log = join(dir, "router.log");
    // Forwarded child lines only: exactly what a StandardOutPath-only redirect
    // produces, and it loses every router error.
    writeFileSync(log, "[54241] 0.00.051.128 I srv load_model: loading\n[54241] hello\n");
    const target = applied({ log: { path: log } });
    const result = run(["verify", "--config", target, "--skip-collector"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("stderr does NOT look captured");
  });

  it("fails a plist that splits the two streams", () => {
    const log = join(dir, "router.log");
    writeFileSync(log, "0.08.955.549 I srv load: x\n");
    const plist = join(dir, "com.llama.router.plist");
    writeFileSync(
      plist,
      `<plist version="1.0"><dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}.err</string>
</dict></plist>`,
    );
    const target = applied({ log: { path: log } });
    const result = run(["verify", "--config", target, "--skip-collector", "--plist", plist]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("name different files");
  });

  it("accepts a plist that redirects both streams to the recorded log", () => {
    const log = join(dir, "router.log");
    writeFileSync(log, "0.08.955.549 I srv load: x\n");
    const plist = join(dir, "com.llama.router.plist");
    writeFileSync(
      plist,
      `<plist version="1.0"><dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>`,
    );
    const target = applied({ log: { path: log } });
    const result = run(["verify", "--config", target, "--skip-collector", "--plist", plist]);
    expect(result.stdout).toContain(`both streams redirect to ${log}`);
  });

  it("reports drift between the record and the live process", () => {
    const target = applied({
      llama: { launchArgv: COMPLIANT_ARGV, mechanism: "launchd", label: "com.llama.router" },
    });
    const result = run([
      "verify",
      "--config",
      target,
      "--skip-collector",
      "--pid",
      String(process.pid),
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("does not match the recorded launch argv");
  });
});

describe("consent hashing", () => {
  it("writes exactly the hashes the server's reader matches against", () => {
    const target = join(dir, "steward.json");
    const control = {
      start: ["launchctl", "kickstart", "gui/501/com.llama.router"],
      stop: ["launchctl", "kill", "SIGTERM", "gui/501/com.llama.router"],
      restart: ["launchctl", "kickstart", "-k", "gui/501/com.llama.router"],
    };
    const result = run([
      "apply",
      "--input",
      fixture("proposal.json", proposal({ control })),
      "--config",
      target,
    ]);
    expect(result.status).toBe(0);

    const written = JSON.parse(readFileSync(target, "utf8"));
    // The invariant the whole artifact rests on. `hashCommand` here is the
    // server's own implementation, imported directly: if the script's join or
    // digest ever drifts from it, Steward silently refuses to spawn the
    // collector and offers none of the buttons.
    expect(written.consent[hashCommand(written.hostCollector.command)]).toBe(true);
    for (const action of ["start", "stop", "restart"] as const) {
      expect(written.consent[hashCommand(control[action])]).toBe(true);
    }
    expect(Object.keys(written.consent)).toHaveLength(4);
  });
});
