/**
 * Host-compatibility exception list.
 *
 * extension-host-exceptions.json is the only source of truth. A package that is
 * absent is compatible with both hosts. The load harness and check:host-compat
 * both import this module. Do not keep a second list.
 */

import fs from "node:fs";
import path from "node:path";

export const HOSTS = ["pi", "oh-my-pi"];
export const EXCEPTION_FILE = "extension-host-exceptions.json";
export const REJECTED_EXCEPTION_DIRS = ["_template", "agent-files"];
const ENTRY_KEYS = ["package", "incompatible", "reason"];
const TOP_KEYS = ["hosts", "exceptions"];
const MARK_OK = "\u2713";
const MARK_NO = "\u2717";

/**
 * @typedef {{ package: string, incompatible: string[], reason: string }} HostException
 * @typedef {{ dir: string, name: string, paths?: readonly string[] }} HostPackage
 * @typedef {{ ok: true, exceptions: HostException[] } | { ok: false, errors: string[] }} HostCompatResult
 */

/**
 * @param {unknown} value
 * @returns {HostCompatResult}
 */
export function parseHostCompat(value) {
  const errors = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["extension-host-exceptions.json must be an object"] };
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(record)) {
    if (!TOP_KEYS.includes(key)) errors.push(`unknown top-level key ${JSON.stringify(key)}`);
  }
  const hosts = record.hosts;
  if (
    !Array.isArray(hosts) ||
    hosts.length !== HOSTS.length ||
    hosts.some((host, i) => host !== HOSTS[i])
  ) {
    errors.push('hosts must equal ["pi", "oh-my-pi"] exactly, in that order');
  }
  if (!Array.isArray(record.exceptions)) {
    errors.push("exceptions must be an array");
    return { ok: false, errors };
  }
  /** @type {HostException[]} */
  const exceptions = [];
  const seen = new Set();
  for (const [index, entry] of record.exceptions.entries()) {
    errors.push(...entryErrors(entry, index, seen, exceptions));
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, exceptions };
}

/**
 * @param {unknown} entry
 * @param {number} index
 * @param {Set<string>} seen
 * @param {HostException[]} exceptions
 * @returns {string[]}
 */
function entryErrors(entry, index, seen, exceptions) {
  const where = `exceptions[${index}]`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return [`${where} must be an object`];
  }
  const record = /** @type {Record<string, unknown>} */ (entry);
  const errors = [];
  for (const key of Object.keys(record)) {
    if (!ENTRY_KEYS.includes(key)) errors.push(`${where} has unknown key ${JSON.stringify(key)}`);
  }
  const packageDir = record.package;
  if (
    typeof packageDir !== "string" ||
    packageDir.length === 0 ||
    packageDir.includes("/") ||
    packageDir.includes("\\")
  ) {
    errors.push(`${where}.package must be a packages/ directory name`);
    return errors;
  }
  if (seen.has(packageDir))
    errors.push(`${where} duplicates package ${JSON.stringify(packageDir)}`);
  seen.add(packageDir);
  const incompatible = record.incompatible;
  if (
    !Array.isArray(incompatible) ||
    incompatible.length !== 1 ||
    !HOSTS.includes(String(incompatible[0]))
  ) {
    errors.push(
      `${where}.incompatible must name exactly one of "pi" or "oh-my-pi" (both hosts is rejected)`,
    );
    return errors;
  }
  const host = String(incompatible[0]);
  const reason = record.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    errors.push(`${where}.reason is required`);
    return errors;
  }
  if (!reasonNamesHost(reason, host)) {
    errors.push(`${where}.reason must name the incompatible host ${JSON.stringify(host)}`);
  }
  exceptions.push({ package: packageDir, incompatible: [host], reason });
  return errors;
}

/**
 * @param {string} reason
 * @param {string} host
 * @returns {boolean}
 */
function reasonNamesHost(reason, host) {
  if (host === "oh-my-pi") return reason.includes("oh-my-pi");
  const withoutOmp = reason.split("oh-my-pi").join(" ");
  return /(?:^|[^A-Za-z0-9])pi(?:[^A-Za-z0-9]|$)/.test(withoutOmp);
}

/**
 * @param {string} repoRoot
 * @returns {HostCompatResult}
 */
export function loadHostCompat(repoRoot) {
  const filePath = path.join(repoRoot, EXCEPTION_FILE);
  if (!fs.existsSync(filePath)) {
    return { ok: false, errors: [`${EXCEPTION_FILE} is missing`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`${EXCEPTION_FILE} is not valid JSON: ${message}`] };
  }
  const schema = parseHostCompat(parsed);
  if (!schema.ok) return schema;
  const errors = schema.exceptions.flatMap((entry) => packageErrors(repoRoot, entry.package));
  if (errors.length > 0) return { ok: false, errors };
  return schema;
}

/**
 * @param {string} repoRoot
 * @param {string} packageDir
 * @returns {string[]}
 */
