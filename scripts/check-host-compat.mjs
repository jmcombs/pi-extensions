#!/usr/bin/env node
/**
 * Fail if extension-host-exceptions.json, package README host marks, or the
 * root host table disagree. This does not load extensions.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hostMarkerLine,
  loadHostCompat,
  readmeMarkerErrors,
  rootHostCells,
  rootTableErrors,
} from "./host-compat.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PACKAGES = path.join(ROOT, "packages");

/**
 * @returns {string[]}
 */
function packageDirs() {
  return fs
    .readdirSync(PACKAGES, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && fs.existsSync(path.join(PACKAGES, entry.name, "package.json")),
    )
    .map((entry) => entry.name)
    .sort();
}

/**
 * @param {string} dir
 * @returns {string}
 */
function packageName(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGES, dir, "package.json"), "utf8"));
  return typeof pkg.name === "string" ? pkg.name : dir;
}

const compat = loadHostCompat(ROOT);
/** @type {string[]} */
const errors = compat.ok ? [] : [...compat.errors];

if (compat.ok) {
  const dirs = packageDirs();
  for (const dir of dirs) {
    const readmePath = path.join(PACKAGES, dir, "README.md");
    if (!fs.existsSync(readmePath)) {
      errors.push(`packages/${dir}/README.md is missing`);
      continue;
    }
    const text = fs.readFileSync(readmePath, "utf8");
    const expected = hostMarkerLine(dir, compat.exceptions);
    for (const error of readmeMarkerErrors(text, expected)) {
      errors.push(`packages/${dir}/README.md: ${error}`);
    }
  }
  const rootRows = dirs
    .filter((dir) => dir !== "_template")
    .map((dir) => rootHostCells(packageName(dir), dir, compat.exceptions, dir === "agent-files"));
  const rootReadme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  for (const error of rootTableErrors(rootReadme, rootRows)) errors.push(`README.md: ${error}`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`FAIL: ${error}`);
  process.exit(1);
}

const count = compat.ok ? compat.exceptions.length : 0;
console.log(`host-compat: ${count} exception(s); package README marks match`);
