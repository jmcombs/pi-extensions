/**
 * oh-my-pi diagnostic — does the LOCAL headroom extension load under omp with
 * `op` absent? (ADR 0008 interactive rig.)
 *
 * Run under **Bun** (oh-my-pi's engine). It drives omp's OWN extension loader
 * (`loadExtensions` from `@oh-my-pi/pi-coding-agent/.../extensibility/extensions`,
 * the exact function omp startup uses) against `packages/headroom/index.ts` and
 * reports the real outcome. The omp package/loader path is passed in `OMP_LOADER`.
 *
 * Prints one `OHMYPI-SMOKE:` line. Honest by construction: if the extension
 * loads it enumerates the registrations; if omp's legacy shim rejects it, it
 * reports `ext-load=BLOCKED` with the exact reason (no faking).
 */

import { execSync } from "node:child_process";

const results: Record<string, string> = {
  agent: "oh-my-pi",
  "omp-version": process.env.OMP_VERSION ?? "unknown",
  "op-absent": "fail",
  "ext-load": "fail",
  setup: "n/a",
  retrieve: "n/a",
  session_start: "n/a",
  reason: "",
};

function line(): string {
  return `OHMYPI-SMOKE: agent=${results.agent} omp-version=${results["omp-version"]} op-absent=${results["op-absent"]} ext-load=${results["ext-load"]} setup=${results.setup} retrieve=${results.retrieve} session_start=${results.session_start}${results.reason ? ` reason="${results.reason}"` : ""}`;
}

async function main(): Promise<void> {
  let opFound = "";
  try {
    opFound = execSync("command -v op", { shell: "/bin/sh", encoding: "utf8" }).trim();
  } catch {
    opFound = "";
  }
  results["op-absent"] = opFound === "" ? "ok" : `present:${opFound}`;

  const loaderPath = process.env.OMP_LOADER;
  if (!loaderPath) {
    results["ext-load"] = "error";
    results.reason = "OMP_LOADER env not set";
    return;
  }

  // omp's real loader. Import by absolute path (omp lives in Bun's global dir).
  const { loadExtensions } = (await import(loaderPath)) as {
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
  results.setup = ext.commands.has("headroom_setup") ? "ok" : "missing";
  results.retrieve = ext.tools.has("headroom_retrieve") ? "ok" : "missing";
  results.session_start = ext.handlers.has("session_start") ? "ok" : "missing";
}

main()
  .then(() => {
    console.log(line());
    // Diagnostic: exit 0 (informational). The pi smoke is the pass/fail gate;
    // the oh-my-pi result is reported honestly for the maintainer to act on.
    process.exit(0);
  })
  .catch((err) => {
    results["ext-load"] = "error";
    results.reason = (err instanceof Error ? err.message : String(err))
      .replace(/\s+/g, " ")
      .slice(0, 200);
    console.log(line());
    process.exit(0);
  });
