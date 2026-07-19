/**
 * Package-agnostic cross-platform validation harness.
 *
 * Shared engine behind the two op-absent smokes (`pi-smoke.mts` on real pi,
 * `ohmypi-smoke.mts` on stock oh-my-pi). It:
 *
 *   1. AUTO-DISCOVERS every extension by reading each `packages/*\/package.json`
 *      and ITERATING its `pi.extensions` array (never hardcoding `./index.ts`).
 *   2. Excludes `private: true` packages and LOGS every skip (visible, enumerated
 *      — not a silent miss). Today that drops only `packages/_template`.
 *   3. Drives every in-scope extension through the host's OWN real loader (pi's
 *      `discoverAndLoadExtensions` / omp's `loadExtensions`) with `op` absent and
 *      asserts each package's expected, PLATFORM-AWARE surface (`EXPECTED` below).
 *
 * Failure semantics: any in-scope package that fails to load, is missing an
 * expected surface member, exposes a surface that should be platform-absent, or
 * has no `EXPECTED` entry ⇒ FAILURE (non-zero). Only the enumerated `private`
 * set is ever skipped.
 *
 * Provider-only packages (relay) register nothing in the loader's
 * commands/tools/handlers maps — the loader result has no `providers` field — so
 * their surface is captured by invoking the extension factory against a stub
 * `ExtensionAPI` that records `registerProvider` calls (mirrors
 * `packages/relay/index.test.ts`).
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────

/** The subset of a loaded extension both hosts' loaders expose. */
export interface LoadedExt {
  resolvedPath?: string;
  path?: string;
  tools?: Map<string, unknown>;
  commands?: Map<string, unknown>;
  handlers?: Map<string, unknown>;
  shortcuts?: Map<string, unknown>;
}

export interface LoadResult {
  extensions: LoadedExt[];
  errors: Array<{ path: string; error: string }>;
}

export type Platform = "pi" | "oh-my-pi";

/**
 * A surface list is either present on BOTH hosts (`string[]`) or split into
 * cross-host (`both`) plus per-host members. `piOnly` members are asserted PRESENT
 * on pi and ABSENT on oh-my-pi; `ompOnly` members the reverse. This is how a host
 * API that an extension feature-detects (e.g. `@jmcombs/pi-1password`'s `user_bash`
 * hook, gated on `createLocalBashOperations`) is validated as pi-only by design.
 *
 * The assertion is STRICT (exact-set): for each category, the ACTUAL registered
 * members must equal the platform-resolved expected set — anything MISSING and
 * anything EXTRA both fail. So every registered member of every non-private package
 * MUST appear here; an incomplete entry fails loudly rather than passing on a subset.
 */
export type SurfaceList = string[] | { both?: string[]; piOnly?: string[]; ompOnly?: string[] };

/** The expected, platform-aware surface for one package. */
export interface Expected {
  tools?: SurfaceList;
  commands?: SurfaceList;
  handlers?: SurfaceList;
  shortcuts?: SurfaceList;
  /** Providers, captured via the stub-`ExtensionAPI` `registerProvider` path. */
  providers?: string[];
  /** One-line human description of this package's declared surface. */
  note: string;
}

// ── Per-package expected-surface table (data-driven, platform-aware, STRICT) ──
//
// Keyed by package directory name. The COMPLETE registered surface of each
// non-private package, verified against a REAL load on BOTH pi and stock oh-my-pi
// before being encoded. Because the assertion is exact-set (extras fail too), every
// entry must be complete: a package with no entry, a missing member, OR an
// undeclared extra member all FAIL. Categories a package registers nothing for are
// omitted (they must then be actually empty).
//
// The only pi-vs-omp difference across all ten packages is 1password's `user_bash`
// handler (pi-only, feature-detected on `createLocalBashOperations`).
//
// | package         | tools                             | commands                                                   | handlers                                                 | shortcuts / providers                 |
// | --------------- | --------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------- |
// | 1password       | bash, 1p_diagnose                 | 1password_diagnose, 1password_setup                        | session_start (both) + user_bash (PI-ONLY)               | —                                     |
// | better-toolsy   | ls, read, grep, find, edit, write | —                                                          | tool_call                                                | —                                     |
// | blue-psl-10k    | —                                 | blue-psl-restore-footer                                    | session_start, model_select, turn_end, thinking_level_select | —                                 |
// | context7        | context7_search, context7_get_docs| context7_setup                                             | —                                                        | —                                     |
// | grok-search     | grok_search                       | grok_setup                                                 | —                                                        | —                                     |
// | headroom        | headroom_retrieve                 | headroom-status, headroom_setup, headroom-stats, headroom-simulate | context, session_start                          | —                                     |
// | notify          | —                                 | notify                                                     | agent_start, turn_end, tool_execution_end, agent_end     | —                                     |
// | prompt-enhancer | —                                 | enhance, enhance-model, enhance-revert                     | session_start, session_shutdown, model_select, input     | shortcuts ctrl+shift+p, ctrl+shift+z  |
// | relay           | —                                 | —                                                          | —                                                        | providers relay-claude, relay-grok (via stub) |
// | tavily-search   | tavily_search                     | tavily_setup                                               | —                                                        | —                                     |

