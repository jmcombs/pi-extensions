#!/usr/bin/env node
/**
 * typecheck.mjs — Run `tsc --noEmit` only when there's at least one .ts file
 * to check. TypeScript errors out with TS18003 when given an empty input set
 * (which happens between packages being added/removed and during early repo
 * setup). This wrapper makes the script a no-op in that case so `npm run check`
 * stays green.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PACKAGES_DIR = path.join(ROOT, "packages");

function hasTypeScriptSources(dir) {
  if (!fs.existsSync(dir)) return false;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      // Skip _-prefixed dirs (matches our _template/ exclusion convention)
      if (entry.isDirectory() && entry.name.startsWith("_")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) return true;
    }
  }
  return false;
}

if (!hasTypeScriptSources(PACKAGES_DIR)) {
  console.log("No TypeScript sources under packages/. Skipping typecheck.");
  process.exit(0);
}

const result = spawnSync("npx", ["--no", "--", "tsc", "--noEmit"], {
  stdio: "inherit",
  cwd: ROOT,
});
process.exit(result.status ?? 1);
