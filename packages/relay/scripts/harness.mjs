#!/usr/bin/env node
/**
 * harness.mjs — manual provider proof against a REAL backend CLI.
 *
 * Phase 3 replaced relay's bespoke `verify_phase`/`dispatch` tools with registered
 * pi providers (`relay-claude`, `relay-grok`). This harness proves the provider
 * seam end-to-end: it loads the relay extension into a real headless `pi` session,
 * routes a completion through the given `model`, and confirms the reply is the
 * final text of one backend CLI run (single-turn) — i.e. one provider completion
 * == one full external-agent run.
 *
 * It is NOT part of `npm run check`. Run it manually with the target backend CLI
 * authenticated (Claude via your subscription's oauthAccount; Grok via
 * `grok login` or `XAI_API_KEY`):
 *
 *   node packages/relay/scripts/harness.mjs                        # relay-claude/opus (default)
 *   node packages/relay/scripts/harness.mjs --model relay-grok/grok-4.5
 *
 * Exit code 0 iff the routed proof succeeds.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY_ENTRY = path.resolve(HERE, "..", "index.ts");
const TOKEN = "RELAY_PROVIDER_OK";

function parseModelArg(argv) {
  const idx = argv.indexOf("--model");
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  return "relay-claude/opus";
}

function ok(pass, label) {
  process.stdout.write(`${pass ? "OK  " : "FAIL"}  ${label}\n`);
  return pass;
}

function runPi(args) {
  return new Promise((resolve) => {
    const child = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
  });
}

async function main() {
  const model = parseModelArg(process.argv.slice(2));
  process.stdout.write(
    `relay provider proof (real backend CLI via pi provider, model=${model})\n\n`,
  );

  const started = Date.now();
  const { code, out, err } = await runPi([
    "-p",
    "--no-session",
    "-ne",
    "-e",
    RELAY_ENTRY,
    "--model",
    model,
    `Reply with exactly the token ${TOKEN} and nothing else.`,
  ]);
  const elapsedMs = Date.now() - started;

  let allPass = true;
  allPass = ok(code === 0, `pi session exited cleanly (code ${code})`) && allPass;
  allPass =
    ok(out.includes(TOKEN), `completion routed through ${model} → backend CLI (saw ${TOKEN})`) &&
    allPass;
  allPass =
    ok(elapsedMs < 600_000, `completed within wall-cap (${(elapsedMs / 1000).toFixed(1)}s)`) &&
    allPass;

  if (!allPass) {
    process.stdout.write(`\n--- pi stdout ---\n${out}\n--- pi stderr ---\n${err}\n`);
  }
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
