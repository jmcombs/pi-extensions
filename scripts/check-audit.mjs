#!/usr/bin/env node
/**
 * check-audit.mjs — `npm audit --omit=dev` with a narrow, expiring allowlist.
 *
 * Some advisories are not actionable from this repo. `pi-coding-agent` ships
 * its own npm-shrinkwrap.json, which freezes its dependency subtree: root
 * `overrides` do not reach into it and `npm audit fix` is a no-op. Those
 * advisories clear only when upstream refreshes the shrinkwrap.
 *
 * Left alone, a single unfixable advisory fails the gate on every PR, and a
 * permanently red gate is one nobody reads. This filters the known-unfixable
 * ones and fails on everything else, so a genuinely new advisory still stops
 * the build.
 *
 * Entries expire on purpose. An entry past `expires` fails, and so does one
 * that no longer matches any advisory — an allowlist that silently outlives
 * the problem it documents is how the next real advisory gets waved through.
 */

import { spawnSync } from "node:child_process";
import { isExpired } from "./exception-expiry.mjs";

/** @type {{id: string, package: string, reason: string, expires: string}[]} */
const ALLOWLIST = [];

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (!result.stdout) {
  process.stderr.write(`${result.stderr ?? ""}\nnpm audit produced no output.\n`);
  process.exit(1);
}

/** @type {{vulnerabilities?: Record<string, {via?: unknown[]}>}} */
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stdout.write(result.stdout);
  process.stderr.write("\nCould not parse npm audit JSON.\n");
  process.exit(1);
}

// One advisory can surface under several packages; key by GHSA id to dedupe.
/** @type {Map<string, {id: string, severity: string, title: string, packages: Set<string>}>} */
const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== "object" || via === null) continue;
    const { url, name, severity, title } = /** @type {Record<string, string>} */ (via);
    const id = url?.split("/advisories/")[1];
    if (!id) continue;
    const entry = advisories.get(id) ?? { id, severity, title, packages: new Set() };
    entry.packages.add(name);
    advisories.set(id, entry);
  }
}

const allowed = [];
const blocking = [];

for (const advisory of advisories.values()) {
  const entry = ALLOWLIST.find((a) => a.id === advisory.id);
  if (!entry) {
    blocking.push({ advisory, why: "not allowlisted" });
  } else if (isExpired(entry.expires)) {
    blocking.push({ advisory, why: `allowlist entry expired ${entry.expires}` });
  } else {
    allowed.push({ advisory, entry });
  }
}

const stale = ALLOWLIST.filter((a) => !advisories.has(a.id));

for (const { advisory, entry } of allowed) {
  process.stdout.write(
    `ignored  ${advisory.id}  ${advisory.severity.padEnd(8)} ${[...advisory.packages].join(", ")}\n` +
      `         expires ${entry.expires} — ${entry.reason}\n`,
  );
}

for (const entry of stale) {
  process.stderr.write(
    `\nStale allowlist entry: ${entry.id} (${entry.package}) no longer appears in the audit.\n` +
      `Remove it from ALLOWLIST in scripts/check-audit.mjs.\n`,
  );
}

for (const { advisory, why } of blocking) {
  process.stderr.write(
    `\n${advisory.severity.toUpperCase()}  ${advisory.id}  ${[...advisory.packages].join(", ")}\n` +
      `  ${advisory.title}\n  https://github.com/advisories/${advisory.id}\n  (${why})\n`,
  );
}

if (blocking.length || stale.length) {
  process.stderr.write("\nRun `npm audit --omit=dev` for the full report.\n");
  process.exit(1);
}

process.stdout.write(
  `npm audit --omit=dev: no blocking advisories (${allowed.length} allowlisted).\n`,
);
process.exit(0);
