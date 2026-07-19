/**
 * Offline (no-`op`) credential validation.
 *
 * Runs INSIDE the op-less Docker container (`docker/offline-creds.Dockerfile`)
 * with a throwaway agent directory pointed at by `PI_CODING_AGENT_DIR` — never
 * the host's `~/.pi`. Proves the `@jmcombs/pi-1password` credential API and the
 * `headroom` consumer behave correctly when the `op` binary is absent:
 *
 *   1. `op` is genuinely not on PATH.
 *   2. `is1PasswordAvailable()` → false.
 *   3. A key can be added WITHOUT op via the manual/literal onboarding branch.
 *   4. `resolveSecret` returns that literal (no op needed).
 *   5. An `!op read` reference resolves to `undefined` gracefully (no throw).
 *   6. The headroom extension loads (registers its command + tools) with op absent.
 *   7. headroom runs keyless: `resolveConfig` → apiKey undefined, client constructs.
 *
 * Nothing here mocks the filesystem, `op`, or any project helper — it drives the
 * exported functions exactly as a consumer extension would. Prints one
 * machine-checkable `OFFLINE-CREDS:` line and exits non-zero on any failed
 * assertion.
 */

import { execSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Consumer-facing surface, imported relatively from the workspace sources.
import {
  is1PasswordAvailable,
  onboardSecret,
  resolveSecret,
  writeProviderAuthEntry,
} from "../packages/1password/index.ts";
import { getClient, resolveConfig } from "../packages/headroom/client.ts";
import headroomFactory from "../packages/headroom/index.ts";

type Ui = { custom: () => Promise<unknown>; notify: () => void; setStatus: () => void };

/** A bare `{ ui }` double that hands `onboardSecret`'s masked input a literal key. */
function literalUi(value: string): { ui: Ui } {
  return {
    ui: {
      custom: async () => value,
      notify: () => {},
      setStatus: () => {},
    },
  };
}

async function withAgentDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "offline-creds-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

async function readAuth(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, "auth.json"), "utf8")) as Record<string, unknown>;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const LITERAL = "hdrm-offline-literal-abc123";

const results: Record<string, string> = {
  "op-absent": "fail",
  available: "unknown",
  "add-key": "fail",
  "resolve-literal": "fail",
  "resolve-opref": "fail",
  loads: "fail",
  keyless: "fail",
};

async function main(): Promise<void> {
  // 1. op truly absent — `command -v op` exits non-zero when nothing is found.
  let opFound = "";
  try {
    opFound = execSync("command -v op", { shell: "/bin/sh", encoding: "utf8" }).trim();
  } catch {
    opFound = "";
  }
  assert(opFound === "", `expected no op binary, found: ${opFound}`);
  results["op-absent"] = "ok";

  // 2. is1PasswordAvailable() → false (op --version fails when op is absent).
  const available = await is1PasswordAvailable();
  assert(available === false, `is1PasswordAvailable() expected false, got ${available}`);
  results.available = String(available); // "false"

  // 3. Add a key WITHOUT op via the manual/literal onboarding branch.
  // 4. resolveSecret returns the literal.
  await withAgentDir(async (dir) => {
    const res = await onboardSecret(literalUi(LITERAL) as never, {
      name: "headroom",
      label: "Headroom",
    });
    assert(res.ok === true, `onboardSecret expected ok, got ${JSON.stringify(res)}`);

    const stored = (await readAuth(dir)).headroom;
    assert(
      JSON.stringify(stored) === JSON.stringify({ type: "api_key", key: LITERAL }),
      `auth.json headroom entry wrong: ${JSON.stringify(stored)}`,
    );
    results["add-key"] = "ok";

    const resolved = await resolveSecret("headroom");
    assert(resolved === LITERAL, `resolveSecret expected literal, got ${String(resolved)}`);
    results["resolve-literal"] = "ok";
  });

  // 5. An !op read reference resolves to undefined gracefully (op absent, no throw).
  await withAgentDir(async () => {
    const w = await writeProviderAuthEntry("headroom", "!op read op://Vault/Item/field", {
      overwrite: true,
    });
    assert(w.success === true, `writeProviderAuthEntry failed: ${JSON.stringify(w)}`);
    const resolved = await resolveSecret("headroom");
    assert(
      resolved === undefined,
      `resolveSecret of !op read ref expected undefined, got ${String(resolved)}`,
    );
    results["resolve-opref"] = "undefined";
  });

  // 6. The headroom extension loads with op absent — registers its command + tools.
  const commands: string[] = [];
  const tools: string[] = [];
  const events: string[] = [];
  const pi = {
    registerFlag: () => {},
    registerTool: (def: { name: string }) => {
      tools.push(def.name);
    },
    registerCommand: (name: string) => {
      commands.push(name);
    },
    on: (event: string) => {
      events.push(event);
    },
    getFlag: () => false,
  } as unknown as ExtensionAPI;
  headroomFactory(pi);
  assert(commands.includes("headroom_setup"), `headroom_setup not registered: ${commands}`);
  assert(tools.includes("headroom_retrieve"), `headroom_retrieve not registered: ${tools}`);
  assert(events.includes("session_start"), `session_start not registered: ${events}`);
  results.loads = "ok";

  // 7. headroom runs keyless — resolveConfig → apiKey undefined, client constructs.
  await withAgentDir(async () => {
    delete process.env.HEADROOM_API_KEY;
    const cfg = await resolveConfig();
    assert(
      cfg.apiKey === undefined,
      `keyless resolveConfig expected apiKey undefined, got ${cfg.apiKey}`,
    );
    assert(typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0, "keyless baseUrl missing");
    const client = await getClient();
    assert(client !== null && typeof client === "object", "keyless getClient did not construct");
    results.keyless = "ok";
  });
}

main()
  .then(() => {
    const line = `OFFLINE-CREDS: op-absent=${results["op-absent"]} available=${results.available} add-key=${results["add-key"]} resolve-literal=${results["resolve-literal"]} resolve-opref=${results["resolve-opref"]} loads=${results.loads} keyless=${results.keyless}`;
    console.log(line);
    const allOk =
      results["op-absent"] === "ok" &&
      results.available === "false" &&
      results["add-key"] === "ok" &&
      results["resolve-literal"] === "ok" &&
      results["resolve-opref"] === "undefined" &&
      results.loads === "ok" &&
      results.keyless === "ok";
    process.exit(allOk ? 0 : 1);
  })
  .catch((err) => {
    const line = `OFFLINE-CREDS: op-absent=${results["op-absent"]} available=${results.available} add-key=${results["add-key"]} resolve-literal=${results["resolve-literal"]} resolve-opref=${results["resolve-opref"]} loads=${results.loads} keyless=${results.keyless}`;
    console.log(line);
    console.error("OFFLINE-CREDS FAILED:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
