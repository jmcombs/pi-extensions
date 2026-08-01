#!/usr/bin/env node
/**
 * A controllable fake host-metrics collector, for `host-collector.test.ts`.
 *
 * The collector under test spawns REAL processes, so its lifecycle (respawn,
 * backoff cap, process-group kill) is exercised against a real one rather than a
 * mock. This script stands in for `macmon | jq …` with deterministic behaviour
 * chosen by its mode.
 *
 *   node producer.mjs emit                 emit a valid NDJSON line every ~20ms, forever
 *   node producer.mjs once   <countFile>   record a start, emit one valid line, exit 0
 *   node producer.mjs silent <countFile>   record a start, emit nothing, stay alive
 *   node producer.mjs crash  <countFile>   record a start, emit nothing, exit 1
 *   node producer.mjs noise                emit malformed + valid lines, forever
 *   node producer.mjs flood                emit an over-cap newline-less blob, then valid lines
 *   node producer.mjs stubborn <pidFile>   trap/ignore SIGTERM, write own pid, stay alive
 *   node producer.mjs group  <pidFile>     fork a same-group child, write its pid, stay alive
 *
 * `<countFile>` is appended one byte per start, so a test can count (re)spawns
 * without reaching inside the collector. `<pidFile>` receives a grandchild pid so
 * the orphan test can confirm the whole group was reaped.
 */

import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const SCHEMA = "steward.hostmetrics/1";
const mode = process.argv[2] ?? "emit";
const arg = process.argv[3];

function validLine(extra = {}) {
  return `${JSON.stringify({
    schema: SCHEMA,
    ts: Date.now(),
    gpuUtil: 0.31,
    gpuTempC: 41.9,
    cpuUtil: 0.18,
    cpuTempC: 41.2,
    ramUsedGB: 64.2,
    ramTotalGB: 128,
    ...extra,
  })}\n`;
}

function recordStart() {
  if (arg !== undefined) appendFileSync(arg, "x");
}

switch (mode) {
  case "once": {
    recordStart();
    process.stdout.write(validLine());
    process.exit(0);
    break;
  }
  case "silent": {
    recordStart();
    // Stay alive but emit nothing — the jq-block-buffer silent-producer case.
    setInterval(() => {}, 1000);
    break;
  }
  case "crash": {
    recordStart();
    process.exit(1);
    break;
  }
  case "noise": {
    // A stream of junk with the occasional real reading, to prove the reader
    // skips malformed/foreign lines and keeps the valid one.
    setInterval(() => {
      process.stdout.write("not json at all\n");
      process.stdout.write(`${JSON.stringify({ schema: "other/1", ts: Date.now() })}\n`);
      process.stdout.write(validLine());
    }, 20);
    break;
  }
  case "flood": {
    // A newline-less blob far larger than the reader's cap, then — after it has
    // been discarded and resynced — a normal valid line. Proves the collector
    // does not buffer the flood whole and still parses what follows it.
    process.stdout.write("x".repeat(256 * 1024));
    setTimeout(() => {
      process.stdout.write("\n");
      process.stdout.write(validLine());
      setInterval(() => process.stdout.write(validLine()), 20);
    }, 30);
    break;
  }
  case "stubborn": {
    // Trap and ignore SIGTERM, then stay alive — only a SIGKILL can stop it.
    process.on("SIGTERM", () => {});
    if (arg !== undefined) writeFileSync(arg, String(process.pid));
    process.stdout.write(validLine());
    setInterval(() => {}, 1000);
    break;
  }
  case "group": {
    // Fork a child that shares this process group (detached:false) and sleeps.
    // A group kill reaps it; a plain kill of this parent would orphan it.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
      detached: false,
      stdio: "ignore",
    });
    if (arg !== undefined) writeFileSync(arg, String(child.pid));
    process.stdout.write(validLine());
    setInterval(() => {}, 1000);
    break;
  }
  default: {
    // "emit": a steady stream of valid readings.
    setInterval(() => {
      process.stdout.write(validLine());
    }, 20);
    break;
  }
}
