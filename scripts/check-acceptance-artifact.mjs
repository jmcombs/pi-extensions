#!/usr/bin/env node
/**
 * check-acceptance-artifact.mjs — Verify a contributor's prompt-enhancer
 * acceptance artifact.
 *
 * Run it against a supplied file, not against the repo, so it is deliberately
 * **not** part of `npm run check`:
 *
 *   npm run check:acceptance-artifact -- docs/prompt-enhancer/my-change.json
 *
 * An acceptance artifact is a claim about a paid run that the maintainer did
 * not watch. Reading its summary table proves nothing: the numbers in it are
 * whatever the file says they are. So this script does not read the claim, it
 * **re-derives** it.
 *
 * The load-bearing check is the re-score. Every record carries the `enhanced`
 * text the model actually produced, and every input a verdict is allowed to
 * depend on. Feeding those back through the committed `scoreCall` (which is the
 * runner's own decision ladder, imported rather than reimplemented, so the two
 * cannot drift) reproduces the verdict, the codes and the signals. One pass
 * therefore catches:
 *
 *   - a fabricated artifact — invented `enhanced` text scored as `good` by hand
 *     does not survive being scored by the real classifier;
 *   - a stale artifact — recorded before a classifier change, so its stored
 *     verdicts are the old rules' answers;
 *   - a locally edited harness — a relaxed rule, a widened threshold or a
 *     deleted branch shows up as a record whose stored verdict the committed
 *     code disagrees with.
 *
 * What it cannot catch is stated in acceptance/README.md and is worth knowing
 * before trusting a green run: nothing here proves the calls were ever made.
 * A contributor who runs the real matrix, then hand-edits `enhanced` texts into
 * ones that genuinely score `good`, produces a file that passes. The check
 * proves the *scoring* is honest and current, not the *sampling*.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  BASELINE_MODEL,
  FIXTURE_DIR,
  FIXTURES,
  MAX_MODELS,
  scoreCall,
} from "../packages/prompt-enhancer/acceptance/run-matrix.ts";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** How many examples of one kind of mismatch to print before summarising. */
const MAX_EXAMPLES = 5;

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function note(message) {
  notes.push(message);
}

