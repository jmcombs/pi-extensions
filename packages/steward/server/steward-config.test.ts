/**
 * The config gate. `steward.json` drives Steward to run a local command, so this
 * reader is a security boundary: it must reject a config that another user could
 * have planted (wrong owner, world-writable) and must never throw — an absent or
 * untrusted artifact degrades to `null`, it does not crash the dashboard. The
 * per-command consent check is proven alongside it.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consentDrift,
  consentedControls,
  controlConsented,
  hashCommand,
  hostCollectorConsented,
  readStewardConfig,
  type StewardConfig,
  stewardConfigPath,
} from "./steward-config.js";

const COMMAND = ["macmon", "pipe", "-s", "0", "-i", "1000"];

/** The launchd control commands a macOS operator would hand-write. */
const LABEL = "gui/501/com.llamacpp.router";
const START = ["launchctl", "kickstart", LABEL];
const STOP = ["launchctl", "kill", "SIGTERM", LABEL];
const RESTART = ["launchctl", "kickstart", "-k", LABEL];
const CONTROL = { start: START, stop: STOP, restart: RESTART };

/** The launch argv `/initialize-steward` records for the drift check. */
const LAUNCH_ARGV = [
  "/opt/homebrew/bin/llama-server",
  "--host",
  "127.0.0.1",
  "--port",
  "8080",
  "--metrics",
];

/** A well-formed config object with consent already granted for {@link COMMAND}. */
function validConfig(): Record<string, unknown> {
  return {
    memoryTopology: "unified",
    hostCollector: { command: COMMAND, intervalMs: 1000 },
    consent: { [hashCommand(COMMAND)]: true },
  };
}

/** The same, plus a control block and consent for all three of its commands. */
function controlledConfig(): Record<string, unknown> {
  return {
    ...validConfig(),
    control: CONTROL,
    consent: {
      [hashCommand(COMMAND)]: true,
      [hashCommand(START)]: true,
      [hashCommand(STOP)]: true,
      [hashCommand(RESTART)]: true,
    },
  };
}

let dir = "";
let path = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "steward-config-"));
  path = join(dir, "steward.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes `body` to the config file at a normal (non-world-writable) mode. */
function write(body: unknown): void {
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });
}