export const EXPECTED: Record<string, Expected> = {
  "1password": {
    tools: ["bash", "1p_diagnose"],
    commands: ["1password_diagnose", "1password_setup"],
    handlers: { both: ["session_start"], piOnly: ["user_bash"] },
    note: "tools bash + 1p_diagnose; commands 1password_diagnose + 1password_setup; session_start handler; user_bash handler pi-only (feature-detected)",
  },
  "better-toolsy": {
    tools: ["ls", "read", "grep", "find", "edit", "write"],
    handlers: ["tool_call"],
    note: "tools ls/read/grep/find/edit/write; tool_call handler",
  },
  "blue-psl-10k": {
    commands: ["blue-psl-restore-footer"],
    handlers: ["session_start", "model_select", "turn_end", "thinking_level_select"],
    note: "footer/lifecycle handlers + blue-psl-restore-footer command",
  },
  context7: {
    tools: ["context7_search", "context7_get_docs"],
    commands: ["context7_setup"],
    note: "setup command + search/get-docs tools",
  },
  "grok-search": {
    tools: ["grok_search"],
    commands: ["grok_setup"],
    note: "setup command + grok_search tool",
  },
  headroom: {
    tools: ["headroom_retrieve"],
    commands: ["headroom-status", "headroom_setup", "headroom-stats", "headroom-simulate"],
    handlers: ["context", "session_start"],
    note: "setup/status/stats/simulate commands + headroom_retrieve tool + context/session_start handlers",
  },
  notify: {
    commands: ["notify"],
    handlers: ["agent_start", "turn_end", "tool_execution_end", "agent_end"],
    note: "lifecycle handlers + notify command",
  },
  "prompt-enhancer": {
    commands: ["enhance", "enhance-model", "enhance-revert"],
    handlers: ["session_start", "session_shutdown", "model_select", "input"],
    shortcuts: ["ctrl+shift+p", "ctrl+shift+z"],
    note: "commands + handlers + shortcuts, no tools",
  },
  relay: {
    providers: ["relay-claude", "relay-grok"],
    note: "providers only: relay-claude, relay-grok (via stub registerProvider)",
  },
  "tavily-search": {
    tools: ["tavily_search"],
    commands: ["tavily_setup"],
    note: "setup command + tavily_search tool",
  },
};

// ── Discovery ──────────────────────────────────────────────────────────────

export interface DiscoveredPackage {
  dir: string;
  name: string;
  /** Absolute paths from the package's `pi.extensions` array (iterated). */
  paths: string[];
}

export interface SkippedPackage {
  dir: string;
  name: string;
  reason: string;
}

/**
 * Read every `packages/*\/package.json`, iterate its `pi.extensions` array, and
 * partition into in-scope vs. skipped (`private: true`). The skip set is an
 * allowlisted, enumerated set — never "skip anything that looks empty".
 */
export function discoverPackages(repoRoot: string): {
  inScope: DiscoveredPackage[];
  skipped: SkippedPackage[];
} {
  const pkgsDir = resolve(repoRoot, "packages");
  const inScope: DiscoveredPackage[] = [];
  const skipped: SkippedPackage[] = [];

  for (const dir of readdirSync(pkgsDir).sort()) {
    const abs = resolve(pkgsDir, dir);
    const pjPath = resolve(abs, "package.json");
    if (!statSync(abs).isDirectory() || !existsSync(pjPath)) continue; // e.g. .DS_Store
    const pj = JSON.parse(readFileSync(pjPath, "utf8")) as {
      name?: string;
      private?: boolean;
      pi?: { extensions?: string[] };
    };
    const name = pj.name ?? dir;
    if (pj.private) {
      skipped.push({ dir, name, reason: "private:true" });
      continue;
    }
    const exts = pj.pi?.extensions ?? [];
    const paths = exts.map((e) => resolve(abs, e));
    inScope.push({ dir, name, paths });
  }

  return { inScope, skipped };
}

