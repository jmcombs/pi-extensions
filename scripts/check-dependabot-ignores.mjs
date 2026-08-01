#!/usr/bin/env node
/**
 * check-dependabot-ignores.mjs — Time-box every Dependabot `ignore` entry.
 *
 * A Dependabot ignore has no natural end. It suppresses a PR silently and
 * indefinitely, so a rule added for a good reason outlives that reason without
 * anyone noticing — the update simply stops being offered. That is the whole
 * failure mode: an ignore is invisible once it works.
 *
 * So each entry must carry an `# expires: YYYY-MM-DD` comment directly above
 * it. Past that date this gate fails, forcing the decision to be made again
 * rather than inherited. An entry with no expiry fails immediately.
 *
 * Dates come from scripts/exception-expiry.mjs so every deliberate exception in
 * the repo surfaces for review on the same day.
 *
 * Parsed with a line scanner rather than a YAML library on purpose: js-yaml is
 * only present transitively, and this file is small and rigidly formatted.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXCEPTIONS_EXPIRE, isExpired } from "./exception-expiry.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CONFIG = path.join(ROOT, ".github/dependabot.yml");

if (!fs.existsSync(CONFIG)) {
  process.stderr.write(`Cannot read ${path.relative(ROOT, CONFIG)}\n`);
  process.exit(1);
}

const lines = fs.readFileSync(CONFIG, "utf-8").split("\n");

// Walk `- dependency-name: "x"` entries, carrying the most recent `# expires:`
// comment. A blank line or a new entry clears it, so a date cannot drift down
// the file and silently vouch for an entry it was never written for.
const entries = [];
let pendingExpiry = null;

for (const [index, line] of lines.entries()) {
  const expiryMatch = line.match(/^\s*#\s*expires:\s*(\d{4}-\d{2}-\d{2})\s*$/);
  if (expiryMatch) {
    pendingExpiry = { date: expiryMatch[1], line: index + 1 };
    continue;
  }

  const nameMatch = line.match(/^\s*-\s*dependency-name:\s*["']?([^"'\s]+)["']?\s*$/);
  if (nameMatch) {
    entries.push({ name: nameMatch[1], line: index + 1, expiry: pendingExpiry });
    pendingExpiry = null;
    continue;
  }

  // Only comments and blank lines may sit between an expiry and its entry.
  if (pendingExpiry && line.trim() !== "" && !line.trim().startsWith("#")) {
    pendingExpiry = null;
  }
}

const problems = [];
for (const entry of entries) {
  const where = `.github/dependabot.yml:${entry.line}`;
  if (!entry.expiry) {
    problems.push(
      `${where}  ${entry.name}\n` +
        `    No expiry. Add "# expires: ${EXCEPTIONS_EXPIRE}" directly above it,\n` +
        `    with a comment explaining why the update is being suppressed.`,
    );
  } else if (entry.expiry.date !== EXCEPTIONS_EXPIRE) {
    // The YAML comment is a readable mirror, not a second source of truth.
    // Without this check, moving EXCEPTIONS_EXPIRE would renew the audit
    // allowlist while leaving this ignore on its old date — the exact silent
    // drift the shared constant exists to prevent.
    problems.push(
      `${where}  ${entry.name}\n` +
        `    Expiry ${entry.expiry.date} does not match EXCEPTIONS_EXPIRE (${EXCEPTIONS_EXPIRE}).\n` +
        `    Every exception shares one review date. Update the comment to match\n` +
        `    scripts/exception-expiry.mjs.`,
    );
  } else if (isExpired(entry.expiry.date)) {
    problems.push(
      `${where}  ${entry.name}\n` +
        `    Expired ${entry.expiry.date}. Re-evaluate: remove the ignore, or renew every\n` +
        `    exception together by moving EXCEPTIONS_EXPIRE in\n` +
        `    scripts/exception-expiry.mjs forward (then update this comment to match).`,
    );
  }
}

if (problems.length) {
  process.stderr.write(
    `\nDependabot ignore entries need attention:\n\n${problems.join("\n\n")}\n\n`,
  );
  process.exit(1);
}

if (entries.length === 0) {
  process.stdout.write("No Dependabot ignore entries.\n");
} else {
  for (const entry of entries) {
    process.stdout.write(`  ignore  ${entry.name}  (expires ${entry.expiry.date})\n`);
  }
}
process.exit(0);
