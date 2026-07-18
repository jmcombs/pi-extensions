/**
 * Credential API round-trip tests — no mocks.
 *
 * These exercise the real stateless read/write path against a **temporary**
 * auth.json (pointed at via `PI_CODING_AGENT_DIR`, which `getAgentDir()` honors).
 * Command resolution is proven with `!echo` / `!exit 1` sentinels so no real
 * 1Password session is required (capability `op-sentinel`). The live `op read`
 * path (`op-live`) is maintainer-only and intentionally not covered here.
 *
 * Nothing here mocks the filesystem, `op`, or any project helper — the test
 * drives the exported functions exactly as a consumer extension would.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteSecret, onboardSecret, resolveSecret, verifySecret } from "./credential-api.js";
import { findFirstOpRef, warmOpSessionIfNeeded, writeProviderAuthEntry } from "./index.js";

let dir: string;
let prevAgentDir: string | undefined;

function authPath(): string {
  return join(dir, "auth.json");
}

async function writeAuth(obj: Record<string, unknown>): Promise<void> {
  await writeFile(authPath(), `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

async function readAuth(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(authPath(), "utf8")) as Record<string, unknown>;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "1p-credapi-"));
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(async () => {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  await rm(dir, { recursive: true, force: true });
});

describe("resolveSecret (D5)", () => {
  it("resolves a provider-shaped `!echo` sentinel to the command output", async () => {
    await writeAuth({ demo: { type: "api_key", key: "!echo resolved-secret" } });
    expect(await resolveSecret("demo")).toBe("resolved-secret");
  });

  it("resolves a bare legacy literal string entry (D5 both shapes)", async () => {
    await writeAuth({ demo: "literal-value" });
    expect(await resolveSecret("demo")).toBe("literal-value");
  });

  it("resolves a bare legacy `!echo` string entry", async () => {
    await writeAuth({ demo: "!echo legacy-resolved" });
    expect(await resolveSecret("demo")).toBe("legacy-resolved");
  });

  it("fails closed to undefined on a failing command — never the raw value", async () => {
    await writeAuth({ demo: { type: "api_key", key: "!exit 1" } });
    const out = await resolveSecret("demo");
    expect(out).toBeUndefined();
    expect(out).not.toBe("!exit 1");
  });

  it("returns undefined for a missing name", async () => {
    await writeAuth({ other: { type: "api_key", key: "!echo x" } });
    expect(await resolveSecret("demo")).toBeUndefined();
  });
});

describe("writeProviderAuthEntry (D4) + round-trip", () => {
  it("writes the D4 provider shape and reads it back", async () => {
    const res = await writeProviderAuthEntry("demo", "!echo written-secret");
    expect(res.success).toBe(true);

    const stored = (await readAuth()).demo;
    expect(stored).toEqual({ type: "api_key", key: "!echo written-secret" });

    expect(await resolveSecret("demo")).toBe("written-secret");
  });

  it("refuses to clobber an existing key without overwrite", async () => {
    await writeProviderAuthEntry("demo", "!echo first");
    const res = await writeProviderAuthEntry("demo", "!echo second");
    expect(res.success).toBe(false);
    expect(res.alreadyExists).toBe(true);
    expect(await resolveSecret("demo")).toBe("first");
  });

  it("serializes concurrent writes under the lock (both keys land)", async () => {
    await Promise.all([
      writeProviderAuthEntry("alpha", "!echo a"),
      writeProviderAuthEntry("beta", "!echo b"),
    ]);
    const stored = await readAuth();
    expect(stored.alpha).toEqual({ type: "api_key", key: "!echo a" });
    expect(stored.beta).toEqual({ type: "api_key", key: "!echo b" });
  });
});

describe("verifySecret", () => {
  it("reports resolved=true for a value, without returning the value", async () => {
    await writeAuth({ demo: { type: "api_key", key: "!echo present" } });
    const v = await verifySecret("demo");
    expect(v).toEqual({ ok: true, resolved: true });
  });

  it("reports resolved=false with an error when nothing resolves", async () => {
    await writeAuth({ demo: { type: "api_key", key: "!exit 1" } });
    const v = await verifySecret("demo");
    expect(v.ok).toBe(false);
    expect(v.resolved).toBe(false);
    expect(v.error).toBeTruthy();
  });
});

describe("deleteSecret", () => {
  it("removes an entry so it no longer resolves", async () => {
    await writeProviderAuthEntry("demo", "!echo gone");
    expect(await resolveSecret("demo")).toBe("gone");

    const del = await deleteSecret("demo");
    expect(del.ok).toBe(true);
    expect(Object.hasOwn(await readAuth(), "demo")).toBe(false);
    expect(await resolveSecret("demo")).toBeUndefined();
  });

  it("reports ok=false when there is nothing to remove", async () => {
    await writeAuth({});
    expect((await deleteSecret("demo")).ok).toBe(false);
  });
});

describe("changeSecret overwrite semantics", () => {
  it("replaces an existing entry (overwrite forced on)", async () => {
    // changeSecret drives interactive UI; here we prove the underlying overwrite
    // path via the locked writer that changeSecret delegates to.
    await writeProviderAuthEntry("demo", "!echo old");
    const res = await writeProviderAuthEntry("demo", "!echo new", { overwrite: true });
    expect(res.success).toBe(true);
    expect(await resolveSecret("demo")).toBe("new");
  });
});

describe("onboarding ctx typing (ADR 0004 regression)", () => {
  it("onboardSecret is callable from every ctx that exposes `ui` — no cast", () => {
    // Compile-level regression for the bug that hid behind the original
    // ExtensionCommandContext over-narrowing: onboardSecret takes
    // UiContext = Pick<ExtensionContext, "ui">, so it accepts a tool `execute()`
    // ctx (typed ExtensionContext), a command handler ctx
    // (ExtensionCommandContext), and a bare `{ ui }` test double alike. These
    // arrows are type-checked by the `tsc` gate; their bodies are never invoked,
    // so no real UI is driven here. If any callsite regressed to requiring the
    // wider/narrower context, this file would fail to typecheck.
    const callsites = {
      fromToolExecute: (ctx: ExtensionContext) => onboardSecret(ctx, { name: "d", label: "D" }),
      fromCommandHandler: (ctx: ExtensionCommandContext) =>
        onboardSecret(ctx, { name: "d", label: "D" }),
      fromUiDouble: (ctx: { ui: ExtensionContext["ui"] }) =>
        onboardSecret(ctx, { name: "d", label: "D" }),
    };
    expect(Object.keys(callsites)).toHaveLength(3);
  });
});

describe("onboardSecret manual-entry branch (runtime, op unavailable)", () => {
  it("writes the D4 provider-shaped literal via a bare `{ ui }` double", async () => {
    // Force is1PasswordAvailable() → false deterministically by pointing PATH at
    // a directory with no `op` binary, so `op --version` fails and getOpStatus
    // reports available=false. This drives the manual-entry branch on any
    // machine, including one where 1Password IS configured. This is the exact
    // path (ctx.ui-only, no command context) that the original typing made
    // untestable and that hid ADR 0004's bug.
    const prevPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      // Bare `{ ui }` double: `custom` is what inputInBorderedPopup awaits; it
      // returns the "entered" key directly (bypassing the render callback).
      const ui = {
        custom: async () => "manual-test-key",
        notify: () => {},
        setStatus: () => {},
      } as unknown as ExtensionContext["ui"];

      const res = await onboardSecret({ ui }, { name: "demo", label: "Demo" });

      expect(res.ok).toBe(true);
      expect((await readAuth()).demo).toEqual({ type: "api_key", key: "manual-test-key" });
      expect(await resolveSecret("demo")).toBe("manual-test-key");
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });
});

describe("warm-on-load scan (D7)", () => {
  it("findFirstOpRef selects a nested provider-shaped `.key` reference", () => {
    const ref = findFirstOpRef({
      LITERAL: "not-an-op-ref",
      nested: { type: "api_key", key: "!op read 'op://Vault/Item/field'" },
    });
    expect(ref).toBe("!op read 'op://Vault/Item/field'");
  });

  it("findFirstOpRef also picks a top-level string reference", () => {
    const ref = findFirstOpRef({ GH_TOKEN: "!op read 'op://Private/gh/token'" });
    expect(ref).toBe("!op read 'op://Private/gh/token'");
  });

  it("findFirstOpRef returns null when no `!op read` reference exists", () => {
    expect(findFirstOpRef({ a: "literal", b: { type: "api_key", key: "!echo x" } })).toBeNull();
  });

  it("warmOpSessionIfNeeded is a silent, fail-closed no-op when no `!op read` ref exists", async () => {
    // No vault references → warm must not invoke `op` at all (so no real 1Password
    // session / biometric prompt is triggered in the test) and must never throw.
    // The nested-`.key` selection itself is proven above via findFirstOpRef; the
    // live `op read` invocation is the maintainer-only op-live gate.
    await writeAuth({ demo: { type: "api_key", key: "!echo x" }, LITERAL: "plain" });
    await expect(warmOpSessionIfNeeded()).resolves.toBeUndefined();
  });
});
