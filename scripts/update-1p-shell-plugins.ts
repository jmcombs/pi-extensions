#!/usr/bin/env tsx
/**
 * Generator for 1Password Shell Plugins curated list.
 *
 * Fetches the official list from 1Password's documentation (via llms.txt + .md files)
 * and extracts the environment variables each plugin injects.
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

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const LLMS_TXT_URL = "https://www.1password.dev/llms.txt";
const BASE_URL = "https://www.1password.dev";

const isCheckMode = process.argv.includes("--check") || process.argv.includes("-c");

interface ShellPlugin {
  name: string;
  slug: string;
  envVars: string[];
  primaryEnvVar: string | null;
  pageUrl: string;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * Extract shell plugin entries from llms.txt
 */
function extractShellPluginsFromLlmsTxt(
  content: string,
): Array<{ name: string; slug: string; mdUrl: string }> {
  const lines = content.split("\n");
  const plugins: Array<{ name: string; slug: string; mdUrl: string }> = [];

  for (const line of lines) {
    const match = line.match(
      /\]\((https:\/\/www\.1password\.dev\/cli\/shell-plugins\/([^/]+)\.md)\)/,
    );
    if (match) {
      const mdUrl = match[1];
      const slug = match[2];

      // Skip non-plugin pages
      const skip = [
        "contribute",
        "environments",
        "multiple-accounts",
        "security",
        "test",
        "troubleshooting",
        "uninstall",
        "nix",
      ];
      if (skip.includes(slug)) continue;

      plugins.push({ name: "", slug, mdUrl }); // name filled later from H1
    }
  }

  // Deduplicate by slug
  const seen = new Set<string>();
  return plugins.filter((p) => {
    if (seen.has(p.slug)) return false;
    seen.add(p.slug);
    return true;
  });
}

/**
 * Extract a clean display name from the Markdown H1.
 */
function extractDisplayName(markdown: string, fallbackSlug: string): string {
  const h1Match = markdown.match(/^#\s+(.+)$/m);
  if (h1Match) {
    let title = h1Match[1].trim();
    // Common patterns: "Use 1Password to securely authenticate the GitHub CLI"
    title = title.replace(/^Use 1Password to (?:securely )?authenticate (?:the )?/i, "");
    title = title.replace(/\s+CLI$/i, "");
    title = title.replace(/\s+with biometrics$/i, "");
    if (title.length > 2) return title.trim();
  }
  // Fallbacks
  const slugToName: Record<string, string> = {
    homebrew: "Homebrew",
    yugabytedb: "YugabyteDB",
  };
  return (
    slugToName[fallbackSlug] ||
    fallbackSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/**
 * Parse the Reference table at the bottom of a plugin .md file.
 * Returns the list of environment variables mentioned.
 */
function parseReferenceTable(markdown: string): string[] {
  const envVars = new Set<string>();

  // Find the "Reference" section (case insensitive)
  const refMatch = markdown.match(/##\s*Reference\s*\n([\s\S]*?)(?:\n##\s|\n<h2|$)/i);
  if (!refMatch) return [];

  const tableSection = refMatch[1];

  // Match markdown table rows that contain backticked env var names
  // Typical row: | Token | `GH_TOKEN` |
  const rowRegex = /^\s*\|\s*[^|]+\s*\|\s*`([^`]+)`\s*\|/gm;

  let match;
  while ((match = rowRegex.exec(tableSection)) !== null) {
    const varName = match[1].trim();
    if (varName && /^[A-Z0-9_]+$/.test(varName)) {
      envVars.add(varName);
    }
  }

  return Array.from(envVars).sort();
}

async function main() {
  console.log("Fetching 1Password documentation index...");
  const llmsTxt = await fetchText(LLMS_TXT_URL);

  console.log("Extracting shell plugin list...");
  const rawPlugins = extractShellPluginsFromLlmsTxt(llmsTxt);
  console.log(`Found ${rawPlugins.length} shell plugins.`);

  const results: ShellPlugin[] = [];

  for (const plugin of rawPlugins) {
    try {
      const md = await fetchText(plugin.mdUrl);

      const displayName = extractDisplayName(md, plugin.slug);
      const envVars = parseReferenceTable(md);

      // Improved primary env var heuristic
      let primary: string | null = null;
      if (envVars.length > 0) {
        // Prefer common credential patterns
        primary =
          envVars.find(
            (v) =>
              /TOKEN|KEY|SECRET|PASSWORD|AUTH/i.test(v) &&
              !/_(HOST|REGION|PROFILE|SERVER|URL)$/i.test(v),
          ) ||
          envVars.find((v) => !/_(HOST|REGION|PROFILE|SERVER|URL)$/i.test(v)) ||
          envVars[0];
      }

      results.push({
        name: displayName,
        slug: plugin.slug,
        envVars,
        primaryEnvVar: primary,
        pageUrl: plugin.mdUrl.replace(".md", "/"),
      });

      console.log(
        `  ✓ ${displayName} (${envVars.length} env var${envVars.length === 1 ? "" : "s"})`,
      );

      // Be polite
      await new Promise((r) => setTimeout(r, 120));
    } catch (err) {
      console.warn(`    ✗ Failed to process ${plugin.slug}:`, err);
    }
  }

  // Sort alphabetically by name
  results.sort((a, b) => a.name.localeCompare(b.name));

  const outputDir = "packages/1password/data";
  const outputPath = `${outputDir}/shell-plugins.json`;

  if (isCheckMode) {
    await runCheckMode(results, outputPath);
  } else {
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, JSON.stringify(results, null, 2) + "\n", "utf8");

    console.log(`\n✅ Wrote ${results.length} plugins to ${outputPath}`);
    console.log(`   Example: ${results[0]?.name} → ${results[0]?.primaryEnvVar}`);
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

  const diff = computeDiff(existingList, freshList);

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    console.log("✅ No changes detected. List is up to date.");
    process.exit(0);
  }

  console.log("\n🔍 Changes detected:\n");

  if (diff.added.length > 0) {
    console.log(`➕ Added (${diff.added.length}):`);
    diff.added.forEach((p) =>
      console.log(`   • ${p.name} (${p.slug}) — ${p.primaryEnvVar ?? "no primary env var"}`),
    );
  }

  if (diff.removed.length > 0) {
    console.log(`\n➖ Removed (${diff.removed.length}):`);
    diff.removed.forEach((p) => console.log(`   • ${p.name} (${p.slug})`));
  }

  if (diff.changed.length > 0) {
    console.log(`\n✏️  Changed (${diff.changed.length}):`);
    diff.changed.forEach((c) => {
      console.log(`   • ${c.slug}`);
      c.changes.forEach((change) => console.log(`     - ${change}`));
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
    if (!newMap.has(slug)) {
      removed.push(oldPlugin);
      continue;
    }

    const newPlugin = newMap.get(slug)!;
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
  console.error(err);
  process.exit(1);
});
