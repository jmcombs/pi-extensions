/**
 * oh-my-pi smoke proof — real STOCK omp loads the LOCAL context7 + headroom
 * extensions with `op` absent (ADR 0008 interactive rig). Run under **Bun**.
 *
 * Drives omp's OWN extension loader (`loadExtensions` from
 * `@oh-my-pi/pi-coding-agent/.../extensibility/extensions`, the exact function omp
 * startup uses) — path passed in `OMP_LOADER` — against the two LOCAL extensions
 * and enumerates what they registered. Proves stock (unpatched) omp loads the
 * workspace copies, registers their commands/tools, and that the shared
 * `@jmcombs/pi-1password` dependency is the workspace copy.
 *
 * This works on STOCK omp because `@jmcombs/pi-1password` now feature-detects
 * `createLocalBashOperations` (namespace import; `user_bash` hook only when
 * present) instead of statically importing it — so it links under omp's compat
 * shim, which omits that export. No product source is patched in the image.
 *
 * Prints one `OHMYPI-SMOKE:` line; exits non-zero on any failure.
 */

import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";

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
  agent: "oh-my-pi",
  "omp-version": process.env.OMP_VERSION ?? "unknown",
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
  reason: "",
};

function line(): string {
  const k = Object.keys(results).filter((key) => key !== "reason" || results.reason);
  return `OHMYPI-SMOKE: ${k.map((key) => `${key}=${key === "reason" ? `"${results[key]}"` : results[key]}`).join(" ")}`;
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

  const { loadExtensions } = (await import(loaderPath as string)) as {
    loadExtensions: (
      paths: string[],
      cwd: string,
    ) => Promise<{
      extensions: LoadedExt[];
      errors: Array<{ path: string; error: string }>;
    }>;
  };

  const cwd = "/app";
  const result = await loadExtensions(
    ["/app/packages/context7/index.ts", "/app/packages/headroom/index.ts"],
    cwd,
  );
  const find = (needle: string): LoadedExt | undefined =>
    result.extensions.find((e) => (e.resolvedPath ?? e.path ?? "").includes(needle));

  const c7 = find("packages/context7");
  const hr = find("packages/headroom");
  if (!c7 || !hr) {
    results.reason = (result.errors[0]?.error ?? "unknown load error")
      .replace(/\s+/g, " ")
      .slice(0, 200);
    if (!c7) results.context7 = "BLOCKED";
    if (!hr) results.headroom = "BLOCKED";
    return;
  }

  results.context7 = "ok";
  results.context7_setup = c7.commands.has("context7_setup") ? "ok" : "missing";
  results.context7_search = c7.tools.has("context7_search") ? "ok" : "missing";
  results.context7_get_docs = c7.tools.has("context7_get_docs") ? "ok" : "missing";
  results["local-context7"] = realpathSync(c7.resolvedPath ?? (c7.path as string));

  results.headroom = "ok";
  results.headroom_setup = hr.commands.has("headroom_setup") ? "ok" : "missing";
  results.headroom_retrieve = hr.tools.has("headroom_retrieve") ? "ok" : "missing";
  results.session_start = hr.handlers.has("session_start") ? "ok" : "missing";
  results["local-headroom"] = realpathSync(hr.resolvedPath ?? (hr.path as string));

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
    if (!results.reason) {
      results.reason = (err instanceof Error ? err.message : String(err))
        .replace(/\s+/g, " ")
        .slice(0, 200);
    }
    console.log(line());
    process.exit(1);
  });
