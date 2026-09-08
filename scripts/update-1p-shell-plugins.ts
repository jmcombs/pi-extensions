#!/usr/bin/env tsx
/**
 * Generator for 1Password Shell Plugins curated list.
 *
 * The upstream open-source plugin repo (1Password/shell-plugins) is the single
 * source of truth — the documentation site is never consulted. The `op` CLI vendors
 * this same repo and the docs are generated downstream of it, so parsing it directly
 * avoids breaking every time the docs are reorganised, and picks up env vars the docs
 * cannot express (custom provisioners never appear in the docs' Reference tables).
 *
 * `pageUrl` therefore points at each plugin's source directory, which stays valid
 * regardless of how the docs site keys or renames its pages.
 *
 * Output: packages/1password/data/shell-plugins.json
 *
 * Run manually (update mode):
 *   npx tsx scripts/update-1p-shell-plugins.ts
 *
 * Run in dry-run / check mode (used by CI to decide whether a PR is needed):
 *   npx tsx scripts/update-1p-shell-plugins.ts --check
 *
 * This script is also intended to be called from CI on a weekly schedule.
 */

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { extractEnvVars, pickPrimaryEnvVar } from "./1p-shell-plugins-extract.js";

const TARBALL_URL = "https://codeload.github.com/1Password/shell-plugins/tar.gz/refs/heads/main";
const SOURCE_TREE_URL = "https://github.com/1Password/shell-plugins/tree/main/plugins";

/**
 * Refuse to write a list that has collapsed. The docs-scraping predecessor silently
 * produced an empty array when its source moved, which nearly landed a PR deleting
 * every entry. A parse that finds nothing is a broken parse, not an empty upstream.
 */
const MIN_PLUGINS = 40;
const MAX_SHRINK_RATIO = 0.1;

const isCheckMode = process.argv.includes("--check") || process.argv.includes("-c");

interface ShellPlugin {
  name: string;
  slug: string;
  envVars: string[];
  primaryEnvVar: string | null;
  pageUrl: string;
}

// ── Tarball retrieval ─────────────────────────────────────────────────

/**
 * Minimal POSIX tar reader. The archive is ~123 KB and we need five fields from
 * the header, so a full tar dependency would cost more than it saves.
 */
function readTar(buf: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  const BLOCK = 512;

  for (let offset = 0; offset + BLOCK <= buf.length; ) {
    const header = buf.subarray(offset, offset + BLOCK);

    // Two consecutive zero blocks mark end-of-archive.
    if (header.every((b) => b === 0)) break;

    const readStr = (start: number, len: number) =>
      header
        .subarray(start, start + len)
        .toString("utf8")
        .replace(/\0.*$/, "")
        .trim();

    const name = readStr(0, 100);
    const sizeOctal = readStr(124, 12);
    const typeFlag = String.fromCharCode(header[136 + 20]);
    const prefix = readStr(345, 155);

    const size = Number.parseInt(sizeOctal, 8) || 0;
    const fullName = prefix ? `${prefix}/${name}` : name;

    offset += BLOCK;

    // '0' and NUL both denote a regular file; skip dirs, symlinks, PAX headers.
    if (typeFlag === "0" || typeFlag === "\0") {
      if (fullName.endsWith(".go")) {
        files.set(fullName, buf.subarray(offset, offset + size).toString("utf8"));
      }
    }

    offset += Math.ceil(size / BLOCK) * BLOCK;
  }

  return files;
}

async function fetchPluginSources(): Promise<Map<string, string>> {
  const res = await fetch(TARBALL_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${TARBALL_URL}: ${res.status} ${res.statusText}`);
  }
  const gz = Buffer.from(await res.arrayBuffer());
  return readTar(gunzipSync(gz));
}

// ── Go source extraction ──────────────────────────────────────────────

/** Pull a quoted Go string literal for a given struct field, e.g. `Name: "aws"`. */
function matchField(src: string, field: string): string | null {
  const m = src.match(new RegExp(`\\b${field}:\\s*"([^"]+)"`));
  return m ? m[1] : null;
}

async function main() {
  console.log("Fetching 1Password shell-plugins source archive...");
  const files = await fetchPluginSources();

  // Group every non-test .go file under plugins/<slug>/.
  const byPlugin = new Map<string, Array<[string, string]>>();
  for (const [path, content] of files) {
    const m = path.match(/(?:^|\/)plugins\/([^/]+)\/([^/]+\.go)$/);
    if (!m || m[2].endsWith("_test.go")) continue;
    const bucket = byPlugin.get(m[1]);
    if (bucket) bucket.push([m[2], content]);
    else byPlugin.set(m[1], [[m[2], content]]);
  }

  console.log(`Found ${byPlugin.size} plugin directories.`);

  const results: ShellPlugin[] = [];

  for (const [slug, sources] of byPlugin) {
    const pluginGo = sources.find(([f]) => f === "plugin.go")?.[1];
    if (!pluginGo) {
      console.warn(`    ✗ ${slug}: no plugin.go, skipping`);
      continue;
    }

    // Platform.Name is the human-facing display name; Plugin.Name is the slug,
    // which is always identical to the plugin's directory name.
    const platformName = pluginGo.match(/PlatformInfo\{[\s\S]*?\bName:\s*"([^"]+)"/)?.[1];
    const envVars = extractEnvVars(sources);

    results.push({
      name: platformName ?? matchField(pluginGo, "Name") ?? slug,
      slug,
      envVars,
      primaryEnvVar: pickPrimaryEnvVar(envVars),
      pageUrl: `${SOURCE_TREE_URL}/${slug}`,
    });
  }

  assertHealthyParse(results.length);
  results.sort((a, b) => a.name.localeCompare(b.name));

  const withVars = results.filter((p) => p.envVars.length > 0).length;
  console.log(`Parsed ${results.length} plugins (${withVars} with env vars).`);

  const outputDir = "packages/1password/data";
  const outputPath = `${outputDir}/shell-plugins.json`;

  if (isCheckMode) {
    await runCheckMode(results, outputPath);
  } else {
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    formatOutput(outputPath);

    console.log(`\n✅ Wrote ${results.length} plugins to ${outputPath}`);
    console.log(`   Example: ${results[0]?.name} → ${results[0]?.primaryEnvVar}`);
  }
}

