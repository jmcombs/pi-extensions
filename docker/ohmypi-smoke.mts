/**
 * oh-my-pi smoke proof — real omp loads the LOCAL headroom extension with `op`
 * absent (ADR 0008 interactive rig). Run under **Bun** (omp's engine).
 *
 * It drives omp's OWN extension loader (`loadExtensions` from
 * `@oh-my-pi/pi-coding-agent/.../extensibility/extensions`, the exact function omp
 * startup uses) — path passed in `OMP_LOADER` — against `packages/headroom/index.ts`
 * and enumerates what it registered. Proves omp loads the LOCAL workspace copy,
 * registers `headroom_setup` / `headroom_retrieve` / `session_start`, and that the
 * loaded code + its `@jmcombs/pi-1password` dependency are the workspace copies.
 *
 * Note on resolution (see docker/README.md / ADR 0008): omp hard-remaps
 * `@earendil-works/pi-coding-agent` to its own legacy shim, which omits
 * `createLocalBashOperations` (imported by @jmcombs/pi-1password). The image build
 * adds a **container-only exports override** re-exporting the REAL symbol from the
 * installed `@earendil-works/pi-coding-agent@0.80.9`; this smoke verifies the
 * result. No product source is modified.
 *
 * Prints one `OHMYPI-SMOKE:` line; exits non-zero on any failure.
 */

import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const results: Record<string, string> = {
  agent: "oh-my-pi",
  "omp-version": process.env.OMP_VERSION ?? "unknown",
  "op-absent": "fail",
  "ext-load": "fail",
  setup: "fail",
  retrieve: "fail",
  session_start: "fail",
  "local-headroom": "?",
  "local-1password": "?",
  reason: "",
};

function line(): string {
  return `OHMYPI-SMOKE: agent=${results.agent} omp-version=${results["omp-version"]} op-absent=${results["op-absent"]} ext-load=${results["ext-load"]} setup=${results.setup} retrieve=${results.retrieve} session_start=${results.session_start} local-headroom=${results["local-headroom"]} local-1password=${results["local-1password"]}${results.reason ? ` reason="${results.reason}"` : ""}`;
}

async function main(): Promise<void> {
  let opFound = "";
  try {
    opFound = execSync("command -v op", { shell: "/bin/sh", encoding: "utf8" }).trim();
  } catch {
    opFound = "";
  }
  assert(opFound === "", `expected no op binary, found: ${opFound}`);
  results["op-absent"] = "ok";

  const loaderPath = process.env.OMP_LOADER;
  assert(!!loaderPath, "OMP_LOADER env not set");

  // omp's real loader (imported by absolute path from Bun's global install).
  const { loadExtensions } = (await import(loaderPath as string)) as {
    loadExtensions: (
      paths: string[],
      cwd: string,
    ) => Promise<{
      extensions: Array<{
        resolvedPath?: string;
        path?: string;
        commands: Map<string, unknown>;
        tools: Map<string, unknown>;
        handlers: Map<string, unknown>;
      }>;
      errors: Array<{ path: string; error: string }>;
    }>;
  };

  const cwd = "/app";
  const result = await loadExtensions(["/app/packages/headroom/index.ts"], cwd);
  const ext = result.extensions.find((e) =>
    (e.resolvedPath ?? e.path ?? "").includes("packages/headroom"),
  );
  if (!ext) {
    results["ext-load"] = "BLOCKED";
    results.reason = (result.errors[0]?.error ?? "unknown load error")
      .replace(/\s+/g, " ")
      .slice(0, 200);
    return;
  }
  results["ext-load"] = "ok";

  assert(ext.commands.has("headroom_setup"), "headroom_setup not registered");
  results.setup = "ok";
  assert(ext.tools.has("headroom_retrieve"), "headroom_retrieve not registered");
  results.retrieve = "ok";
  assert(ext.handlers.has("session_start"), "session_start not registered");
  results.session_start = "ok";

  const resolvedHeadroom = realpathSync(ext.resolvedPath ?? (ext.path as string));
  assert(
    resolvedHeadroom.includes("packages/headroom"),
    `headroom not workspace: ${resolvedHeadroom}`,
  );
  results["local-headroom"] = resolvedHeadroom;

  const require = createRequire(import.meta.url);
  const opPkgReal = realpathSync(require.resolve("@jmcombs/pi-1password"));
  assert(opPkgReal.includes("packages/1password"), `1password not workspace: ${opPkgReal}`);
  results["local-1password"] = opPkgReal;
}

main()
  .then(() => {
    console.log(line());
    const ok =
      results["op-absent"] === "ok" &&
      results["ext-load"] === "ok" &&
      results.setup === "ok" &&
      results.retrieve === "ok" &&
      results.session_start === "ok" &&
      results["local-headroom"].includes("packages/headroom") &&
      results["local-1password"].includes("packages/1password");
    process.exit(ok ? 0 : 1);
  })
  .catch((err) => {
    if (!results.reason) {
      results.reason = (err instanceof Error ? err.message : String(err))
        .replace(/\s+/g, " ")
        .slice(0, 200);
    }
    console.log(line());
    process.exit(1);
  });
