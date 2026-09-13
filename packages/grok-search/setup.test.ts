/**
 * `/grok_setup` orchestration tests — scripted `ui.custom`, no terminal.
 *
 * When OAuth is present the first popup is the setup card. Choosing API key
 * continues into the real `onboardSecret` flow (op-unavailable branch via an
 * op-less PATH). Nothing here mocks project helpers or xAI.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCredentialPreference } from "./auth.js";
import { runGrokSetup } from "./setup.js";

let dir: string;
let prevAgentDir: string | undefined;
let prevPath: string | undefined;

async function writeAuth(obj: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, "auth.json"), `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

async function readAuth(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, "auth.json"), "utf8")) as Record<string, unknown>;
}

function scriptedUi(script: readonly unknown[]): {
  ui: ExtensionContext["ui"];
  notifications: { message: string; level: string }[];
} {
  const queue = [...script];
  const notifications: { message: string; level: string }[] = [];
  const ui = {
    custom: async (): Promise<unknown> => (queue.length > 0 ? queue.shift() : null),
    notify: (message: string, level: string): void => {
      notifications.push({ message, level });
    },
    setStatus: (): void => {},
  } as unknown as ExtensionContext["ui"];
  return { ui, notifications };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grok-search-setup-"));
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  prevPath = process.env.PATH;
  process.env.PI_CODING_AGENT_DIR = dir;
  // Force onboardSecret's op-unavailable (masked literal) branch.
  process.env.PATH = dir;
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  if (prevPath === undefined) delete process.env.PATH;
  else process.env.PATH = prevPath;
  await rm(dir, { recursive: true, force: true });
});

const oauthEntry = {
  type: "oauth",
  access: "oauth-access",
  refresh: "oauth-refresh",
  expires: Date.now() + 60 * 60 * 1000,
};

describe("runGrokSetup with OAuth present", () => {
  it("Use xAI OAuth persists the preference and does not write a grok API key", async () => {
    await writeAuth({ xai: oauthEntry });
    const { ui } = scriptedUi(["oauth"]);
    const res = await runGrokSetup({ ui });
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/xAI OAuth/);
    expect(await readCredentialPreference()).toBe("oauth");
    expect(await readAuth()).toEqual({ xai: oauthEntry });
  });

  it("Use an API key instead runs 1Password onboarding and persists api_key", async () => {
    await writeAuth({ xai: oauthEntry });
    const { ui } = scriptedUi(["api_key", "xai-manual-key"]);
    const res = await runGrokSetup({ ui });
    expect(res.ok).toBe(true);
    expect(await readCredentialPreference()).toBe("api_key");
    expect((await readAuth()).grok).toEqual({ type: "api_key", key: "xai-manual-key" });
    expect((await readAuth()).xai).toEqual(oauthEntry);
  });

  it("Cancel leaves preference and auth.json untouched", async () => {
    await writeAuth({ xai: oauthEntry });
    const { ui } = scriptedUi(["cancel"]);
    const res = await runGrokSetup({ ui });
    expect(res).toEqual({ ok: false, message: "Setup cancelled." });
    expect(await readCredentialPreference()).toBeUndefined();
    expect(await readAuth()).toEqual({ xai: oauthEntry });
  });
});

describe("runGrokSetup without OAuth", () => {
  it("goes straight to API-key onboarding and persists api_key", async () => {
    await writeAuth({});
    const { ui } = scriptedUi(["xai-plain-key"]);
    const res = await runGrokSetup({ ui });
    expect(res.ok).toBe(true);
    expect(await readCredentialPreference()).toBe("api_key");
    expect((await readAuth()).grok).toEqual({ type: "api_key", key: "xai-plain-key" });
  });
});

describe("setup card copy", () => {
  it("renders the OAuth-discovered message above the choices", async () => {
    await writeAuth({ xai: oauthEntry });
    let rendered = "";
    const ui = {
      custom: async (
        factory: (
          tui: unknown,
          theme: unknown,
          kb: unknown,
          done: (value: unknown) => void,
        ) => Promise<{ render(width: number): string[] }>,
      ): Promise<unknown> => {
        const popup = await factory(
          new Proxy({}, { get: () => () => {} }),
          { fg: (_c: string, s: string) => s, bold: (s: string) => s },
          {},
          () => {},
        );
        rendered = popup.render(72).join("\n");
        return "cancel";
      },
      notify: (): void => {},
      setStatus: (): void => {},
    } as unknown as ExtensionContext["ui"];

    await runGrokSetup({ ui });
    expect(rendered).toContain("Grok Search setup");
    expect(rendered).toContain("xAI OAuth (SuperGrok / X Premium) was discovered");
    expect(rendered).toContain("Use xAI OAuth");
    expect(rendered).toContain("Use an API key instead");
  });
});
