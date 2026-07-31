#!/usr/bin/env node
/**
 * `steward-setup.mjs` — the deterministic half of the `/initialize-steward` skill.
 *
 * The skill's judgement (which collector fits this machine, which launch
 * mechanism it uses, what to propose to the operator) belongs to the model. The
 * parts that must NOT be improvised — the consent hashes, the file mode, the
 * atomic write, the empirical proof that a collector actually streams — live
 * here, where they are testable and cannot drift with the wording of a prompt.
 *
 * Nothing in this file starts, stops, restarts, or reconfigures a service, and
 * nothing writes outside the Steward config path it is given. `apply` is the
 * only subcommand that writes at all, it always backs up first, and it always
 * prints the exact revert command.
 *
 *   check-argv     --argv-json <json> | --pid <n>     compliance of a launch argv
 *   probe-collector --command-json <json> [...]       run a collector, prove it streams
 *   plan           --input <file|->                   validated config + hashes + diff
 *   apply          --input <file|->                   backup + atomic 0600 write
 *   verify         [--config <path>] [...]            re-check everything, post-apply
 *
 * Run `node steward-setup.mjs help` for the full flag list.
 *
 * Exit codes: 0 = all checks passed, 1 = at least one FAIL, 2 = usage error.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The schema tag every collector line must carry (see `core/host-metrics.ts`). */
const HOST_METRICS_SCHEMA = "steward.hostmetrics/1";

/** The metric fields the host band can render. Every one is `number | null`. */
const METRIC_FIELDS = [
  "gpuUtil",
  "gpuTempC",
  "cpuUtil",
  "cpuTempC",
  "ramUsedGB",
  "ramTotalGB",
  "vramUsedGB",
  "vramTotalGB",
];

/** VRAM is never synthesised on unified memory — these must be absent there. */
const VRAM_FIELDS = ["vramUsedGB", "vramTotalGB"];

/** The control actions `steward.json` declares together. */
const CONTROL_ACTIONS = ["start", "stop", "restart"];

/** Longest collector line assembled before it is discarded, mirroring the reader's cap. */
const MAX_LINE_LENGTH = 64 * 1024;

/** Grace between the SIGTERM that ends a probe and the SIGKILL that follows it. */
const KILL_ESCALATION_MS = 750;

/**
 * A router line that llama.cpp wrote to **stderr**: its own levelled output,
 * `0.08.955.549 I srv load: …`. Verified against a 172k-line live combined log
 * (36,918 matches). Its presence is proof stderr reached the file.
 */
const ROUTER_STDERR_LINE = /^\d+\.\d{2}\.\d{3}\.\d{3} [A-Z] /u;

/**
 * A child line the router FORWARDED, which it emits at `GGML_LOG_LEVEL_NONE` —
 * i.e. to **stdout** — prefixed with the child's port: `[54241] …`. Verified on
 * the same log (135,347 matches). Its presence is proof stdout reached the file.
 */
const ROUTER_STDOUT_LINE = /^\[\d+\] /u;

/** Flags that put `llama-server` in single-model mode, which Pi cannot drive. */
const SINGLE_MODEL_FLAGS = new Set(["-m", "--model", "-hf", "--hf-repo", "-hfr"]);

/* ------------------------------------------------------------------ *
 * findings
 * ------------------------------------------------------------------ */

/** One check's outcome. `fail` sets the exit code; `warn` and `ok` do not. */
function finding(level, message, detail) {
  return { level, message, detail: detail ?? null };
}

const fail = (message, detail) => finding("fail", message, detail);
const warn = (message, detail) => finding("warn", message, detail);
const ok = (message, detail) => finding("ok", message, detail);

const LEVEL_MARK = { ok: "  ok  ", warn: " WARN ", fail: " FAIL " };

/** Prints findings as a readable block and reports whether any of them failed. */
function report(title, findings) {
  process.stdout.write(`\n${title}\n${"-".repeat(title.length)}\n`);
  if (findings.length === 0) process.stdout.write("  (nothing to check)\n");
  for (const item of findings) {
    process.stdout.write(`[${LEVEL_MARK[item.level]}] ${item.message}\n`);
    if (item.detail !== null && item.detail !== "") {
      for (const line of String(item.detail).split("\n")) {
        process.stdout.write(`           ${line}\n`);
      }
    }
  }
  return findings.some((item) => item.level === "fail");
}

/* ------------------------------------------------------------------ *
 * argv parsing
 * ------------------------------------------------------------------ */

function parseFlags(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new UsageError(`unexpected argument: ${token}`);
    const equals = token.indexOf("=");
    if (equals > 0) {
      flags.set(token.slice(2, equals), token.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(token.slice(2), "true");
      continue;
    }
    flags.set(token.slice(2), next);
    index += 1;
  }
  return flags;
}

class UsageError extends Error {}

