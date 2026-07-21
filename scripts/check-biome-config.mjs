#!/usr/bin/env node
/**
 * check-biome-config.mjs — Fail if biome.jsonc needs migration.
 *
 * Biome bumps its $schema URL version tag and deprecates config fields on
 * every minor release. Dependabot bumps @biomejs/biome but never touches
 * biome.jsonc, so the config drifts silently until biome escalates the
 * notice from info to error. This gate surfaces the drift immediately on
 * the same PR that bumps biome.
 */

import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["biome", "migrate"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

if (output.includes("needs migration")) {
  process.stdout.write(output);
  process.stderr.write("\nbiome.jsonc is out of date. Run: npm run migrate:biome\n");
  process.exit(1);
}

process.exit(result.status ?? 0);
