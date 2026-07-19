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

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteSecret, onboardSecret, resolveSecret, verifySecret } from "./credential-api.js";
import { findFirstOpRef, warmOpSessionIfNeeded, writeProviderAuthEntry } from "./index.js";
import { inputInBorderedPopup, selectInBorderedPopup } from "./ui/bordered-popups.js";

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

describe("onboarding ctx typing regression", () => {
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
    // untestable and that hid the bug.
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

// ── UX-redesign test scaffolding ───────────────────────────────────────────
//
// Two kinds of `{ ui }` doubles, neither mocking our code:
//  - `scriptedUi` returns pre-scripted values from `ui.custom` (one per popup, in
//    order) so we can drive `onboardSecret`'s orchestration + real writes without
//    a terminal. Notifications are captured for assertions.
//  - the masked / select render tests actually invoke the popup factory with the
//    REAL pi-tui `Editor` / `SelectList` and a headless fake TUI, then inspect the
//    rendered lines — proving what is (and is not) drawn on screen.
//
// `is1PasswordAvailable()` is steered with a real ephemeral `op` stub on PATH
// (available branch) or an op-less PATH (unavailable branch) — a real sandbox in
// the spirit of the `op-sentinel` capability, never a mock of project code.

type CustomFactory = (
  tui: unknown,
  theme: unknown,
  kb: unknown,
  done: (value: unknown) => void,
) => Promise<{ render(width: number): string[]; handleInput?(data: string): void }>;

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

/** A headless fake TUI: any accessed property is a no-op function. */
function fakeTui(): unknown {
  return new Proxy({}, { get: () => () => {} });
}

/** Identity theme sufficient for renderBorderedBox + the pi-tui components. */
function fakeTheme(): unknown {
  return { fg: (_color: string, s: string) => s, bold: (s: string) => s };
}

/** Write a real, executable `op` stub into a bin dir and return that dir. */
async function writeFakeOp(): Promise<string> {
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const opPath = join(binDir, "op");
  await writeFile(
    opPath,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "2.0.0-fake" ;;',
      '  account) echo \'[{"url":"u","email":"e","user_uuid":"x","account_uuid":"y"}]\' ;;',
      '  read) echo "fake-resolved" ;;',
      "  whoami) exit 1 ;;",
      '  *) echo "[]" ;;',
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(opPath, 0o755);
  return binDir;
}

async function withPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PATH;
  process.env.PATH = path;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  }
}

describe("onboardSecret existing-key gate", () => {
  it("Keep the current key leaves the entry untouched", async () => {
    await writeProviderAuthEntry("demo", "!echo original");
    const { ui } = scriptedUi(["keep"]); // gate select → Keep
    const res = await onboardSecret({ ui }, { name: "demo", label: "Demo" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Kept your existing Demo key/);
    expect(res.message).not.toMatch(/auth\.json|changeSecret/);
    expect((await readAuth()).demo).toEqual({ type: "api_key", key: "!echo original" });
  });

  it("Replace it overwrites with the newly entered value", async () => {
    await writeProviderAuthEntry("demo", "!echo original");
    // op unavailable → after Replace, flow goes straight to masked literal entry.
    await withPath(dir, async () => {
      const { ui } = scriptedUi(["replace", "new-secret-value"]);
      const res = await onboardSecret({ ui }, { name: "demo", label: "Demo" });
      expect(res.ok).toBe(true);
      expect((await readAuth()).demo).toEqual({ type: "api_key", key: "new-secret-value" });
      expect(await resolveSecret("demo")).toBe("new-secret-value");
    });
  });
});

describe("onboardSecret source branches", () => {
  it("op unavailable → masked literal entry writes a literal provider entry", async () => {
    await withPath(dir, async () => {
      const { ui } = scriptedUi(["tvly-plain-key"]); // no source menu; straight to input
      const res = await onboardSecret({ ui }, { name: "tavily", label: "Tavily" });
      expect(res.ok).toBe(true);
      expect(res.message).toMatch(/Tavily is set up, stored locally/);
      expect(res.message).toMatch(/Install 1Password CLI to use your vault/);
      expect((await readAuth()).tavily).toEqual({ type: "api_key", key: "tvly-plain-key" });
    });
  });

  it("op available → Type or paste the key writes a literal entry + verify wiring", async () => {
    const binDir = await writeFakeOp();
    await withPath(`${binDir}:${process.env.PATH ?? ""}`, async () => {
      const { ui } = scriptedUi(["paste", "sk-live-abc123"]);
      const res = await onboardSecret({ ui }, { name: "svc", label: "Service" });
      expect(res.ok).toBe(true);
      // verify wiring: the literal resolves, so we get the "stored locally" success.
      expect(res.message).toMatch(/Service is set up\. Your key is stored locally/);
      expect((await readAuth()).svc).toEqual({ type: "api_key", key: "sk-live-abc123" });
    });
  });

  it("op available → Enter a 1Password reference writes an !op read entry", async () => {
    const binDir = await writeFakeOp();
    await withPath(`${binDir}:${process.env.PATH ?? ""}`, async () => {
      const { ui } = scriptedUi(["ref", "op://Vault/Item/field"]);
      const res = await onboardSecret({ ui }, { name: "svc", label: "Service" });
      expect(res.ok).toBe(true);
      expect((await readAuth()).svc).toEqual({
        type: "api_key",
        key: "!op read 'op://Vault/Item/field'",
      });
    });
  });

  it("op available → an incomplete op:// reference is rejected and writes nothing", async () => {
    const binDir = await writeFakeOp();
    await withPath(`${binDir}:${process.env.PATH ?? ""}`, async () => {
      const { ui, notifications } = scriptedUi(["ref", "op://Vault/Item"]); // 2 segments
      const res = await onboardSecret({ ui }, { name: "svc", label: "Service" });
      expect(res).toEqual({ ok: false, message: "Onboarding cancelled." });
      expect(
        notifications.some((n) => /doesn't look complete/.test(n.message) && n.level === "warning"),
      ).toBe(true);
      expect(await resolveSecret("svc")).toBeUndefined();
    });
  });
});

describe("masked secret input — never echoes the value", () => {
  it("renders bullets, hides the typed value, but returns it on submit", async () => {
    const secret = "sk-secret-XYZ";
    let rendered = "";
    const ui = {
      custom: async (factory: CustomFactory): Promise<unknown> => {
        let resolveDone!: (v: unknown) => void;
        const donePromise = new Promise<unknown>((r) => {
          resolveDone = r;
        });
        const popup = await factory(fakeTui(), fakeTheme(), {}, resolveDone);
        for (const ch of secret) popup.handleInput?.(ch);
        rendered = popup.render(60).join("\n");
        popup.handleInput?.("\r"); // Enter → submit
        return await donePromise;
      },
      notify: (): void => {},
      setStatus: (): void => {},
    } as unknown as ExtensionContext["ui"];

    const returned = await inputInBorderedPopup(
      { ui },
      { title: "Enter your Demo API key", prompt: "line one\nline two", mask: true },
    );

    expect(rendered).toContain("•"); // masked glyphs are drawn
    expect(rendered).not.toContain(secret); // the real value is NOT drawn
    expect(rendered).toContain("line one"); // multi-line prompt renders both lines
    expect(rendered).toContain("line two");
    expect(returned).toBe(secret); // the value is still captured for the caller
  });
});

describe("selectInBorderedPopup renders `message` (confirm-message bug fix)", () => {
  it("draws the message body above the list", async () => {
    let rendered = "";
    const ui = {
      custom: async (factory: CustomFactory): Promise<unknown> => {
        const popup = await factory(fakeTui(), fakeTheme(), {}, () => {});
        rendered = popup.render(60).join("\n");
        return null; // cancel; we only need the render
      },
      notify: (): void => {},
      setStatus: (): void => {},
    } as unknown as ExtensionContext["ui"];

    await selectInBorderedPopup(
      { ui },
      {
        title: "Are you sure?",
        message: "This action cannot be undone.",
        items: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      },
    );

    expect(rendered).toContain("This action cannot be undone.");
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
