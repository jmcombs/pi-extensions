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
  hashCommand,
  hostCollectorConsented,
  readStewardConfig,
  type StewardConfig,
  stewardConfigPath,
} from "./steward-config.js";

const COMMAND = ["macmon", "pipe", "-s", "0", "-i", "1000"];

/** A well-formed config object with consent already granted for {@link COMMAND}. */
function validConfig(): Record<string, unknown> {
  return {
    memoryTopology: "unified",
    hostCollector: { command: COMMAND, intervalMs: 1000 },
    consent: { [hashCommand(COMMAND)]: true },
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
