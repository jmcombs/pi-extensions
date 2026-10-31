/**
 * Real filesystem tests for the shared auth.json / settings.json writers.
 * Nothing here mocks `node:fs`. Every path is under a throwaway directory.
 */

import { existsSync, statSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { agentAuthPath, agentSettingsPath, updateAuthJson, updateSettingsJson } from "./index.js";

const roots: string[] = [];

async function throwaway(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-files-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function modeOf(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

describe("agent paths", () => {
  it("uses getAgentDir() when agentDir is omitted and the argument when it is passed", () => {
    const dir = join(tmpdir(), "pi-agent-files-agent-dir");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      expect(agentAuthPath()).toBe(join(dir, "auth.json"));
      expect(agentSettingsPath()).toBe(join(dir, "settings.json"));
      expect(agentAuthPath(join(dir, "other"))).toBe(join(dir, "other", "auth.json"));
      expect(agentSettingsPath(join(dir, "other"))).toBe(join(dir, "other", "settings.json"));
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

describe("symlink updates", () => {
  it("keeps home/auth.json and home/settings.json as symlinks and writes keep plus the new key to the targets", async () => {
    const root = await throwaway();
    const home = join(root, "home");
    const targets = join(root, "targets");
    await mkdir(home);
    await mkdir(targets);
    const authTarget = join(targets, "auth.json");
    const settingsTarget = join(targets, "settings.json");
    await writeFile(authTarget, '{"keep":true}');
    await writeFile(settingsTarget, '{"keep":true}');
    const homeAuth = join(home, "auth.json");
    const homeSettings = join(home, "settings.json");
    await symlink(authTarget, homeAuth);
    await symlink(settingsTarget, homeSettings);

    await updateAuthJson(
      (current) => {
        expect(statSync(`${homeAuth}.lock`).isDirectory()).toBe(true);
        expect(existsSync(`${authTarget}.lock`)).toBe(false);
        return { ...(current ?? {}), added: "auth" };
      },
      { agentDir: home },
    );
    await updateSettingsJson((current) => ({ ...(current ?? {}), added: "settings" }), {
      agentDir: home,
    });

    expect((await lstat(homeAuth)).isSymbolicLink()).toBe(true);
    expect((await lstat(homeSettings)).isSymbolicLink()).toBe(true);
    expect(await readlink(homeAuth)).toBe(authTarget);
    expect(await readlink(homeSettings)).toBe(settingsTarget);
    expect(JSON.parse(await readFile(authTarget, "utf8"))).toEqual({
      keep: true,
      added: "auth",
    });
    expect(JSON.parse(await readFile(settingsTarget, "utf8"))).toEqual({
      keep: true,
      added: "settings",
    });
    expect(await readFile(authTarget, "utf8")).toBe(
      JSON.stringify({ keep: true, added: "auth" }, null, 2),
    );
  });
});

describe("invalid JSON", () => {
  it("throws and leaves auth.json and settings.json bytes unchanged", async () => {
    const root = await throwaway();
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    const authPath = join(agentDir, "auth.json");
    const settingsPath = join(agentDir, "settings.json");
    const authRaw = "{not json";
    const settingsRaw = "";
    await writeFile(authPath, authRaw);
    await writeFile(settingsPath, settingsRaw);

    await expect(updateAuthJson(() => ({ added: true }), { agentDir })).rejects.toThrow(
      /not valid JSON/,
    );
    await expect(updateSettingsJson(() => ({ added: true }), { agentDir })).rejects.toThrow(
      /not valid JSON/,
    );
    expect(await readFile(authPath, "utf8")).toBe(authRaw);
    expect(await readFile(settingsPath, "utf8")).toBe(settingsRaw);
  });

  it("treats an empty auth.json as {} and still rejects an empty settings.json", async () => {
    const root = await throwaway();
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { mode: 0o755 });
    const authPath = join(agentDir, "auth.json");
    await writeFile(authPath, "\uFEFF");
    await updateAuthJson((current) => ({ ...(current ?? {}), keep: true }), { agentDir });
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({ keep: true });
    expect(modeOf(authPath)).not.toBe(0o600);

    const settingsPath = join(agentDir, "settings.json");
    await writeFile(settingsPath, "\uFEFF   ");
    const before = await readFile(settingsPath, "utf8");
    await expect(updateSettingsJson(() => ({ keep: true }), { agentDir })).rejects.toThrow(
      /not valid JSON/,
    );
    expect(await readFile(settingsPath, "utf8")).toBe(before);
  });
});

describe("create and mode", () => {
  it("turns a missing auth path into a regular 0o600 file under a new 0o700 parent", async () => {
    const root = await throwaway();
    const agentDir = join(root, "agent");
    const authPath = join(agentDir, "auth.json");

    await updateAuthJson(() => undefined, { agentDir });
    await expect(stat(agentDir)).rejects.toThrow();

    await updateAuthJson((current) => ({ ...(current ?? {}), keep: true }), { agentDir });
    const fileStat = await lstat(authPath);
    expect(fileStat.isSymbolicLink()).toBe(false);
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect((await stat(agentDir)).mode & 0o777).toBe(0o700);
    expect(await readFile(authPath, "utf8")).toBe(JSON.stringify({ keep: true }, null, 2));
  });

  it("does not chmod a settings target to 0o600 and does not force the parent mode", async () => {
    const root = await throwaway();
    const control = join(root, "control");
    await mkdir(control);
    const agentDir = join(root, "new-settings");
    await updateSettingsJson(() => ({ keep: true }), { agentDir });
    expect(modeOf(join(agentDir, "settings.json"))).not.toBe(0o600);
    expect(modeOf(agentDir)).toBe(modeOf(control));

    const existing = join(root, "existing");
    await mkdir(existing);
    const settingsPath = join(existing, "settings.json");
    await writeFile(settingsPath, '{"keep":true}', { mode: 0o644 });
    await updateSettingsJson((current) => ({ ...(current ?? {}), added: true }), {
      agentDir: existing,
    });
    expect(modeOf(settingsPath)).toBe(0o644);
    expect(modeOf(settingsPath)).not.toBe(0o600);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      keep: true,
      added: true,
    });
  });

  it("keeps a top-level !op read string and a non-credential object without executing it", async () => {
    const root = await throwaway();
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    const authPath = join(agentDir, "auth.json");
    await writeFile(
      authPath,
      `${JSON.stringify({
        GH_TOKEN: "!op read 'op://Vault/Item/credential'",
        custom: { foo: 1 },
      })}\n`,
    );
    await updateAuthJson((current) => ({ ...(current ?? {}), extra: true }), { agentDir });
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
      GH_TOKEN: "!op read 'op://Vault/Item/credential'",
      custom: { foo: 1 },
      extra: true,
    });
  });
});

describe("proper-lockfile", () => {
  it("a second holder on the same path with realpath false does not tear the JSON", async () => {
    const root = await throwaway();
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    const authPath = join(agentDir, "auth.json");
    const original = '{"keep":true}';
    await writeFile(authPath, original);

    const release = await lock(authPath, { realpath: false, stale: 30_000, retries: 0 });
    expect(statSync(`${authPath}.lock`).isDirectory()).toBe(true);
    let settled = false;
    const pending = updateAuthJson((current) => ({ ...(current ?? {}), added: true }), {
      agentDir,
    }).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    expect(await readFile(authPath, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({ keep: true });

    await release();
    await pending;
    expect(settled).toBe(true);
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({ keep: true, added: true });
    expect(await readFile(authPath, "utf8")).toBe(
      JSON.stringify({ keep: true, added: true }, null, 2),
    );
  });
});
