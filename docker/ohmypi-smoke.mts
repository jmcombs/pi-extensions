/**
 * Cross-platform validation — STOCK oh-my-pi side (op absent). Run under Bun.
 *
 * Thin wrapper over the package-agnostic harness (`smoke-harness.mts`). Drives
 * omp's OWN extension loader (`loadExtensions` from
 * `@oh-my-pi/pi-coding-agent/.../extensibility/extensions`, path passed in
 * `OMP_LOADER`) over every auto-discovered `packages/*` extension (private packages
 * excluded + logged) and asserts each package's expected, platform-aware surface.
 * Provider-only packages (relay) are captured by invoking the factory against a
 * stub `ExtensionAPI` that records `registerProvider`.
 *
 * This works on STOCK omp because extensions feature-detect optional pi host APIs
 * (namespace import + runtime check) instead of statically importing them — so they
 * link under omp's compat shim, which omits some exports. Consequently
 * `@jmcombs/pi-1password`'s `user_bash` hook is asserted ABSENT here (pi-only),
 * while its agent-bash tool + `1p_diagnose` are present.
 *
 * Prints one machine-checkable `OHMYPI-SMOKE:` summary line; exits non-zero on any
 * unexpected non-load or missing/extra surface.
 */

import { captureProviders, type LoadResult, runHarness } from "./smoke-harness.mts";

const loaderPath = process.env.OMP_LOADER;
if (!loaderPath) {
  console.error("FAIL: OMP_LOADER env not set");
  process.exit(1);
}

const { loadExtensions } = (await import(loaderPath)) as {
  loadExtensions: (paths: string[], cwd: string) => Promise<LoadResult>;
};

// process.cwd() is the repo root in both hosts of this smoke: the Docker image sets
// WORKDIR /app, and the runner-native CI job runs from the checkout root.
const repoRoot = process.cwd();

const code = await runHarness({
  platform: "oh-my-pi",
  repoRoot,
  cwd: repoRoot,
  summaryPrefix: "OHMYPI-SMOKE:",
  extra: { "omp-version": process.env.OMP_VERSION ?? "unknown" },
  loadExtensions: (paths, dir) => loadExtensions(paths, dir),
  invokeFactory: async (absPath) => {
    const mod = (await import(absPath)) as {
      default: (api: unknown) => unknown | Promise<unknown>;
    };
    return captureProviders(mod.default);
  },
});

process.exit(code);