function out(line = "") {
  process.stdout.write(`${line}\n`);
}

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function finish() {
  out();
  for (const line of notes) out(`note   ${line}`);
  if (problems.length === 0) {
    out();
    out("PASS — the artifact re-scores to what it claims.");
    process.exit(0);
  }
  out();
  out(`FAIL — ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  out();
  for (const problem of problems) out(`  ${problem}`);
  out();
  process.exit(1);
}

const artifactArg = process.argv[2];
if (artifactArg === undefined || artifactArg.startsWith("-")) {
  process.stderr.write(
    "Usage: npm run check:acceptance-artifact -- <artifact.json>\n" +
      "       node scripts/check-acceptance-artifact.mjs <artifact.json>\n\n" +
      "The artifact is the JSON file `run-matrix.ts --out` wrote.\n",
  );
  process.exit(2);
}

const artifactPath = path.resolve(ROOT, artifactArg);
if (!fs.existsSync(artifactPath)) {
  process.stderr.write(`Cannot read ${artifactArg}\n`);
  process.exit(2);
}

let artifact;
try {
  artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
} catch (error) {
  process.stderr.write(`${artifactArg} is not valid JSON: ${error.message}\n`);
  process.exit(2);
}

const relativeArtifact = path.relative(ROOT, artifactPath);
out(`Artifact: ${relativeArtifact.startsWith("..") ? artifactPath : relativeArtifact}`);

// ---------------------------------------------------------------------------
// 1. Shape. Everything below indexes into these, so a malformed header is
//    fatal on its own rather than producing a hundred derived complaints.
// ---------------------------------------------------------------------------

if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
  process.stderr.write("Artifact is not a JSON object.\n");
  process.exit(1);
}

const models = artifact.models;
const fixtures = artifact.fixtures;
const n = artifact.n;
const records = artifact.records;

const shapeErrors = [];
if (!Array.isArray(models) || models.length === 0 || models.some((m) => typeof m !== "string")) {
  shapeErrors.push("`models` must be a non-empty array of cell keys");
}
if (
  !Array.isArray(fixtures) ||
  fixtures.length === 0 ||
  fixtures.some((f) => typeof f !== "string")
) {
  shapeErrors.push("`fixtures` must be a non-empty array of fixture names");
}
if (!Number.isInteger(n) || n < 1) {
  shapeErrors.push("`n` must be a positive integer");
}
if (!Array.isArray(records) || records.length === 0) {
  shapeErrors.push("`records` must be a non-empty array");
}
if (shapeErrors.length > 0) {
  process.stderr.write(`\nArtifact header is malformed:\n  ${shapeErrors.join("\n  ")}\n\n`);
  process.exit(1);
}

out(`Cells:    ${models.length} models × ${fixtures.length} fixtures × n=${n}`);
out(`Records:  ${records.length}`);
out();

// A run wider than the cap cannot come from the committed runner.
if (models.length > MAX_MODELS) {
  fail(
    `${models.length} models, but the runner caps a selection at ${MAX_MODELS}. ` +
      "This artifact was not produced by the committed run-matrix.ts.",
  );
}

// ---------------------------------------------------------------------------
// 2. Fixtures, against the committed files.
//
//    A weakened fixture is the quiet way to make a run green: soften the prompt
//    that provokes the failure and every cell passes honestly. So the fixture
//    text is never taken from the artifact. Each record's `original` is
//    compared with the committed file as the runner would have read it, and the
//    recorded digest (when present) with the file's raw bytes.
// ---------------------------------------------------------------------------

const committedFixtures = new Map();
for (const name of fixtures) {
  if (!FIXTURES.includes(name)) {
    fail(`fixture "${name}" is not one of the committed fixtures: ${FIXTURES.join(", ")}`);
    continue;
  }
  const file = path.join(FIXTURE_DIR, `${name}.txt`);
  if (!fs.existsSync(file)) {
    fail(`fixture "${name}" has no committed file at ${path.relative(ROOT, file)}`);
    continue;
  }
  const raw = fs.readFileSync(file);
  committedFixtures.set(name, { text: raw.toString("utf-8").trim(), digest: sha256(raw) });
}

const recordedDigests = artifact.fixtureDigests;
if (recordedDigests === undefined) {
  note(
    "no `fixtureDigests` in the artifact (older runner). Fixture text is still " +
      "checked record by record, which is the stronger of the two checks.",
  );
} else if (typeof recordedDigests !== "object" || recordedDigests === null) {
  fail("`fixtureDigests` is present but is not an object");
} else {
  for (const [name, committed] of committedFixtures) {
    const recorded = recordedDigests[name];
    if (recorded === undefined) {
      fail(`fixtureDigests is missing "${name}"`);
    } else if (recorded !== committed.digest) {
      fail(
        `fixture "${name}" was modified for this run:\n` +
          `      recorded  ${recorded}\n` +
          `      committed ${committed.digest}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Counts and coverage. No missing cell, no duplicate iteration, no cell
//    carried entirely by host errors.
// ---------------------------------------------------------------------------

const expected = models.length * fixtures.length * n;
if (records.length !== expected) {
  fail(
    `${records.length} records, expected ${models.length} × ${fixtures.length} × ${n} = ${expected}`,
  );
}

const cellKey = (model, fixture) => `${model} | ${fixture}`;
/** cell -> Map<iteration, count> */
const seen = new Map();
for (const model of models) {
  for (const fixture of fixtures) seen.set(cellKey(model, fixture), new Map());
}

const unknownCells = new Set();
for (const [index, record] of records.entries()) {
  if (record === null || typeof record !== "object") {
    fail(`record ${index} is not an object`);
    continue;
  }
  const key = cellKey(record.model, record.fixture);
  const cell = seen.get(key);
  if (cell === undefined) {
    unknownCells.add(key);
    continue;
  }
  cell.set(record.iteration, (cell.get(record.iteration) ?? 0) + 1);
}

for (const key of unknownCells) {
  fail(`records exist for "${key}", which is not in the artifact's models × fixtures`);
}

const missing = [];
const duplicated = [];
for (const [key, cell] of seen) {
  for (let iteration = 1; iteration <= n; iteration += 1) {
    const count = cell.get(iteration) ?? 0;
    if (count === 0) missing.push(`${key} #${iteration}`);
    else if (count > 1) duplicated.push(`${key} #${iteration} ×${count}`);
  }
  for (const iteration of cell.keys()) {
    if (!Number.isInteger(iteration) || iteration < 1 || iteration > n) {
      fail(`${key} has a record with iteration ${iteration}, outside 1..${n}`);
    }
  }
}
if (missing.length > 0) {
  fail(
    `${missing.length} missing cell record(s): ${missing.slice(0, MAX_EXAMPLES).join(", ")}` +
      (missing.length > MAX_EXAMPLES ? ", …" : ""),
  );
}
if (duplicated.length > 0) {
  fail(
    `${duplicated.length} duplicated cell record(s): ` +
      duplicated.slice(0, MAX_EXAMPLES).join(", ") +
      (duplicated.length > MAX_EXAMPLES ? ", …" : ""),
  );
}

// ---------------------------------------------------------------------------
// 4. `knownPaths`, the one scoring input that is repo state rather than model
//    output. `fabricated_path` cannot be reproduced without it: scoring against
//    the verifier's own working tree marks every file the contributor added as
//    invented.
// ---------------------------------------------------------------------------

let knownPaths = artifact.knownPaths;
if (Array.isArray(knownPaths) && knownPaths.every((p) => typeof p === "string")) {
  const absent = knownPaths.filter(
    // The runner adds its own `<out>.partial.jsonl` and deletes it on success,
    // so its absence here is the normal case, not a signal.
    (p) => !p.endsWith(".partial.jsonl") && !fs.existsSync(path.join(ROOT, p)),
  );
  if (absent.length > 0) {
    note(
      `${absent.length} of ${knownPaths.length} recorded knownPaths do not exist here ` +
        "(expected for files the PR adds; a large number is worth a look, since padding " +
        "this list is how a fabricated_path would be hidden).",
    );
  }
} else {
  knownPaths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\n")
    .filter((line) => line.length > 0);
  note(
    "no `knownPaths` in the artifact (older runner), so this checkout's file list " +
      "was used instead. `fabricated_path` re-scoring is approximate for this file.",
  );
}

// ---------------------------------------------------------------------------
// 5. The re-score. This is the check the rest of the script exists to support.
// ---------------------------------------------------------------------------

const mismatches = [];
const fixtureTextMismatches = [];
let hostErrors = 0;
const scoreableByCell = new Map();
/** Re-scored verdict per record index, so the table shows what was verified. */
const rescoredVerdicts = new Map();

for (const [index, record] of records.entries()) {
  if (record === null || typeof record !== "object") continue;
  const where = `${record.model} | ${record.fixture} #${record.iteration} (record ${index})`;

  const committed = committedFixtures.get(record.fixture);
  if (committed !== undefined && record.original !== committed.text) {
    fixtureTextMismatches.push(where);
  }

  if (typeof record.enhanced !== "string" || typeof record.setEditorTextCount !== "number") {
    fail(`${where} is missing \`enhanced\` or \`setEditorTextCount\`; it cannot be re-scored`);
    continue;
  }

  const rescored = scoreCall({
    original: record.original,
    enhanced: record.enhanced,
    stopReason: record.stopReason ?? "unknown",
    knownPaths,
    setEditorTextCount: record.setEditorTextCount,
    ...(record.extensionError !== undefined ? { extensionError: record.extensionError } : {}),
    ...(record.spawnError !== undefined ? { spawnError: record.spawnError } : {}),
    stderrTail: record.stderrTail ?? "",
    timedOut: record.timedOut === true,
    exitCode: record.exitCode ?? null,
  });

  const storedCodes = Array.isArray(record.codes) ? record.codes : [];
  const storedSignals = Array.isArray(record.signals) ? record.signals : [];
  const differs =
    rescored.verdict !== record.verdict ||
    rescored.codes.join(",") !== storedCodes.join(",") ||
    rescored.signals.join(",") !== storedSignals.join(",");
  if (differs) {
    mismatches.push(
      `${where}\n` +
        `      stored    verdict=${record.verdict} codes=[${storedCodes.join(",")}] ` +
        `signals=[${storedSignals.join(",")}]\n` +
        `      re-scored verdict=${rescored.verdict} codes=[${rescored.codes.join(",")}] ` +
        `signals=[${rescored.signals.join(",")}]`,
    );
  }

  const verdict = rescored.verdict;
  rescoredVerdicts.set(index, verdict);
  if (verdict === "host_error") {
    hostErrors += 1;
  } else {
    const key = cellKey(record.model, record.fixture);
    scoreableByCell.set(key, (scoreableByCell.get(key) ?? 0) + 1);
  }
}

if (fixtureTextMismatches.length > 0) {
  fail(
    `${fixtureTextMismatches.length} record(s) were run against prompt text that is not the ` +
      `committed fixture:\n      ${fixtureTextMismatches.slice(0, MAX_EXAMPLES).join("\n      ")}` +
      (fixtureTextMismatches.length > MAX_EXAMPLES ? "\n      …" : ""),
  );
}

if (mismatches.length > 0) {
  fail(
    `${mismatches.length} of ${records.length} record(s) do not re-score to their stored verdict.\n` +
      "    The artifact is fabricated, stale, or was produced by an edited harness.\n" +
      `    First ${Math.min(MAX_EXAMPLES, mismatches.length)}:\n      ` +
      mismatches.slice(0, MAX_EXAMPLES).join("\n      "),
  );
}

// A cell whose every call was infrastructure failing was not measured. Reading
// it as a green cell is exactly the false pass the runner refuses to produce,
// so the check refuses to accept one either.
const unmeasured = [];
for (const key of seen.keys()) {
  if ((scoreableByCell.get(key) ?? 0) === 0) unmeasured.push(key);
}
if (unmeasured.length > 0) {
  fail(
    `${unmeasured.length} cell(s) have no scoreable call — every record is a host error, ` +
      `so the cell was not measured:\n      ${unmeasured.slice(0, MAX_EXAMPLES).join("\n      ")}` +
      (unmeasured.length > MAX_EXAMPLES ? "\n      …" : ""),
  );
}
if (hostErrors > 0) {
  note(
    `${hostErrors} of ${records.length} records are host errors. They are excluded from ` +
      "the cell counts and are not evidence about the enhancer in either direction.",
  );
}

// ---------------------------------------------------------------------------
// 6. The baseline column. Policy, never scoring: it decides nothing about any
//    verdict, it only decides whether two artifacts are comparable.
// ---------------------------------------------------------------------------

const baselinePresent = models.some(
  (key) => key === BASELINE_MODEL || key.startsWith(`${BASELINE_MODEL}#`),
);
const recordedBaseline =
  artifact.baseline !== null && typeof artifact.baseline === "object" ? artifact.baseline : null;
const exemptionReason =
  typeof recordedBaseline?.exemptionReason === "string" &&
  recordedBaseline.exemptionReason.trim().length > 0
    ? recordedBaseline.exemptionReason.trim()
    : null;

if (baselinePresent) {
  out(`baseline ${BASELINE_MODEL}: present`);
  if (recordedBaseline !== null && recordedBaseline.present === false) {
    fail(
      `the artifact records baseline.present=false, but ${BASELINE_MODEL} is in \`models\`. ` +
        "The header does not describe the run it belongs to.",
    );
  }
} else if (exemptionReason !== null) {
  out(`baseline ${BASELINE_MODEL}: ABSENT, exempted`);
  out(`  reason: ${exemptionReason}`);
  note(
    "this run has no baseline column, so its numbers are not directly comparable with " +
      "another contributor's. Judge the exemption reason above on its merits.",
  );
} else {
  out(`baseline ${BASELINE_MODEL}: ABSENT`);
  fail(
    `the required baseline model ${BASELINE_MODEL} is not in this run and no exemption ` +
      "reason was recorded.\n" +
      '    Re-run including it, or re-run with --baseline-exempt "<why you cannot>" so the\n' +
      "    artifact says why. It is the one column that makes two artifacts comparable.",
  );
}

// ---------------------------------------------------------------------------
// 7. Harness digests. Self-attested, so informational only: a fabricated file
//    would carry the right ones. Reported because when they *do* differ it is
//    usually the honest explanation for a re-score mismatch.
// ---------------------------------------------------------------------------

const recordedHarness = artifact.harness;
if (recordedHarness !== null && typeof recordedHarness === "object") {
  for (const [relative, recorded] of Object.entries(recordedHarness)) {
    const file = path.join(ROOT, "packages", "prompt-enhancer", relative);
    if (!fs.existsSync(file)) continue;
    const current = sha256(fs.readFileSync(file));
    if (current !== recorded) {
      note(
        `${relative} has changed since this artifact was recorded. If the re-score above ` +
          "is clean, the change did not affect any verdict.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 8. The table, printed from the re-scored verdicts rather than the stored
//    ones, so what is displayed is what was verified.
// ---------------------------------------------------------------------------

out();
const width = Math.max(...models.map((key) => key.length), 5) + 2;
out(`${"model".padEnd(width)}${fixtures.map((f) => f.padStart(Math.max(f.length, 7))).join("  ")}`);
for (const model of models) {
  const cells = fixtures.map((fixture) => {
    const scoreable = records
      .map((record, index) => ({ record, verdict: rescoredVerdicts.get(index) }))
      .filter(
        ({ record, verdict }) =>
          record.model === model && record.fixture === fixture && verdict !== undefined,
      )
      .filter(({ verdict }) => verdict !== "host_error");
    const bad = scoreable.filter(({ verdict }) => verdict === "bad").length;
    return `${bad}/${scoreable.length}`.padStart(Math.max(fixture.length, 7));
  });
  out(`${model.padEnd(width)}${cells.join("  ")}`);
}

finish();