function packageErrors(repoRoot, packageDir) {
  if (REJECTED_EXCEPTION_DIRS.includes(packageDir)) {
    return [`exception names ${packageDir}, which cannot be a host exception`];
  }
  const dir = path.join(repoRoot, "packages", packageDir);
  const packageJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return [`unknown package ${JSON.stringify(packageDir)}`];
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [`packages/${packageDir}/package.json is not valid JSON: ${message}`];
  }
  const errors = [];
  if (pkg.private === true) {
    errors.push(`exception names private package ${packageDir}`);
  }
  const extensions = pkg.pi?.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0) {
    errors.push(`exception names ${packageDir}, which has no pi.extensions`);
  }
  return errors;
}

/**
 * @param {readonly HostPackage[]} packages
 * @param {string} host
 * @param {readonly HostException[]} exceptions
 * @returns {{ run: HostPackage[], hostSkipped: Array<HostPackage & { host: string, reason: string }> }}
 */
export function partitionForHost(packages, host, exceptions) {
  if (!HOSTS.includes(host)) {
    throw new Error(`unknown host ${JSON.stringify(host)}`);
  }
  /** @type {HostPackage[]} */
  const run = [];
  /** @type {Array<HostPackage & { host: string, reason: string }>} */
  const hostSkipped = [];
  for (const pkg of packages) {
    const entry = exceptions.find((candidate) => candidate.package === pkg.dir);
    const incompatible = entry?.incompatible[0];
    if (entry !== undefined && incompatible === host) {
      hostSkipped.push({ ...pkg, host, reason: entry.reason });
    } else {
      run.push(pkg);
    }
  }
  return { run, hostSkipped };
}

/**
 * @param {readonly unknown[]} run
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateHostRun(run) {
  if (run.length === 0) {
    return { ok: false, error: "no in-scope package left to validate on this host" };
  }
  return { ok: true };
}

/**
 * @param {string} packageDir
 * @param {readonly HostException[]} exceptions
 * @returns {string}
 */
export function hostMarkerLine(packageDir, exceptions) {
  const incompatible = exceptions.find((entry) => entry.package === packageDir)?.incompatible[0];
  const pi = incompatible === "pi" ? MARK_NO : MARK_OK;
  const omp = incompatible === "oh-my-pi" ? MARK_NO : MARK_OK;
  return `**Hosts:** pi ${pi} · oh-my-pi ${omp}`;
}

/**
 * @param {string} text
 * @param {string} expectedLine
 * @returns {string[]}
 */
export function readmeMarkerErrors(text, expectedLine) {
  const errors = [];
  const hostsCount = text.split("**Hosts:**").length - 1;
  if (hostsCount !== 1) errors.push(`**Hosts:** appears ${hostsCount} times; expected 1`);
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let h1 = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^# [^#]/.test(line)) {
      h1 = i;
      break;
    }
  }
  if (h1 < 0) return [...errors, "no ATX H1 outside a code fence"];
  if (lines[h1 + 1] !== "") errors.push("the line after the H1 must be blank");
  if (lines[h1 + 2] !== expectedLine) {
    errors.push(`host marker must be ${JSON.stringify(expectedLine)}`);
  }
  if (lines[h1 + 3] !== "") errors.push("the line after the host marker must be blank");
  return errors;
}

/**
 * @param {string} row
 * @returns {string[]}
 */
export function tableCells(row) {
  return row
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/**
 * @param {string} npmName
 * @param {string} packageDir
 * @param {readonly HostException[]} exceptions
 * @param {boolean} library
 * @returns {string[]}
 */
export function rootHostCells(npmName, packageDir, exceptions, library) {
  const incompatible = exceptions.find((entry) => entry.package === packageDir)?.incompatible[0];
  const pi = incompatible === "pi" ? MARK_NO : MARK_OK;
  const omp = incompatible === "oh-my-pi" ? MARK_NO : MARK_OK;
  const label = library ? `\`${npmName}\` (library)` : `\`${npmName}\``;
  return [label, pi, omp];
}

/**
 * @param {string} readmeText
 * @param {readonly (readonly string[])[]} expectedRows
 * @returns {string[]}
 */
export function rootTableErrors(readmeText, expectedRows) {
  const lines = readmeText.split(/\r?\n/);
  const start = lines.indexOf("## Host compatibility");
  if (start < 0) return ["root README is missing the ## Host compatibility section"];
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => line.startsWith("## "));
  const section = next < 0 ? rest : rest.slice(0, next);
  const table = section.filter((line) => line.startsWith("|"));
  const [header, , ...rows] = table;
  const errors = [];
  const headerCells = header === undefined ? [] : tableCells(header);
  if (headerCells.join("|") !== "Package|pi|oh-my-pi") {
    errors.push("host table header must be Package, pi, oh-my-pi");
  }
  if (rows.length !== expectedRows.length) {
    errors.push(`host table has ${rows.length} package rows; expected ${expectedRows.length}`);
  }
  const limit = Math.max(rows.length, expectedRows.length);
  for (let i = 0; i < limit; i += 1) {
    const actual = rows[i] === undefined ? [] : tableCells(rows[i] ?? "");
    const expected = expectedRows[i] ?? [];
    if (actual.join("|") !== expected.join("|")) {
      errors.push(`host table row ${i + 1} must be ${JSON.stringify(expected.join(" | "))}`);
    }
  }
  return errors;
}
