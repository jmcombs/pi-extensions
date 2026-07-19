/**
 * Non-interactive smoke proof — real pi loads the LOCAL context7 + headroom
 * extensions with `op` absent (ADR 0008 interactive rig).
 *
 * Drives pi's OWN public extension loader — `discoverAndLoadExtensions` from
 * `@earendil-works/pi-coding-agent`, the exact function pi's startup uses — to load
 * `packages/context7/index.ts` and `packages/headroom/index.ts` and enumerate what
 * they registered. Proves both load under real pi with `op` absent, register their
 * commands/tools, and that the loaded code (and the shared `@jmcombs/pi-1password`
 * dependency) are the LOCAL workspace copies.
 *
 * The interactive onboarding itself (`/context7_setup`, `/headroom_setup` in the
 * real TUI) is the maintainer's to eyeball via `docker/run-pi.sh`.
 *
 * Prints one machine-checkable `PI-SMOKE:` line; exits non-zero on any failure.
 */

import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

type LoadedExt = {
  resolvedPath?: string;
  path?: string;
  commands: Map<string, unknown>;
  tools: Map<string, unknown>;
  handlers: Map<string, unknown>;
};

const results: Record<string, string> = {
  agent: "pi",
  "op-absent": "fail",
  context7: "fail",
  context7_setup: "fail",
  context7_search: "fail",
  context7_get_docs: "fail",
  headroom: "fail",
  headroom_setup: "fail",
  headroom_retrieve: "fail",
  session_start: "fail",
  "local-context7": "?",
  "local-headroom": "?",
  "local-1password": "?",
};

function line(): string {
  const k = Object.keys(results);
  return `PI-SMOKE: ${k.map((key) => `${key}=${results[key]}`).join(" ")}`;
}

async function main(): Promise<void> {
  const cwd = process.cwd();

  let opFound = "";
  try {
    opFound = execSync("command -v op", { shell: "/bin/sh", encoding: "utf8" }).trim();
  } catch {
    opFound = "";
  }
  assert(opFound === "", `expected no op binary, found: ${opFound}`);
  results["op-absent"] = "ok";

  const context7Path = resolve(cwd, "packages/context7/index.ts");
  const headroomPath = resolve(cwd, "packages/headroom/index.ts");
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? resolve(cwd, ".throwaway-agent");
  const result = await discoverAndLoadExtensions([context7Path, headroomPath], cwd, agentDir);
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(`  load error: ${e.path}: ${e.error}`);
  }
  const find = (needle: string): LoadedExt | undefined =>
    (result.extensions as LoadedExt[]).find((e) =>
      (e.resolvedPath ?? e.path ?? "").includes(needle),
    );

  // context7
  const c7 = find("packages/context7");
  assert(!!c7, `context7 not loaded (errors: ${result.errors.length})`);
  if (c7) {
    results.context7 = "ok";
    results.context7_setup = c7.commands.has("context7_setup") ? "ok" : "missing";
    results.context7_search = c7.tools.has("context7_search") ? "ok" : "missing";
    results.context7_get_docs = c7.tools.has("context7_get_docs") ? "ok" : "missing";
    results["local-context7"] = realpathSync(c7.resolvedPath ?? (c7.path as string));
  }

  // headroom
  const hr = find("packages/headroom");
  assert(!!hr, `headroom not loaded (errors: ${result.errors.length})`);
  if (hr) {
    results.headroom = "ok";
    results.headroom_setup = hr.commands.has("headroom_setup") ? "ok" : "missing";
    results.headroom_retrieve = hr.tools.has("headroom_retrieve") ? "ok" : "missing";
    results.session_start = hr.handlers.has("session_start") ? "ok" : "missing";
    results["local-headroom"] = realpathSync(hr.resolvedPath ?? (hr.path as string));
  }

  // Shared dep resolves to the LOCAL workspace package.
  const require = createRequire(import.meta.url);
  results["local-1password"] = realpathSync(require.resolve("@jmcombs/pi-1password"));
}

function allOk(): boolean {
  return (
    results["op-absent"] === "ok" &&
    results.context7 === "ok" &&
    results.context7_setup === "ok" &&
    results.context7_search === "ok" &&
    results.context7_get_docs === "ok" &&
    results.headroom === "ok" &&
    results.headroom_setup === "ok" &&
    results.headroom_retrieve === "ok" &&
    results.session_start === "ok" &&
    results["local-context7"].includes("packages/context7") &&
    results["local-headroom"].includes("packages/headroom") &&
    results["local-1password"].includes("packages/1password")
  );
}

main()
  .then(() => {
    console.log(line());
    process.exit(allOk() ? 0 : 1);
  })
  .catch((err) => {
    console.log(line());
    console.error("PI-SMOKE FAILED:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