describe("readStewardConfig", () => {
  it("reads and validates a well-formed config", () => {
    write(validConfig());
    const config = readStewardConfig({ path });
    expect(config).toEqual<StewardConfig>({
      memoryTopology: "unified",
      hostCollector: { command: COMMAND, intervalMs: 1000 },
      // The launch record is optional too: without it the drift check is simply
      // unavailable, which is not a reason to refuse the config.
      llama: null,
      // Control is optional: a machine with metrics and no control is valid.
      control: null,
      consent: { [hashCommand(COMMAND)]: true },
    });
  });

  it("returns null and stays quiet when the file is absent", () => {
    const warnings: string[] = [];
    expect(readStewardConfig({ path, warn: (m) => warnings.push(m) })).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("refuses a world-writable config", () => {
    write(validConfig());
    chmodSync(path, 0o666);
    const warnings: string[] = [];
    expect(readStewardConfig({ path, warn: (m) => warnings.push(m) })).toBeNull();
    expect(warnings.join(" ")).toContain("world-writable");
  });

  it("refuses a config owned by another user", () => {
    write(validConfig());
    const warnings: string[] = [];
    // The file is owned by us; a mismatched "current uid" stands in for a config
    // planted by someone else, without the test needing to chown as root.
    const foreignUid = (typeof process.getuid === "function" ? process.getuid() : 0) + 1;
    expect(readStewardConfig({ path, uid: foreignUid, warn: (m) => warnings.push(m) })).toBeNull();
    expect(warnings.join(" ")).toContain("not owned");
  });

  it("returns null with a warning on invalid JSON", () => {
    write("{ not json");
    const warnings: string[] = [];
    expect(readStewardConfig({ path, warn: (m) => warnings.push(m) })).toBeNull();
    expect(warnings.join(" ")).toContain("not valid JSON");
  });

  it("rejects a bad memoryTopology", () => {
    write({ ...validConfig(), memoryTopology: "shared" });
    expect(readStewardConfig({ path })).toBeNull();
  });

  it("rejects a missing or ill-formed hostCollector", () => {
    write({ memoryTopology: "discrete", consent: {} });
    expect(readStewardConfig({ path })).toBeNull();

    write({ memoryTopology: "discrete", hostCollector: { command: [], intervalMs: 1000 } });
    expect(readStewardConfig({ path })).toBeNull();

    write({ memoryTopology: "discrete", hostCollector: { command: COMMAND, intervalMs: 0 } });
    expect(readStewardConfig({ path })).toBeNull();
  });

  it("reads the recorded launch argv, mechanism and label", () => {
    write({
      ...validConfig(),
      llama: { launchArgv: LAUNCH_ARGV, mechanism: "launchd", label: LABEL },
    });
    expect(readStewardConfig({ path })?.llama).toEqual({
      launchArgv: LAUNCH_ARGV,
      mechanism: "launchd",
      label: LABEL,
    });
  });

  it("keeps the launch argv when only the descriptive fields are missing", () => {
    // `mechanism` and `label` only point the operator at the right file to fix;
    // the argv is the part the drift check needs.
    write({ ...validConfig(), llama: { launchArgv: LAUNCH_ARGV } });
    expect(readStewardConfig({ path })?.llama).toEqual({
      launchArgv: LAUNCH_ARGV,
      mechanism: null,
      label: null,
    });
  });

  it("leaves llama null when the artifact records no launch argv", () => {
    // Drift checking is then unavailable — which is a state the dashboard shows
    // by saying nothing, not a reason to refuse a config nothing else needs it for.
    write(validConfig());
    expect(readStewardConfig({ path })?.llama).toBeNull();
  });

  it("warns and ignores an ill-formed llama block rather than refusing the config", () => {
    for (const llama of [
      { launchArgv: [] },
      { launchArgv: "llama-server --metrics" },
      { launchArgv: ["llama-server", 8080] },
      { mechanism: "launchd" },
      "launchd",
    ]) {
      write({ ...validConfig(), llama });
      const warnings: string[] = [];
      const config = readStewardConfig({ path, warn: (m) => warnings.push(m) });
      // The rest of the config still works: only the drift check is lost.
      expect(config?.hostCollector.command).toEqual(COMMAND);
      expect(config?.llama).toBeNull();
      expect(warnings.join(" ")).toContain("launchArgv");
    }
  });

  it("ignores unknown keys and keeps only true consent entries", () => {
    write({
      ...validConfig(),
      serviceControl: { restart: ["launchctl", "kickstart"] },
      consent: { [hashCommand(COMMAND)]: true, stale: false },
    });
    const config = readStewardConfig({ path });
    expect(config?.consent).toEqual({ [hashCommand(COMMAND)]: true });
  });
});

describe("the control block", () => {
  it("reads all three commands when they are all declared", () => {
    write(controlledConfig());
    expect(readStewardConfig({ path })?.control).toEqual({
      start: START,
      stop: STOP,
      restart: RESTART,
    });
  });

  it("keeps the config but drops control when it is absent", () => {
    write(validConfig());
    const config = readStewardConfig({ path });
    // Metrics configured, control not: a real machine state, not a bad config.
    expect(config?.hostCollector.command).toEqual(COMMAND);
    expect(config?.control).toBeNull();
  });

  it("drops a partial or ill-formed control block, with a warning, and keeps the rest", () => {
    const partial = { ...controlledConfig(), control: { start: START, stop: STOP } };
    const warnings: string[] = [];
    write(partial);
    const config = readStewardConfig({ path, warn: (m) => warnings.push(m) });
    expect(config).not.toBeNull();
    expect(config?.control).toBeNull();
    expect(warnings.join(" ")).toContain("control");

    // A command that is not an argv of strings, an empty argv, and a non-object
    // block are all the same answer: control unconfigured.
    for (const control of [
      { start: START, stop: STOP, restart: "launchctl kickstart -k" },
      { start: START, stop: STOP, restart: [] },
      { start: START, stop: STOP, restart: [1, 2] },
      "launchctl",
      [],
    ]) {
      write({ ...controlledConfig(), control });
      expect(readStewardConfig({ path })?.control).toBeNull();
    }
  });
});

describe("controlConsented", () => {
  it("is true for each command whose exact hash the operator approved", () => {
    write(controlledConfig());
    const config = readStewardConfig({ path });
    expect(config).not.toBeNull();
    if (config === null) return;
    expect(controlConsented(config, "start")).toBe(true);
    expect(controlConsented(config, "stop")).toBe(true);
    expect(controlConsented(config, "restart")).toBe(true);
  });

  it("is per action: consenting to restart does not consent to stop", () => {
    write({
      ...validConfig(),
      control: CONTROL,
      consent: { [hashCommand(COMMAND)]: true, [hashCommand(RESTART)]: true },
    });
    const config = readStewardConfig({ path });
    expect(config).not.toBeNull();
    if (config === null) return;
    expect(controlConsented(config, "restart")).toBe(true);
    expect(controlConsented(config, "start")).toBe(false);
    expect(controlConsented(config, "stop")).toBe(false);
    // Only the approved command is handed to the executor.
    expect(consentedControls(config)).toEqual({ restart: RESTART });
  });

  it("is false once a declared command is rewritten under an old consent", () => {
    write({
      ...controlledConfig(),
      // The restart command now carries an extra argument; its hash moved.
      control: { ...CONTROL, restart: [...RESTART, "--force"] },
    });
    const config = readStewardConfig({ path });
    expect(config).not.toBeNull();
    if (config === null) return;
    expect(controlConsented(config, "restart")).toBe(false);
    expect(controlConsented(config, "start")).toBe(true);
    expect(Object.keys(consentedControls(config)).sort()).toEqual(["start", "stop"]);
  });

  it("is false for every action when control is unconfigured", () => {
    write(validConfig());
    const config = readStewardConfig({ path });
    expect(config).not.toBeNull();
    if (config === null) return;
    expect(controlConsented(config, "start")).toBe(false);
    expect(consentedControls(config)).toEqual({});
  });

  it("hands the executor a copy, so the config cannot be mutated through it", () => {
    write(controlledConfig());
    const config = readStewardConfig({ path });
    expect(config).not.toBeNull();
    if (config === null) return;
    const commands = consentedControls(config);
    commands.start?.push("--rm-rf");
    expect(config.control?.start).toEqual(START);
  });
});

describe("hostCollectorConsented", () => {
  it("is true only when the exact command's hash is present", () => {
    write(validConfig());
    const config = readStewardConfig({ path });
    expect(config).not.toBeNull();
    expect(config && hostCollectorConsented(config)).toBe(true);
  });

  it("is false when the command was rewritten under an old consent", () => {
    // Consent was granted for COMMAND; the collector command is a different one.
    write({
      memoryTopology: "unified",
      hostCollector: { command: ["macmon", "pipe", "-i", "500"], intervalMs: 500 },
      consent: { [hashCommand(COMMAND)]: true },
    });
    const config = readStewardConfig({ path });
    expect(config && hostCollectorConsented(config)).toBe(false);
  });
});

describe("consentDrift", () => {
  it("reports nothing when every declared command is approved", () => {
    write(controlledConfig());
    const config = readStewardConfig({ path });
    expect(config && consentDrift(config)).toEqual({ hostCollector: false, controls: [] });
  });

  it("reports a collector that is declared but not approved", () => {
    // Exactly what an operator hits after hand-editing the collector command:
    // the hash no longer matches, Steward refuses to run it, and the host band
    // goes dark. Without this the empty band is indistinguishable from a
    // machine that never configured one.
    write({ ...validConfig(), consent: {} });
    const config = readStewardConfig({ path });
    expect(config && consentDrift(config)).toEqual({ hostCollector: true, controls: [] });
  });

  it("reports the declared control actions that are not approved, in render order", () => {
    write({
      ...controlledConfig(),
      consent: { [hashCommand(COMMAND)]: true, [hashCommand(STOP)]: true },
    });
    const config = readStewardConfig({ path });
    expect(config && consentDrift(config)).toEqual({
      hostCollector: false,
      controls: ["start", "restart"],
    });
  });

  it("reports no control gap when the artifact declares no control at all", () => {
    // Nothing declared is not a mismatch — it is a machine that was never set
    // up for control, which the SERVICE block already says with its setup CTA.
    write(validConfig());
    const config = readStewardConfig({ path });
    expect(config && consentDrift(config)).toEqual({ hostCollector: false, controls: [] });
  });
});

describe("stewardConfigPath", () => {
  const original = process.env.STEWARD_CONFIG;
  afterEach(() => {
    if (original === undefined) delete process.env.STEWARD_CONFIG;
    else process.env.STEWARD_CONFIG = original;
  });

  it("honours STEWARD_CONFIG when set", () => {
    process.env.STEWARD_CONFIG = "/tmp/custom/steward.json";
    expect(stewardConfigPath()).toBe("/tmp/custom/steward.json");
  });

  it("falls back to ~/.config/steward/steward.json", () => {
    delete process.env.STEWARD_CONFIG;
    expect(stewardConfigPath()).toMatch(/\.config[/\\]steward[/\\]steward\.json$/);
  });
});