// ── Provider capture (stub ExtensionAPI) ─────────────────────────────────────

type Factory = (api: unknown) => unknown | Promise<unknown>;

/**
 * Invoke an extension factory against a stub `ExtensionAPI` that records
 * `registerProvider` calls, returning the registered provider names. Every other
 * method throws — a provider-only package that touches them exposes an
 * unexpected surface and fails loudly. Mirrors `packages/relay/index.test.ts`.
 */
export async function captureProviders(factory: Factory): Promise<string[]> {
  const providers: string[] = [];
  const notImplemented = (method: string) => () => {
    throw new Error(`ExtensionAPI.${method} not expected for a provider-only package`);
  };
  const api = {
    registerProvider: (name: string) => {
      providers.push(name);
    },
    unregisterProvider: notImplemented("unregisterProvider"),
    registerTool: notImplemented("registerTool"),
    registerCommand: notImplemented("registerCommand"),
    registerShortcut: notImplemented("registerShortcut"),
    on: notImplemented("on"),
    events: { emit: notImplemented("events.emit") },
  };
  await factory(api);
  return providers;
}

// ── Evaluation ───────────────────────────────────────────────────────────────

/** Members expected PRESENT on this platform (both + the platform's own-only). */
function presentRequired(list: SurfaceList | undefined, platform: Platform): string[] {
  if (!list) return [];
  if (Array.isArray(list)) return list;
  return [
    ...(list.both ?? []),
    ...(platform === "pi" ? (list.piOnly ?? []) : []),
    ...(platform === "oh-my-pi" ? (list.ompOnly ?? []) : []),
  ];
}

/** Members expected ABSENT on this platform (the OTHER platform's own-only). */
function absentRequired(list: SurfaceList | undefined, platform: Platform): string[] {
  if (!list || Array.isArray(list)) return [];
  return platform === "oh-my-pi" ? (list.piOnly ?? []) : (list.ompOnly ?? []);
}

export interface EvalResult {
  pass: boolean;
  failures: string[];
  summary: string;
}

/**
 * Pure, STRICT surface check for one package. `ext` is `undefined` when the package
 * did not load (⇒ a failure). `providers` is the captured provider list (empty if
 * the package declares none). No I/O — unit-testable and the core of the failure
 * semantics.
 *
 * For EACH category (tools, commands, handlers, shortcuts, providers) the ACTUAL
 * registered set must EQUAL the platform-resolved expected set: any expected member
 * that is MISSING and any actual member that is EXTRA (not expected) both fail. A
 * `piOnly` member is expected-present on pi and expected-absent on oh-my-pi, so on
 * oh-my-pi it surfaces as an EXTRA if the extension wrongly registers it there.
 */
export function evaluatePackage(
  platform: Platform,
  expected: Expected | undefined,
  ext: LoadedExt | undefined,
  providers: string[],
): EvalResult {
  const failures: string[] = [];

  if (!expected) {
    return {
      pass: false,
      failures: ["no EXPECTED surface entry — add one to the harness table"],
      summary: "no-entry",
    };
  }

  if (!ext && !expected.providers) {
    // A non-provider package that did not load at all.
    return { pass: false, failures: ["did not load"], summary: "did-not-load" };
  }

  const cats: Array<["tools" | "commands" | "handlers" | "shortcuts", Map<string, unknown>]> = [
    ["tools", ext?.tools ?? new Map()],
    ["commands", ext?.commands ?? new Map()],
    ["handlers", ext?.handlers ?? new Map()],
    ["shortcuts", ext?.shortcuts ?? new Map()],
  ];

  const parts: string[] = [];
  for (const [cat, map] of cats) {
    const want = presentRequired(expected[cat], platform);
    const wantAbsent = absentRequired(expected[cat], platform);
    const wantSet = new Set(want);
    const actual = [...map.keys()];

    // Missing: expected-present but not registered.
    for (const key of want) {
      if (!map.has(key)) failures.push(`missing ${cat}:${key}`);
    }
    // Extra: registered but not in the platform-resolved expected set. This also
    // catches a `piOnly`/`ompOnly` member registered on the wrong host.
    for (const key of actual) {
      if (!wantSet.has(key)) failures.push(`unexpected ${cat}:${key}`);
    }

    if (want.length > 0 || wantAbsent.length > 0) {
      const shown = [...want, ...wantAbsent.map((k) => `!${k}`)];
      parts.push(`${cat}[${shown.join(",")}]`);
    }
  }

  // Providers are not exposed by the loader; the captured set (from the stub) must
  // EQUAL the expected providers exactly — extra/rogue providers fail too.
  const wantProviders = expected.providers ?? [];
  const wantProviderSet = new Set(wantProviders);
  for (const p of wantProviders) {
    if (!providers.includes(p)) failures.push(`missing provider:${p}`);
  }
  for (const p of providers) {
    if (!wantProviderSet.has(p)) failures.push(`unexpected provider:${p}`);
  }
  if (wantProviders.length > 0) parts.push(`providers[${wantProviders.join(",")}]`);

  return { pass: failures.length === 0, failures, summary: parts.join(" ") };
}