/** A required flag, or a usage error naming it. */
function required(flags, name) {
  const value = flags.get(name);
  if (value === undefined) throw new UsageError(`--${name} is required`);
  return value;
}

/** A positive integer flag with a default. */
function numberFlag(flags, name, fallback) {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new UsageError(`--${name} must be a number > 0`);
  return value;
}

/** Parses a JSON flag value, or reads it from a file when it names one. */
function jsonFlag(flags, name) {
  const raw = required(flags, name);
  const text =
    raw.trimStart().startsWith("[") || raw.trimStart().startsWith("{")
      ? raw
      : readFileSync(raw, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`--${name} is not valid JSON: ${error.message}`);
  }
}

/** Reads the proposal document from a file path, or from stdin for `-`. */
function readInput(spec) {
  const text = spec === "-" ? readFileSync(0, "utf8") : readFileSync(spec, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`input is not valid JSON: ${error.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * shared validation
 * ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty array of strings, or `null`. */
function asArgv(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((part) => typeof part === "string")) return null;
  return [...value];
}

/**
 * The canonical consent hash: sha256 of the argv joined on single spaces.
 * This MUST stay identical to `hashCommand` in `server/steward-config.ts` — a
 * different join here would write consent entries Steward never matches, and
 * every gauge and button would silently stay dark.
 */
export function hashCommand(command) {
  return createHash("sha256").update(command.join(" ")).digest("hex");
}

/**
 * Compliance verdict for a `llama-server` launch argv.
 *
 * Detection is from the ARGV, never from endpoint probing: in router mode with
 * no model loaded, `/metrics?model=`, `/slots?model=` and `/props?model=` all
 * return 400, so a live probe cannot tell a missing flag from an unloaded model.
 */
export function checkLaunchArgv(argv) {
  const findings = [];
  const tokens = argv.map((token) => String(token));
  const flagName = (token) => (token.includes("=") ? token.slice(0, token.indexOf("=")) : token);
  const names = new Set(tokens.map(flagName));

  const single = tokens.filter((token) => SINGLE_MODEL_FLAGS.has(flagName(token)));
  if (single.length > 0) {
    findings.push(
      fail(
        "not router mode — a single-model flag is present",
        `Found ${single.join(", ")}. Pi hard-requires router mode: start llama-server with\n` +
          "--models-dir / --models-preset and no -m / --model / -hf.",
      ),
    );
  } else {
    findings.push(ok("router mode — no single-model flag in the argv"));
  }

  if (names.has("--metrics")) {
    findings.push(ok("--metrics is present (it is OFF by default)"));
  } else {
    findings.push(
      fail(
        "--metrics is missing",
        "Throughput and request counters need it, and it defaults to disabled.\n" +
          "Equivalent: the LLAMA_ARG_ENDPOINT_METRICS=1 environment variable.",
      ),
    );
  }

  if (names.has("--no-slots")) {
    findings.push(
      fail(
        "--no-slots disables the slots endpoint",
        "The slots panel reads /slots. Slots are ON by default — remove this flag.",
      ),
    );
  } else {
    findings.push(ok("slots are not disabled (--slots is ON by default)"));
  }

  if (names.has("--log-file") || tokens.some((token) => token.includes("LLAMA_ARG_LOG_FILE"))) {
    findings.push(
      fail(
        "--log-file is present and MUST be removed",
        "unset_reserved_args does not strip LLAMA_ARG_LOG_FILE, so the router copies\n" +
          "--log-file into every child's spawn args, and set_file opens it with\n" +
          'fopen(path, "w") — truncate, not append. The router and N children then each\n' +
          "truncate the same file and write at independent offsets, which duplicates and\n" +
          "corrupts lines. Redirect the process's stdout AND stderr to one file instead.",
      ),
    );
  } else {
    findings.push(ok("--log-file is absent (it corrupts the log in router mode)"));
  }

  return findings;
}

/**
 * Reads one process's live command line as `ps` prints it — the argv joined on
 * single spaces. Read-only: it inspects a process, it never signals one.
 */
function processArgv(pid) {
  const result = spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status !== 0) return null;
  const line = (result.stdout ?? "").split("\n")[0]?.trim() ?? "";
  return line === "" ? null : line;
}

/* ------------------------------------------------------------------ *
 * proposal validation
 * ------------------------------------------------------------------ */

/**
 * Validates a proposal document and derives the `steward.json` Steward will
 * read, with the consent map computed from the commands it declares.
 *
 * The proposal is the same shape as `steward.json` MINUS `consent`: consent is
 * never authored by hand, because a hand-written hash that does not match its
 * command is indistinguishable — to the dashboard — from a command nobody
 * approved, and it fails silently.
 */
export function buildConfig(proposal) {
  const findings = [];
  if (!isRecord(proposal)) {
    return { config: null, findings: [fail("the proposal is not a JSON object")] };
  }

  const topology = proposal.memoryTopology;
  if (topology !== "unified" && topology !== "discrete") {
    findings.push(fail('memoryTopology must be "unified" or "discrete"'));
  }

  const collectorBlock = isRecord(proposal.hostCollector) ? proposal.hostCollector : null;
  const collector = collectorBlock === null ? null : asArgv(collectorBlock.command);
  const intervalMs = collectorBlock === null ? undefined : collectorBlock.intervalMs;
  if (collector === null) {
    findings.push(fail("hostCollector.command must be a non-empty array of strings"));
  }
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    findings.push(fail("hostCollector.intervalMs must be a number > 0"));
  }
  if (collector !== null) findings.push(...checkCollectorCommand(collector));

  let control = null;
  if (proposal.control !== undefined) {
    const block = isRecord(proposal.control) ? proposal.control : null;
    const parsed = {};
    let bad = false;
    for (const action of CONTROL_ACTIONS) {
      const argv = block === null ? null : asArgv(block[action]);
      if (argv === null) bad = true;
      else parsed[action] = argv;
    }
    if (bad) {
      findings.push(
        fail(
          "control needs all three of start, stop and restart",
          "Steward drops a half-written control block entirely. A machine that can only\n" +
            "be restarted is expressed by consenting to restart alone, not by omitting keys.",
        ),
      );
    } else {
      control = parsed;
      findings.push(...checkControl(parsed));
    }
  }

  let llama = null;
  if (proposal.llama !== undefined) {
    const block = isRecord(proposal.llama) ? proposal.llama : null;
    const launchArgv = block === null ? null : asArgv(block.launchArgv);
    if (launchArgv === null) {
      findings.push(fail("llama.launchArgv must be a non-empty array of strings"));
    } else {
      llama = {
        launchArgv,
        mechanism: typeof block.mechanism === "string" ? block.mechanism : null,
        label: typeof block.label === "string" ? block.label : null,
      };
      findings.push(...checkLaunchArgv(launchArgv));
    }
  }

  let log = null;
  if (proposal.log !== undefined) {
    const block = isRecord(proposal.log) ? proposal.log : null;
    const path = block !== null && typeof block.path === "string" ? block.path.trim() : "";
    if (path === "") findings.push(fail("log.path must be a non-empty string"));
    else {
      log = { path };
      if (path.startsWith("/tmp/")) {
        findings.push(
          warn(
            `the log lives under /tmp (${path})`,
            "macOS's com.apple.tmp_cleaner deletes /tmp files untouched for ~3 days, so a\n" +
              "router stopped over a long weekend loses its log. Somewhere durable\n" +
              "(~/Library/Logs/llama/router.log) survives; mention rotation while you are there.",
          ),
        );
      }
    }
  }

  if (findings.some((item) => item.level === "fail")) return { config: null, findings };

  const consent = {};
  consent[hashCommand(collector)] = true;
  if (control !== null) {
    for (const action of CONTROL_ACTIONS) consent[hashCommand(control[action])] = true;
  }

  // Key order is chosen for a readable artifact, not for the reader — it ignores
  // unknown keys and does not care about order.
  const config = { memoryTopology: topology };
  if (typeof proposal.baseUrl === "string" && proposal.baseUrl.trim() !== "") {
    config.baseUrl = proposal.baseUrl.trim();
  }
  config.hostCollector = { command: collector, intervalMs };
  if (log !== null) config.log = log;
  if (control !== null) config.control = control;
  if (llama !== null) config.llama = llama;
  config.consent = consent;

  return { config, findings };
}

/** Static smells in a collector command. The probe is the real test; these are hints. */
function checkCollectorCommand(command) {
  const findings = [];
  const joined = command.join(" ");

  if (joined.includes("|") && /\bjq\b/u.test(joined)) {
    if (!/--unbuffered/u.test(joined) && !/\bstdbuf\b/u.test(joined)) {
      findings.push(
        warn(
          "a jq stage in a pipeline without --unbuffered",
          "jq block-buffers when its stdout is a pipe, so `macmon … | jq -c …` emits ZERO\n" +
            "lines to Steward while looking perfectly healthy. Add --unbuffered (or wrap the\n" +
            "producer in stdbuf -oL). `probe-collector` will catch it either way.",
        ),
      );
    }
  }

  if (command.length === 1) {
    findings.push(
      warn(
        "the collector is a bare binary with no transform",
        "No tool emits steward.hostmetrics/1 natively, so a collector is normally a\n" +
          "wrapper: the raw tool plus a transform. If this really does emit the schema,\n" +
          "`probe-collector` will confirm it.",
      ),
    );
  }

  if (/\bmacmon\b/u.test(joined) && !/-s\s*0/u.test(joined)) {
    findings.push(
      warn(
        "macmon without `-s 0`",
        "Steward reads a PERSISTENT stream. `macmon pipe -s 1` emits one line and exits,\n" +
          "which turns into a respawn every sample and trips the respawn cap.",
      ),
    );
  }

  return findings;
}

/** launchd-specific advice on the declared control commands. */
function checkControl(control) {
  const findings = [];
  const joined = Object.values(control)
    .map((argv) => argv.join(" "))
    .join("\n");

  if (/\blaunchctl\b/u.test(joined) && /\bbootout\b/u.test(joined)) {
    findings.push(
      warn(
        "stop uses `launchctl bootout`",
        'bootout UNREGISTERS the job, so a later `kickstart` fails with "no such\n' +
          'process" and Start stays dead until something bootstraps it again.\n' +
          "`launchctl kill SIGTERM gui/<uid>/<label>` stops the process and leaves the\n" +
          "agent registered, which keeps start and restart working.",
      ),
    );
  }
  return findings;
}

/* ------------------------------------------------------------------ *
 * config file reading (mirrors server/steward-config.ts)
 * ------------------------------------------------------------------ */

/** The path Steward reads, honouring `STEWARD_CONFIG`. */
export function stewardConfigPath(env = process.env) {
  const override = env.STEWARD_CONFIG;
  if (override !== undefined && override.trim() !== "") return override;
  return join(homedir(), ".config", "steward", "steward.json");
}

/**
 * Re-checks a written `steward.json` the way the server does — ownership, mode,
 * JSON, schema, and then the consent map — so `verify` fails here rather than
 * leaving the operator to work out why every panel is empty.
 */
export function inspectConfigFile(path, uid) {
  const findings = [];
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { findings: [fail(`no config at ${path}`)], config: null };
  }

  if (uid !== null && stat.uid !== uid) {
    findings.push(
      fail(
        `${path} is not owned by the current user`,
        "Steward refuses a config another user could have planted. Fix with `chown`.",
      ),
    );
  }
  if ((stat.mode & 0o002) !== 0) {
    findings.push(fail(`${path} is world-writable`, "Steward refuses it. Fix with `chmod 600`."));
  }
  const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
  if (mode !== "600") findings.push(warn(`mode is ${mode}; 600 is what the skill writes`));
  else findings.push(ok("mode 600, owned by the current user"));

  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      findings: [...findings, fail(`${path} is not valid JSON`, error.message)],
      config: null,
    };
  }
  if (!isRecord(config)) {
    return { findings: [...findings, fail(`${path} is not a JSON object`)], config: null };
  }

  if (config.memoryTopology !== "unified" && config.memoryTopology !== "discrete") {
    findings.push(
      fail('memoryTopology must be "unified" or "discrete" — the whole config is refused'),
    );
  }

  const collector = isRecord(config.hostCollector) ? asArgv(config.hostCollector.command) : null;
  if (collector === null) {
    findings.push(
      fail("hostCollector.command is missing or invalid — the whole config is refused"),
    );
  } else if (config.consent?.[hashCommand(collector)] !== true) {
    findings.push(
      fail(
        "the collector command carries no matching consent hash",
        "Steward will not spawn it, and the host band stays dark. Re-run `plan`/`apply`\n" +
          "so the hash is recomputed from the exact command.",
      ),
    );
  } else {
    findings.push(ok("the collector command is consented"));
  }

  if (isRecord(config.control)) {
    for (const action of CONTROL_ACTIONS) {
      const argv = asArgv(config.control[action]);
      if (argv === null) {
        findings.push(
          fail(`control.${action} is missing or invalid — the whole control block is dropped`),
        );
      } else if (config.consent?.[hashCommand(argv)] !== true) {
        findings.push(
          fail(`control.${action} carries no matching consent hash — the button is not offered`),
        );
      } else {
        findings.push(ok(`control.${action} is consented`));
      }
    }
  }

  return { findings, config };
}

/* ------------------------------------------------------------------ *
 * collector probe
 * ------------------------------------------------------------------ */

/** Splits decoded stdout into complete lines, discarding a newline-less flood. */
function createLineSplitter(onLine) {
  let buffer = "";
  let discarding = false;
  return (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/u, "");
      buffer = buffer.slice(index + 1);
      if (discarding) discarding = false;
      else onLine(line);
      index = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_LINE_LENGTH) {
      buffer = "";
      discarding = true;
    }
  };
}

/**
 * Runs a collector for a bounded window and reports what it actually emitted.
 *
 * This is the empirical gate the whole host band rests on. It catches, in
 * particular, the two failures a static reading of the command cannot: a
 * producer that block-buffers and emits nothing at all, and a unified-memory
 * machine whose transform synthesises VRAM figures out of RAM.
 */
export function probeCollector({ command, seconds, topology, intervalMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const stats = {
      total: 0,
      valid: 0,
      malformed: 0,
      foreign: 0,
      firstLineMs: null,
      firstValidMs: null,
      present: Object.fromEntries(METRIC_FIELDS.map((field) => [field, 0])),
      stderr: "",
      exited: null,
      timestamps: [],
    };

    let child;
    try {
      child = spawn(command[0], command.slice(1), {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ stats, findings: [fail(`the collector could not be spawned: ${error.message}`)] });
      return;
    }

    child.on("error", (error) => {
      stats.spawnError = error.message;
    });

    const push = createLineSplitter((line) => {
      if (line.trim() === "") return;
      stats.total += 1;
      if (stats.firstLineMs === null) stats.firstLineMs = Date.now() - started;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        stats.malformed += 1;
        return;
      }
      if (!isRecord(parsed) || parsed.schema !== HOST_METRICS_SCHEMA) {
        stats.foreign += 1;
        return;
      }
      if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) {
        stats.malformed += 1;
        return;
      }
      stats.valid += 1;
      stats.timestamps.push(Date.now());
      if (stats.firstValidMs === null) stats.firstValidMs = Date.now() - started;
      for (const field of METRIC_FIELDS) {
        const value = parsed[field];
        if (typeof value === "number" && Number.isFinite(value)) stats.present[field] += 1;
      }
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", push);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      if (stats.stderr.length < 2048) stats.stderr += chunk;
    });
    child.on("exit", (code, signal) => {
      stats.exited = signal !== null ? `signal ${signal}` : `code ${code}`;
    });

    const finish = () => {
      const pid = child.pid;
      if (pid !== undefined && stats.exited === null) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          // Already gone, or never grouped — the SIGKILL below is the backstop.
        }
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // Nothing left to reap.
          }
        }, KILL_ESCALATION_MS).unref();
      }
      resolve({ stats, findings: judgeProbe(stats, { seconds, topology, intervalMs }) });
    };

    setTimeout(finish, Math.round(seconds * 1000));
  });
}

/** Turns raw probe counters into findings an operator can act on. */
function judgeProbe(stats, { seconds, topology, intervalMs }) {
  const findings = [];

  if (stats.spawnError !== undefined) {
    findings.push(fail(`the collector could not be spawned: ${stats.spawnError}`));
    return findings;
  }

  if (stats.total === 0) {
    findings.push(
      fail(
        `the collector emitted NOTHING in ${seconds}s`,
        "This is the block-buffering trap: a pipeline like `macmon … | jq -c …` spawns\n" +
          "cleanly, stays alive, and never writes a line, so Steward would sit in\n" +
          "`warming` and then report the collector failed. Add `jq --unbuffered`, or wrap\n" +
          "the producer in `stdbuf -oL`.\n" +
          (stats.stderr === "" ? "" : `Collector stderr:\n${stats.stderr.trim()}`),
      ),
    );
    return findings;
  }

  if (stats.valid === 0) {
    findings.push(
      fail(
        `${stats.total} line(s) emitted, none of them a ${HOST_METRICS_SCHEMA} reading`,
        `${stats.malformed} unparseable, ${stats.foreign} parsed but wrong/absent schema tag.\n` +
          `Every line needs "schema":"${HOST_METRICS_SCHEMA}" and a numeric epoch-ms "ts".` +
          (stats.stderr === "" ? "" : `\nCollector stderr:\n${stats.stderr.trim()}`),
      ),
    );
    return findings;
  }

  findings.push(
    ok(
      `${stats.valid} valid reading(s) in ${seconds}s (first after ${stats.firstValidMs}ms)`,
      stats.malformed + stats.foreign > 0
        ? `${stats.malformed} malformed and ${stats.foreign} foreign line(s) were dropped.`
        : null,
    ),
  );

  if (stats.exited !== null) {
    findings.push(
      warn(
        `the collector exited (${stats.exited}) before the window closed`,
        "Steward needs a PERSISTENT stream. A one-shot producer is respawned with\n" +
          "backoff and trips the respawn cap, which surfaces as `collector-failed`.",
      ),
    );
  }

  if (stats.valid >= 3 && typeof intervalMs === "number") {
    const span = stats.timestamps[stats.timestamps.length - 1] - stats.timestamps[0];
    const measured = Math.round(span / (stats.valid - 1));
    if (measured > intervalMs * 2 || measured < intervalMs / 2) {
      findings.push(
        warn(
          `measured cadence ~${measured}ms, but intervalMs says ${intervalMs}`,
          "intervalMs is the staleness clock: a sample is stale past ~3x it. Recording a\n" +
            "cadence the collector does not keep makes the host band flap to `last-seen`.",
        ),
      );
    } else {
      findings.push(ok(`measured cadence ~${measured}ms matches the declared intervalMs`));
    }
  }

  const measured = METRIC_FIELDS.filter((field) => stats.present[field] > 0);
  const missing = METRIC_FIELDS.filter((field) => stats.present[field] === 0);
  findings.push(
    ok(
      `measured: ${measured.length === 0 ? "(none)" : measured.join(", ")}`,
      missing.length === 0
        ? null
        : `always null: ${missing.join(", ")} — these render as no-reading gauges, not zeros.`,
    ),
  );

  if (topology === "unified") {
    const synthesised = VRAM_FIELDS.filter((field) => stats.present[field] > 0);
    if (synthesised.length > 0) {
      findings.push(
        fail(
          `VRAM is being reported on unified memory (${synthesised.join(", ")})`,
          "There is no separate VRAM on unified memory and no readable GPU ceiling, so any\n" +
            'figure here is invented. Report memoryTopology "unified" with ramUsedGB /\n' +
            "ramTotalGB and omit the VRAM fields entirely; Steward renders one Unified\n" +
            "Memory gauge.",
        ),
      );
    } else {
      findings.push(ok("no VRAM fields on unified memory, as required"));
    }
  } else if (topology === "discrete" && stats.present.vramTotalGB === 0) {
    findings.push(
      warn(
        "discrete topology, but vramTotalGB never had a reading",
        "The VRAM gauge will render as no-reading. If this machine's VRAM total really\n" +
          "cannot be read, `unified` is not the answer either — leave it null and say so.",
      ),
    );
  }

  return findings;
}

/* ------------------------------------------------------------------ *
 * log inspection
 * ------------------------------------------------------------------ */

/**
 * Reads the tail of the recorded log and reports which of the two streams
 * reached it.
 *
 * llama.cpp splits its output: the router's own levelled lines (`I`/`W`/`E`) go
 * to STDERR, while the child lines it forwards are emitted at
 * `GGML_LOG_LEVEL_NONE` and go to STDOUT. Redirecting one stream silently loses
 * half the log — and stdout-only loses every error. So the presence of each line
 * shape is direct evidence that each stream was captured.
 */
export function inspectLog(path, { bytes = 256 * 1024 } = {}) {
  const findings = [];
  let stat;
  try {
    stat = statSync(path);
  } catch {
    findings.push(
      warn(
        `the recorded log ${path} does not exist yet`,
        "Steward reports this as `missing` and picks the file up the moment it appears;\n" +
          "it is only a problem if the service has been running and still wrote nothing.",
      ),
    );
    return { findings, stderrLines: 0, stdoutLines: 0 };
  }

  const start = Math.max(0, stat.size - bytes);
  let text = "";
  try {
    const buffer = readFileSync(path);
    text = buffer.subarray(start).toString("utf8");
  } catch (error) {
    findings.push(fail(`the log at ${path} could not be read`, error.message));
    return { findings, stderrLines: 0, stdoutLines: 0 };
  }

  let stderrLines = 0;
  let stdoutLines = 0;
  for (const line of text.split("\n")) {
    if (ROUTER_STDERR_LINE.test(line)) stderrLines += 1;
    else if (ROUTER_STDOUT_LINE.test(line)) stdoutLines += 1;
  }

  if (stderrLines > 0) {
    findings.push(ok(`stderr IS captured (${stderrLines} levelled router line(s) in the tail)`));
  } else if (stat.size === 0) {
    findings.push(warn("the log is empty — nothing has been written since it was created"));
  } else {
    findings.push(
      fail(
        "no levelled router lines — stderr does NOT look captured",
        "llama.cpp writes every I/W/E line to stderr. A redirect that only captures\n" +
          "stdout loses all of them, including every error. launchd needs BOTH\n" +
          "StandardOutPath and StandardErrorPath set to this same path; a shell wrapper\n" +
          "needs `> file 2>&1`.",
      ),
    );
  }

  if (stdoutLines > 0) {
    findings.push(
      ok(`stdout IS captured (${stdoutLines} forwarded [port] child line(s) in the tail)`),
    );
  } else {
    findings.push(
      warn(
        "no forwarded [port] child lines — stdout capture is unproven",
        "The router forwards child output on stdout, but only once a model has been\n" +
          "loaded. On a router that has never spawned a child this is expected; confirm\n" +
          "the redirect from the launch mechanism instead (both paths must be the file).",
      ),
    );
  }

  return { findings, stderrLines, stdoutLines };
}

/**
 * Confirms a launchd plist redirects BOTH streams to the recorded log.
 *
 * Parsed as text rather than with `plutil` on purpose: this must work on a
 * plist that is a symlink into a dotfiles repo, on a machine where the skill is
 * only allowed to read, and without shelling out.
 */
export function inspectPlist(plistPath, expectedLog) {
  const findings = [];
  let xml;
  try {
    xml = readFileSync(plistPath, "utf8");
  } catch (error) {
    findings.push(fail(`the plist at ${plistPath} could not be read`, error.message));
    return findings;
  }

  const read = (key) => {
    const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "u").exec(xml);
    return match === null ? null : match[1].trim();
  };

  const out = read("StandardOutPath");
  const err = read("StandardErrorPath");

  if (out === null || err === null) {
    findings.push(
      fail(
        "the plist does not set both StandardOutPath and StandardErrorPath",
        `StandardOutPath=${out ?? "(unset)"}, StandardErrorPath=${err ?? "(unset)"}.\n` +
          "Both are required, and both must name the SAME file: the router's own I/W/E\n" +
          "lines go to stderr and the child lines it forwards go to stdout.",
      ),
    );
    return findings;
  }

  if (out !== err) {
    findings.push(
      fail(
        "StandardOutPath and StandardErrorPath name different files",
        `stdout -> ${out}\nstderr -> ${err}\n` +
          "Steward follows one file. Split across two, the console shows half the log.",
      ),
    );
  } else {
    findings.push(ok(`both streams redirect to ${out}`));
  }

  if (expectedLog !== undefined && out !== expectedLog) {
    findings.push(
      fail(
        "the plist's redirect does not match the recorded log.path",
        `plist -> ${out}\nsteward.json -> ${expectedLog}`,
      ),
    );
  }

  return findings;
}

/* ------------------------------------------------------------------ *
 * diff + write
 * ------------------------------------------------------------------ */

/** A minimal LCS line diff, enough to show an operator exactly what changes. */
export function diffLines(before, after) {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push(`- ${a[i]}`);
      i += 1;
    } else {
      out.push(`+ ${b[j]}`);
      j += 1;
    }
  }
  while (i < a.length) {
    out.push(`- ${a[i]}`);
    i += 1;
  }
  while (j < b.length) {
    out.push(`+ ${b[j]}`);
    j += 1;
  }
  return out.join("\n");
}

/** The serialised artifact, newline-terminated. */
function serialise(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Writes `steward.json`: back up first, write through a temp file in the same
 * directory, and land it with `rename` so a reader never sees a half-written
 * config. Mode 0600 and a 0700 parent, because the reader refuses anything
 * world-writable or owned by someone else.
 */
function writeConfig(path, config) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  let backup = null;
  if (existsSync(path)) {
    const stat = statSync(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null && stat.uid !== uid) {
      throw new Error(`${path} is owned by uid ${stat.uid}, not ${uid} — refusing to overwrite it`);
    }
    backup = `${path}.bak.${new Date().toISOString().replace(/[:.]/gu, "-")}`;
    copyFileSync(path, backup);
    chmodSync(backup, 0o600);
  }

  const temporary = join(dir, `.steward.json.${process.pid}.tmp`);
  writeFileSync(temporary, serialise(config), { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return backup;
}

/* ------------------------------------------------------------------ *
 * subcommands
 * ------------------------------------------------------------------ */

function commandCheckArgv(flags) {
  let argv;
  let source;
  if (flags.has("pid")) {
    const pid = numberFlag(flags, "pid", 0);
    const line = processArgv(pid);
    if (line === null) {
      process.stdout.write(`could not read the command line of pid ${pid}\n`);
      return 1;
    }
    argv = line.split(/\s+/u).filter((token) => token !== "");
    source = `pid ${pid} (via ps; quoting is lost, so a quoted value is split)`;
  } else {
    argv = jsonFlag(flags, "argv-json");
    if (asArgv(argv) === null)
      throw new UsageError("--argv-json must be a non-empty array of strings");
    source = "--argv-json";
  }
  process.stdout.write(`llama-server launch argv, from ${source}:\n  ${argv.join(" ")}\n`);
  return report("Contract 1 — llama.cpp compliance", checkLaunchArgv(argv)) ? 1 : 0;
}

async function commandProbeCollector(flags) {
  const command = jsonFlag(flags, "command-json");
  if (asArgv(command) === null) {
    throw new UsageError("--command-json must be a non-empty array of strings");
  }
  const seconds = numberFlag(flags, "seconds", 6);
  const intervalMs = flags.has("interval-ms") ? numberFlag(flags, "interval-ms", 1000) : undefined;
  const topology = flags.get("topology");
  if (topology !== undefined && topology !== "unified" && topology !== "discrete") {
    throw new UsageError('--topology must be "unified" or "discrete"');
  }

  process.stdout.write(`running for ${seconds}s: ${command.join(" ")}\n`);
  const statics = report("Collector command (static review)", checkCollectorCommand(command));
  const { findings } = await probeCollector({ command, seconds, topology, intervalMs });
  const live = report("Collector stream (measured)", findings);
  return statics || live ? 1 : 0;
}

function commandPlan(flags) {
  const proposal = readInput(required(flags, "input"));
  const path = flags.get("config") ?? stewardConfigPath();
  const { config, findings } = buildConfig(proposal);
  const failed = report("Proposal review", findings);
  if (config === null) {
    process.stdout.write("\nThe proposal has errors; nothing would be written.\n");
    return 1;
  }

  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  process.stdout.write(`\nTarget: ${path}\n`);
  process.stdout.write(
    before === "" ? "(no config exists today)\n" : "(an existing config will be backed up)\n",
  );
  process.stdout.write("\nDiff (- current, + proposed)\n----------------------------\n");
  process.stdout.write(`${diffLines(before.trimEnd(), serialise(config).trimEnd())}\n`);
  process.stdout.write(
    "\nNothing has been written. To apply, re-run with `apply` — it will back the file\n" +
      "up first and print the exact revert command.\n",
  );
  return failed ? 1 : 0;
}

function commandApply(flags) {
  const proposal = readInput(required(flags, "input"));
  const path = flags.get("config") ?? stewardConfigPath();
  const { config, findings } = buildConfig(proposal);
  const failed = report("Proposal review", findings);
  if (config === null) {
    process.stdout.write("\nThe proposal has errors; nothing was written.\n");
    return 1;
  }

  const backup = writeConfig(path, config);
  process.stdout.write(`\nWrote ${path} (mode 600).\n`);
  if (backup === null) {
    process.stdout.write(`Revert with:\n  rm ${path}\n`);
  } else {
    process.stdout.write(
      `Backed up the previous config to ${backup}.\nRevert with:\n  cp ${backup} ${path}\n`,
    );
  }
  return failed ? 1 : 0;
}

async function commandVerify(flags) {
  const path = flags.get("config") ?? stewardConfigPath();
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const { findings: configFindings, config } = inspectConfigFile(path, uid);
  let failed = report(`Config artifact — ${path}`, configFindings);
  if (config === null) return 1;

  if (Array.isArray(config.llama?.launchArgv)) {
    failed =
      report("Contract 1 — recorded launch argv", checkLaunchArgv(config.llama.launchArgv)) ||
      failed;
    if (flags.has("pid")) {
      const pid = numberFlag(flags, "pid", 0);
      const live = processArgv(pid);
      const recorded = config.llama.launchArgv.join(" ");
      const drift =
        live === null
          ? warn(`the command line of pid ${pid} could not be read — no verdict`)
          : live === recorded
            ? ok(`the live process matches the recorded launch argv (pid ${pid})`)
            : fail(
                `the live process does not match the recorded launch argv (pid ${pid})`,
                `recorded: ${recorded}\nobserved: ${live}\n` +
                  "Steward's drift notice will say the same thing. Re-run the skill so the\n" +
                  "record matches the machine, or put the flag back.",
              );
      failed = report("Contract 1 — live process vs record", [drift]) || failed;
    }
  }

  const logPath = typeof config.log?.path === "string" ? config.log.path : null;
  if (logPath !== null) {
    failed =
      report(`Contract 1 — log capture (${logPath})`, inspectLog(logPath).findings) || failed;
    const plist = flags.get("plist");
    if (plist !== undefined) {
      failed =
        report(`Contract 1 — launchd redirect (${plist})`, inspectPlist(plist, logPath)) || failed;
    }
  }

  if (!flags.has("skip-collector") && Array.isArray(config.hostCollector?.command)) {
    const seconds = numberFlag(flags, "seconds", 6);
    const { findings } = await probeCollector({
      command: config.hostCollector.command,
      seconds,
      topology: config.memoryTopology,
      intervalMs: config.hostCollector.intervalMs,
    });
    failed = report("Contract 2 — host-metrics stream (measured)", findings) || failed;
  }

  process.stdout.write(
    failed
      ? "\nSome checks FAILED. Report exactly which, and what is still missing.\n"
      : "\nAll checks passed.\n",
  );
  return failed ? 1 : 0;
}

const USAGE = `steward-setup.mjs — deterministic helpers for /initialize-steward

  check-argv      --argv-json <json|file> | --pid <n>
                  Contract-1 compliance of a llama-server launch argv.

  probe-collector --command-json <json|file> [--seconds 6]
                  [--topology unified|discrete] [--interval-ms <n>]
                  Runs a collector for a bounded window and reports what it
                  really emitted. Catches block-buffered producers and VRAM
                  synthesised on unified memory. Kills the process group after.

  plan            --input <file|-> [--config <path>]
                  Validates a proposal, derives the consent hashes, and prints
                  the exact diff against the current config. Writes nothing.

  apply           --input <file|-> [--config <path>]
                  Backs the current config up, then writes the new one
                  atomically at mode 600. Prints the revert command.

  verify          [--config <path>] [--pid <n>] [--plist <path>]
                  [--seconds 6] [--skip-collector]
                  Re-checks the written artifact the way Steward reads it, the
                  recorded argv, the log capture, and the live collector.

The proposal is a steward.json WITHOUT its consent map: consent is always
derived here, from the exact commands, so a hash can never disagree with the
command it approves.
`;

async function main(argv) {
  const command = argv[0];
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  const flags = parseFlags(argv.slice(1));
  switch (command) {
    case "check-argv":
      return commandCheckArgv(flags);
    case "probe-collector":
      return await commandProbeCollector(flags);
    case "plan":
      return commandPlan(flags);
    case "apply":
      return commandApply(flags);
    case "verify":
      return await commandVerify(flags);
    default:
      throw new UsageError(`unknown subcommand: ${command}`);
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
