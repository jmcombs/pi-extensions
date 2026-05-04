#!/usr/bin/env node
/**
 * sync-versions.mjs — Validate that every published package follows the pi-extensions
 * conventions documented in CONTRIBUTING.md.
 *
 * Because Release Please uses release-type: "node" for each package, the canonical
 * version source is each package's own `package.json`. This script does not rewrite
 * versions; it validates the shape of each package so issues fail fast in CI before
 * a release PR is opened.
 *
 * Usage:
 *   node scripts/sync-versions.mjs           # validate (run mode)
 *   node scripts/sync-versions.mjs --check   # validate (check mode, identical here)
 *
 * Behavior:
 *   - Discovers every directory under packages/ except `_template/`
 *   - Verifies each package.json has: name, version (semver), description,
 *     license=MIT, author, engines.node (>=22.0.0), the `pi-package` keyword, and a `pi`
 *     manifest with at least one `extensions` entry.
 *   - Verifies the package's name+version is registered in
 *     `.release-please-manifest.json` and `release-please-config.json`.
 *   - Verifies the local source file referenced by `pi.extensions[0]` exists.
 *
 * Exit codes:
 *   0 — all packages pass validation
 *   1 — one or more packages have issues (with details printed)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PACKAGES_DIR = path.join(ROOT, "packages");
const MANIFEST_PATH = path.join(ROOT, ".release-please-manifest.json");
const RP_CONFIG_PATH = path.join(ROOT, "release-please-config.json");

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

// ── Discovery ──────────────────────────────────────────────────────

function discoverPackages() {
  if (!fs.existsSync(PACKAGES_DIR)) return [];
  return fs
    .readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "_template")
    .map((d) => d.name)
    .sort();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function readJsonOrNull(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

// ── Validation ─────────────────────────────────────────────────────

function validatePackage(pkgName, manifest, rpConfig) {
  const issues = [];
  const dir = path.join(PACKAGES_DIR, pkgName);
  const pkgJsonPath = path.join(dir, "package.json");
  const relKey = `packages/${pkgName}`;

  if (!fs.existsSync(pkgJsonPath)) {
    issues.push(`missing package.json`);
    return { name: pkgName, issues };
  }

  let pkg;
  try {
    pkg = readJson(pkgJsonPath);
  } catch (err) {
    issues.push(`package.json is not valid JSON: ${err.message}`);
    return { name: pkgName, issues };
  }

  // Required scalar fields
  if (!pkg.name || typeof pkg.name !== "string") issues.push("name missing or not a string");
  if (!pkg.version || !SEMVER_RE.test(pkg.version))
    issues.push(`version missing or not semver (got ${JSON.stringify(pkg.version)})`);
  if (!pkg.description) issues.push("description missing");
  if (pkg.license !== "MIT") issues.push(`license must be "MIT" (got ${JSON.stringify(pkg.license)})`);
  if (!pkg.author) issues.push("author missing");

  // Engines — Node >=22 is the project floor (Node 20 dropped after secretlint 12.x
  // raised its engines and Node 24 LTS became the publish runtime).
  const node = pkg.engines?.node;
  if (!node) issues.push("engines.node missing");
  else if (!/>=\s*(2[2-9]|[3-9][0-9])(\.|$|\s)/.test(node))
    issues.push(`engines.node should require >=22.0.0 (got ${JSON.stringify(node)})`);

  // Keywords + pi-package
  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords : [];
  if (!keywords.includes("pi-package"))
    issues.push('keywords must include "pi-package" (required for the pi.dev gallery)');

  // pi manifest
  if (!pkg.pi || typeof pkg.pi !== "object") {
    issues.push("pi manifest missing (expected `pi.extensions`)");
  } else {
    const exts = pkg.pi.extensions;
    if (!Array.isArray(exts) || exts.length === 0)
      issues.push("pi.extensions must be a non-empty array");
    else {
      for (const ext of exts) {
        if (typeof ext !== "string") {
          issues.push(`pi.extensions entry not a string: ${JSON.stringify(ext)}`);
          continue;
        }
        // Skip glob patterns and node_modules paths; only verify literal local paths
        if (ext.includes("*") || ext.startsWith("node_modules/")) continue;
        const resolved = path.join(dir, ext);
        if (!fs.existsSync(resolved))
          issues.push(`pi.extensions entry "${ext}" does not exist on disk`);
      }
    }
  }

  // Release Please registration
  if (manifest && pkg.version && manifest[relKey] !== pkg.version) {
    if (manifest[relKey] === undefined)
      issues.push(`not registered in .release-please-manifest.json (expected key "${relKey}")`);
    else
      issues.push(
        `.release-please-manifest.json["${relKey}"] = ${manifest[relKey]} but package.json version = ${pkg.version}`,
      );
  }
  if (rpConfig && !rpConfig.packages?.[relKey])
    issues.push(`not registered in release-please-config.json under packages["${relKey}"]`);

  return { name: pkgName, issues, version: pkg.version };
}

// ── Main ───────────────────────────────────────────────────────────

const packages = discoverPackages();
const manifest = readJsonOrNull(MANIFEST_PATH);
const rpConfig = readJsonOrNull(RP_CONFIG_PATH);

if (manifest === null) {
  console.error(`Error: cannot read ${path.relative(ROOT, MANIFEST_PATH)}`);
  process.exit(1);
}
if (rpConfig === null) {
  console.error(`Error: cannot read ${path.relative(ROOT, RP_CONFIG_PATH)}`);
  process.exit(1);
}

if (packages.length === 0) {
  console.log("No packages found under packages/ (excluding _template). Nothing to validate.");
  process.exit(0);
}

let hasErrors = false;
for (const pkgName of packages) {
  const relKey = `packages/${pkgName}`;
  const registered =
    manifest[relKey] !== undefined && rpConfig.packages?.[relKey] !== undefined;

  // Only fully validate packages registered with Release Please. Unregistered
  // packages are treated as in-development scratch work — they don't gate CI,
  // but they're flagged so it's obvious they haven't been promoted to release.
  if (!registered) {
    console.log(`  · ${pkgName} (in development; not yet registered with Release Please — skipped)`);
    continue;
  }

  const result = validatePackage(pkgName, manifest, rpConfig);
  const tag = result.version ? `${result.name}@${result.version}` : result.name;
  if (result.issues.length === 0) {
    console.log(`  ✓ ${tag}`);
  } else {
    hasErrors = true;
    console.log(`  ✗ ${tag}`);
    for (const issue of result.issues) console.log(`      - ${issue}`);
  }
}

// Also flag any manifest keys that point to packages no longer on disk
for (const key of Object.keys(manifest)) {
  if (!key.startsWith("packages/")) continue;
  const pkgName = key.slice("packages/".length);
  if (!packages.includes(pkgName)) {
    hasErrors = true;
    console.log(
      `  ✗ ${key} listed in .release-please-manifest.json but no such package exists`,
    );
  }
}

if (hasErrors) process.exit(1);