// ── Op absence ───────────────────────────────────────────────────────────────

export function opIsAbsent(): boolean {
  try {
    const found = execSync("command -v op", { shell: "/bin/sh", encoding: "utf8" }).trim();
    return found === "";
  } catch {
    return true; // non-zero exit ⇒ not found ⇒ absent
  }
}

// ── Harness runner ───────────────────────────────────────────────────────────

export interface RunOptions {
  platform: Platform;
  repoRoot: string;
  cwd: string;
  summaryPrefix: string;
  /** Extra key=value fields to append to the summary line (e.g. omp-version). */
  extra?: Record<string, string>;
  loadExtensions: (paths: string[], cwd: string) => Promise<LoadResult>;
  /** Import the module at `absPath` and capture its registered providers. */
  invokeFactory: (absPath: string) => Promise<string[]>;
}

function matchExt(exts: LoadedExt[], dir: string): LoadedExt | undefined {
  const needle = `/packages/${dir}/`;
  return exts.find((e) => (e.resolvedPath ?? e.path ?? "").includes(needle));
}

/**
 * Run the harness for one host. Prints per-package PASS/FAIL lines, the skip log,
 * and a machine-checkable summary line. Returns the process exit code.
 */
export async function runHarness(opts: RunOptions): Promise<number> {
  const { platform, repoRoot, cwd, summaryPrefix } = opts;
  console.log(`== ${platform} cross-platform validation (op absent) ==`);

  if (!opIsAbsent()) {
    console.error(`FAIL: op is present — this environment must be op-less for ${platform}`);
    return 1;
  }
  console.log("op ABSENT (good)");

  const { inScope, skipped } = discoverPackages(repoRoot);
  for (const s of skipped) {
    console.log(`SKIP: packages/${s.dir} (${s.name}) — ${s.reason}`);
  }

  const allPaths = inScope.flatMap((p) => p.paths);
  const result = await opts.loadExtensions(allPaths, cwd);
  if (result.errors.length > 0) {
    for (const e of result.errors) {
      console.error(
        `  load error: ${e.path}: ${String(e.error).replace(/\s+/g, " ").slice(0, 200)}`,
      );
    }
  }

  let pass = 0;
  let fail = 0;

  for (const pkg of inScope) {
    const expected = EXPECTED[pkg.dir];
    const ext = matchExt(result.extensions, pkg.dir);

    // Workspace-copy guard: a loaded ext MUST come from this repo's packages dir
    // (proves the branch/workspace code loaded, not an npm-published copy).
    if (ext) {
      const rp = realpathSync(ext.resolvedPath ?? (ext.path as string));
      if (!rp.includes(`/packages/${pkg.dir}/`)) {
        console.log(`FAIL ${platform} ${pkg.dir}: loaded from non-workspace path ${rp}`);
        fail++;
        continue;
      }
    }

    let providers: string[] = [];
    if (expected?.providers) {
      try {
        for (const p of pkg.paths) {
          providers = providers.concat(await opts.invokeFactory(p));
        }
      } catch (err) {
        console.log(
          `FAIL ${platform} ${pkg.dir}: provider capture threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        fail++;
        continue;
      }
    }

    const evalResult = evaluatePackage(platform, expected, ext, providers);
    if (evalResult.pass) {
      console.log(`PASS ${platform} ${pkg.dir}: ${evalResult.summary}`);
      pass++;
    } else {
      console.log(`FAIL ${platform} ${pkg.dir}: ${evalResult.failures.join("; ")}`);
      fail++;
    }
  }

  const extra = opts.extra
    ? ` ${Object.entries(opts.extra)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`
    : "";
  console.log(
    `${summaryPrefix} platform=${platform}${extra} packages=${inScope.length} pass=${pass} fail=${fail} skipped=${skipped.length}`,
  );
  const ok = fail === 0;
  console.log(`RESULT: ${ok ? "PASS" : "FAILED"}`);
  return ok ? 0 : 1;
}
