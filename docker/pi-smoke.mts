/**
 * Extension load check — REAL pi side (op absent).
 *
 * Thin wrapper over the package-agnostic harness (`smoke-harness.mts`). Drives
 * pi's OWN public extension loader — `discoverAndLoadExtensions` from
 * `@earendil-works/pi-coding-agent`, the exact function pi's startup uses — over
 * every auto-discovered `packages/*` extension (private packages excluded + logged)
 * and asserts each package's expected, platform-aware surface. Provider-only
 * packages (relay) are captured by invoking the factory against a stub
 * `ExtensionAPI` that records `registerProvider`.
 *
 * On pi the `user_bash` handler and the `createLocalBashOperations` host API are
 * present, so `@jmcombs/pi-1password`'s pi-only `user_bash` hook is asserted PRESENT.
 *
 * Prints one machine-checkable `PI-SMOKE:` summary line; exits non-zero on any
 * unexpected non-load or missing/extra surface.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { captureProviders, type LoadResult, runHarness } from "./smoke-harness.mts";

const repoRoot = process.cwd();
const cwd = repoRoot;
const agentDir = process.env.PI_CODING_AGENT_DIR ?? resolve(repoRoot, ".throwaway-agent");

const code = await runHarness({
  platform: "pi",
  repoRoot,
  cwd,
  summaryPrefix: "PI-SMOKE:",
  loadExtensions: async (paths, dir): Promise<LoadResult> => {
    const r = await discoverAndLoadExtensions(paths, dir, agentDir);
    return { extensions: r.extensions as LoadResult["extensions"], errors: r.errors };
  },
  invokeFactory: async (absPath) => {
    const mod = (await import(pathToFileURL(absPath).href)) as {
      default: (api: unknown) => unknown | Promise<unknown>;
    };
    return captureProviders(mod.default);
  },
});

process.exit(code);
