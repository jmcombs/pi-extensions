/**
 * Non-interactive smoke proof — real pi loads the LOCAL headroom extension with
 * `op` absent (ADR 0008 interactive rig).
 *
 * Unlike `offline-creds-check.mts` (which validates the credential *logic* by
 * calling internal functions with a stubbed UI), this harness drives pi's OWN
 * public extension loader — `discoverAndLoadExtensions` from
 * `@earendil-works/pi-coding-agent`, the exact function pi's startup uses — to
 * load `packages/headroom/index.ts` and enumerate what it registered. It proves:
 *
 *   - the headroom extension loads under real pi with `op` absent (no crash);
 *   - it registers the `headroom_setup` command, the `headroom_retrieve` tool,
 *     and the `session_start` handler;
 *   - the loaded code is the LOCAL workspace copy (resolvedPath under
 *     packages/headroom), and its `@jmcombs/pi-1password` dependency resolves to
 *     the LOCAL workspace package (packages/1password), not an npm-published one.
 *
 * The interactive onboarding itself (walking `/headroom_setup` in the real TUI)
 * is the maintainer's to eyeball via `docker/run-pi.sh`.
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

const results: Record<string, string> = {
  agent: "pi",
  "op-absent": "fail",
  "headroom-loaded": "fail",
  setup: "fail",
  retrieve: "fail",
  session_start: "fail",
  "local-headroom": "?",
  "local-1password": "?",
};

async function main(): Promise<void> {
  const cwd = process.cwd();

  // op genuinely absent.
  let opFound = "";
  try {
    opFound = execSync("command -v op", { shell: "/bin/sh", encoding: "utf8" }).trim();
  } catch {
    opFound = "";
  }
  assert(opFound === "", `expected no op binary, found: ${opFound}`);
  results["op-absent"] = "ok";

  // Drive pi's REAL loader against the LOCAL workspace extension.
  const headroomPath = resolve(cwd, "packages/headroom/index.ts");
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? resolve(cwd, ".throwaway-agent");
  const result = await discoverAndLoadExtensions([headroomPath], cwd, agentDir);

  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(`  load error: ${e.path}: ${e.error}`);
  }
  const ext = result.extensions.find((e) =>
    (e.resolvedPath ?? e.path ?? "").includes("packages/headroom"),
  );
  assert(ext !== undefined, `headroom extension not loaded (errors: ${result.errors.length})`);
  if (!ext) return;
  results["headroom-loaded"] = "ok";

  const commands = [...ext.commands.keys()];
  const tools = [...ext.tools.keys()];
  const events = [...ext.handlers.keys()];

  assert(commands.includes("headroom_setup"), `headroom_setup not registered: ${commands}`);
  results.setup = "ok";
  assert(tools.includes("headroom_retrieve"), `headroom_retrieve not registered: ${tools}`);
  results.retrieve = "ok";
  assert(events.includes("session_start"), `session_start not registered: ${events}`);
  results.session_start = "ok";

  // Prove the loaded headroom is the LOCAL workspace file.
  const resolvedHeadroom = realpathSync(ext.resolvedPath ?? ext.path);
  assert(
    resolvedHeadroom.includes("packages/headroom"),
    `headroom not loaded from workspace: ${resolvedHeadroom}`,
  );
  results["local-headroom"] = resolvedHeadroom;

  // Prove @jmcombs/pi-1password resolves to the LOCAL workspace package. In a
  // workspace, node_modules/@jmcombs/pi-1password is a symlink to
  // packages/1password, so realpath lands OUTSIDE node_modules.
  const require = createRequire(import.meta.url);
  const opPkgReal = realpathSync(require.resolve("@jmcombs/pi-1password"));
  assert(
    opPkgReal.includes("packages/1password"),
    `@jmcombs/pi-1password not the workspace copy: ${opPkgReal}`,
  );
  results["local-1password"] = opPkgReal;
}

function line(): string {
  return `PI-SMOKE: agent=${results.agent} op-absent=${results["op-absent"]} headroom-loaded=${results["headroom-loaded"]} setup=${results.setup} retrieve=${results.retrieve} session_start=${results.session_start} local-headroom=${results["local-headroom"]} local-1password=${results["local-1password"]}`;
}

main()
  .then(() => {
    console.log(line());
    const ok =
      results["op-absent"] === "ok" &&
      results["headroom-loaded"] === "ok" &&
      results.setup === "ok" &&
      results.retrieve === "ok" &&
      results.session_start === "ok" &&
      results["local-headroom"].includes("packages/headroom") &&
      results["local-1password"].includes("packages/1password");
    process.exit(ok ? 0 : 1);
  })
  .catch((err) => {
    console.log(line());
    console.error("PI-SMOKE FAILED:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