/**
 * Hand the written file to Biome.
 *
 * `JSON.stringify` puts every array element on its own line; Biome collapses short
 * arrays onto one. Without this the generated data fails `biome check`, which is a
 * required status check — so the automated PR could never merge. Running the repo's
 * own formatter is more robust than trying to reproduce its line-width rules here.
 */
function formatOutput(outputPath: string): void {
  execFileSync("npx", ["biome", "format", "--write", outputPath], { stdio: "inherit" });
}

/**
 * Guard against a silently-broken parse. Throwing here fails the workflow loudly
 * instead of letting an empty or gutted list reach a pull request.
 */
function assertHealthyParse(freshCount: number): void {
  if (freshCount < MIN_PLUGINS) {
    throw new Error(
      `Parsed only ${freshCount} plugins (expected at least ${MIN_PLUGINS}). ` +
        `The upstream layout has likely changed — refusing to write a gutted list.`,
    );
  }
}

async function assertNoCollapse(freshCount: number, outputPath: string): Promise<void> {
  let existingCount = 0;
  try {
    existingCount = (JSON.parse(await readFile(outputPath, "utf8")) as ShellPlugin[]).length;
  } catch {
    return; // No baseline to compare against.
  }

  const floor = Math.floor(existingCount * (1 - MAX_SHRINK_RATIO));
  if (freshCount < floor) {
    throw new Error(
      `Plugin count dropped from ${existingCount} to ${freshCount} (below the ${floor} floor). ` +
        `Refusing to write — investigate upstream before regenerating.`,
    );
  }
}

interface DiffResult {
  added: ShellPlugin[];
  removed: ShellPlugin[];
  changed: Array<{ slug: string; changes: string[] }>;
}

async function runCheckMode(freshList: ShellPlugin[], outputPath: string) {
  let existingList: ShellPlugin[] = [];
  try {
    const raw = await readFile(outputPath, "utf8");
    existingList = JSON.parse(raw);
  } catch {
    console.log("No existing list found — this would be the initial creation.");
    console.log(`Detected ${freshList.length} plugins.`);
    process.exit(1); // Changes needed
  }

  await assertNoCollapse(freshList.length, outputPath);

  const diff = computeDiff(existingList, freshList);

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    console.log("✅ No changes detected. List is up to date.");
    process.exit(0);
  }

  console.log("\n🔍 Changes detected:\n");

  if (diff.added.length > 0) {
    console.log(`➕ Added (${diff.added.length}):`);
    diff.added.forEach((p) => {
      console.log(`   • ${p.name} (${p.slug}) — ${p.primaryEnvVar ?? "no primary env var"}`);
    });
  }

  if (diff.removed.length > 0) {
    console.log(`\n➖ Removed (${diff.removed.length}):`);
    diff.removed.forEach((p) => {
      console.log(`   • ${p.name} (${p.slug})`);
    });
  }

  if (diff.changed.length > 0) {
    console.log(`\n✏️  Changed (${diff.changed.length}):`);
    diff.changed.forEach((c) => {
      console.log(`   • ${c.slug}`);
      c.changes.forEach((change) => {
        console.log(`     - ${change}`);
      });
    });
  }

  console.log(`\nTotal plugins in fresh list: ${freshList.length}`);
  process.exit(1); // Signal that an update + PR is needed
}

function computeDiff(oldList: ShellPlugin[], newList: ShellPlugin[]): DiffResult {
  const oldMap = new Map(oldList.map((p) => [p.slug, p]));
  const newMap = new Map(newList.map((p) => [p.slug, p]));

  const added: ShellPlugin[] = [];
  const removed: ShellPlugin[] = [];
  const changed: Array<{ slug: string; changes: string[] }> = [];

  for (const [slug, plugin] of newMap) {
    if (!oldMap.has(slug)) {
      added.push(plugin);
    }
  }

  for (const [slug, oldPlugin] of oldMap) {
    const newPlugin = newMap.get(slug);
    if (newPlugin === undefined) {
      removed.push(oldPlugin);
      continue;
    }

    const changes: string[] = [];

    if (JSON.stringify(oldPlugin.envVars) !== JSON.stringify(newPlugin.envVars)) {
      changes.push(
        `envVars: [${oldPlugin.envVars.join(", ")}] → [${newPlugin.envVars.join(", ")}]`,
      );
    }
    if (oldPlugin.primaryEnvVar !== newPlugin.primaryEnvVar) {
      changes.push(`primaryEnvVar: ${oldPlugin.primaryEnvVar} → ${newPlugin.primaryEnvVar}`);
    }
    if (oldPlugin.name !== newPlugin.name) {
      changes.push(`name: "${oldPlugin.name}" → "${newPlugin.name}"`);
    }

    if (changes.length > 0) {
      changed.push({ slug, changes });
    }
  }

  return { added, removed, changed };
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
