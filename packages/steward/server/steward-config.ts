/**
 * Reads and validates the `steward.json` handshake artifact.
 *
 * `steward.json` is written by the `/initialize-steward` skill (a later phase),
 * not by hand in the common case, and it drives Steward to run local commands —
 * the host-metrics collector and the service-control commands — so it is a
 * code-execution surface.
 * This module is the gate in front of that. It reads the artifact from
 * `STEWARD_CONFIG` (if set) else `~/.config/steward/steward.json`, and returns a
 * typed config or `null` — it NEVER throws, because an absent, malformed, or
 * untrusted config is a state to degrade on, not an error to crash the dashboard
 * with.
 *
 * Security (plan §M7): before the config is trusted at all, its file must be
 * owned by the current user and must not be world-writable — otherwise another
 * user could drop a command in and have Steward run it. A separate per-command
 * consent gate ({@link hostCollectorConsented}, {@link controlConsented}) then
 * requires that exact command's hash to be present in the config's `consent`
 * map, so a rewritten command re-prompts rather than riding an old blanket
 * "yes".
 *
 * This module is Node-only (the server half): it touches the filesystem, the
 * process uid, and `crypto`. It is never shipped to the browser.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConsentDrift } from "../core/drift.js";
import type { MemoryTopology, ServiceAction } from "../core/types.js";

/** The environment variable that overrides the default config location. */
const CONFIG_ENV = "STEWARD_CONFIG";

/** The collector command + its cadence, as recorded in `steward.json`. */
export interface HostCollectorConfig {
  /** Argv of the long-lived collector: `command[0]` is the program, rest args. */
  command: string[];
  /** The collector's declared emit cadence, ms — the base for the staleness clock. */
  intervalMs: number;
}

/**
 * The service-control commands, as recorded in `steward.json`. All three are
 * required together: a machine that can only be restarted is expressed by
 * consenting to the restart command alone, not by declaring a partial block —
 * that keeps "what this machine can do" (the argv) apart from "what the
 * operator approved" (the consent map).
 */
export interface ServiceControlConfig {
  start: string[];
  stop: string[];
  restart: string[];
}

/**
 * What `/initialize-steward` observed about how `llama-server` is launched on
 * this machine — the baseline the live process is re-checked against on every
 * snapshot (see `server/drift-probe.ts`).
 *
 * It is a RECORD, not an instruction: Steward never launches anything from it
 * and it carries no consent, which is why it needs no hash. `mechanism` and
 * `label` are descriptive only (`launchd`, `gui/501/com.llamacpp.router`) and
 * exist so a later phase can point the operator at the right file to fix.
 */
export interface LlamaLaunchConfig {
  /** The argv the server was observed running with, `argv[0]` first. */
  launchArgv: string[];
  /** How it is launched (`launchd`, `systemd`, …), or `null` when unrecorded. */
  mechanism: string | null;
  /** The job/unit label, or `null` when unrecorded. */
  label: string | null;
}

/**
 * Where this machine's `llama-server` writes its combined stdout/stderr, as
 * recorded by `/initialize-steward`.
 *
 * It is a path Steward READS, never a command it runs, so — unlike the collector
 * and the control commands — it carries no consent hash: there is nothing here to
 * approve. The file's ownership gate still applies, because it is the same file
 * as everything else in this artifact.
 */
export interface LogFileConfig {
  /** Absolute path to the log file to follow. */
  path: string;
}

/**
 * The slice of `steward.json` this phase reads. Unknown keys are ignored so the
 * artifact can carry fields later phases own without this reader rejecting them.
 */
export interface StewardConfig {
  /** Static machine memory layout — picks the HOST gauge SET, not a reading. */
  memoryTopology: MemoryTopology;
  hostCollector: HostCollectorConfig;
  /**
   * The recorded launch argv, or `null` when the artifact does not carry one
   * (or carries an ill-formed one). Optional on purpose: drift re-validation is
   * then simply unavailable — the dashboard says nothing about launch flags
   * rather than refusing the whole config over a block nothing else depends on.
   */
  llama: LlamaLaunchConfig | null;
  /**
   * Start/stop/restart commands, or `null` when the artifact declares none (or
   * declares them ill-formed). Control is optional: a machine may have metrics
   * configured and no control, which is a dashboard state — a setup
   * affordance — not a reason to reject the whole config.
   */
  control: ServiceControlConfig | null;
  /**
   * The log file to follow, or `null` when the artifact records none (or records
   * an ill-formed one). Optional like the blocks above: a machine with no log
   * path recorded still gets every other panel, and Steward falls back to
   * `STEWARD_LOG_FILE` and the platform convention before giving up.
   */
  log: LogFileConfig | null;
  /** sha256(command) → `true` for each command the operator has consented to run. */
  consent: Record<string, true>;
}

/** The control actions, in the order the dashboard renders them. */
const CONTROL_ACTIONS: readonly ServiceAction[] = ["start", "stop", "restart"];

export interface ReadStewardConfigOptions {
  /**
   * Overrides the resolved config path (tests point this at a temp file). When
   * omitted, `STEWARD_CONFIG` then `~/.config/steward/steward.json` is used.
   */
  path?: string;
  /** The current uid, for the ownership check. Injected in tests; defaults to `process.getuid`. */
  uid?: number | null;
  /** Sink for the security warnings. Injected in tests; defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/** The path the config is read from, honouring `STEWARD_CONFIG`. */
export function stewardConfigPath(): string {
  const override = process.env[CONFIG_ENV];
  if (override !== undefined && override.trim() !== "") return override;
  return join(homedir(), ".config", "steward", "steward.json");
}

/** The current uid, or `null` on a platform without one (Windows). */
function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/**
 * The canonical hash of a collector command, for the consent map: the sha256 of
 * the argv joined on single spaces. The space join keeps the hash reproducible
 * by hand (`printf '%s' 'macmon pipe -s 0 -i 1000' | shasum -a 256`) for a
 * maintainer writing `steward.json` to test live; the `/initialize-steward`
 * skill computes the same hash when it records consent. It trades a strict argv
 * canonicalisation for that reproducibility — the gate's job is operator
 * awareness of what runs, and consent still re-prompts whenever the command
 * string changes.
 */
export function hashCommand(command: string[]): string {
  return createHash("sha256").update(command.join(" ")).digest("hex");
}

/**
 * True when the config's collector command carries a matching entry in the
 * consent map. The collector must NOT be spawned otherwise: consent is bound to
 * the exact command, so a rewritten or repo-dropped command falls through here
 * and re-prompts (via the skill) rather than running under a stale approval.
 */
export function hostCollectorConsented(config: StewardConfig): boolean {
  return config.consent[hashCommand(config.hostCollector.command)] === true;
}

/**
 * True when the config declares a command for `action` AND that exact command
 * carries a matching entry in the consent map. The same gate the collector
 * passes through, applied per action: consenting to `restart` does not consent
 * to `stop`, and rewriting a declared command drops it back out of the
 * dashboard until the operator approves the new one.
 */
export function controlConsented(config: StewardConfig, action: ServiceAction): boolean {
  if (config.control === null) return false;
  return config.consent[hashCommand(config.control[action])] === true;
}

/**
 * The control commands the operator has consented to, keyed by action — the
 * exact set the executor is built from. An action that is declared but not
 * consented is simply absent, so it is never offered and never runs.
 */
export function consentedControls(config: StewardConfig): Partial<Record<ServiceAction, string[]>> {
  const commands: Partial<Record<ServiceAction, string[]>> = {};
  if (config.control === null) return commands;
  for (const action of CONTROL_ACTIONS) {
    if (controlConsented(config, action)) commands[action] = [...config.control[action]];
  }
  return commands;
}

/**
 * The commands this config declares but has NOT approved — the second producer
 * of the dashboard's drift notice.
 *
 * A declared, unapproved command is Steward's security gate doing its job: the
 * collector is not spawned, the button is not offered. But silence makes the
 * resulting inert panel look identical to one that was never set up, and an
 * operator who edited a command in `steward.json` (invalidating its hash) has no
 * way to learn that is why their gauges went dark. This turns that into
 * something the UI can say out loud.
 */
export function consentDrift(config: StewardConfig): ConsentDrift {
  return {
    hostCollector: !hostCollectorConsented(config),
    controls:
      config.control === null
        ? []
        : CONTROL_ACTIONS.filter((action) => !controlConsented(config, action)),
  };
}

/** True for a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the collector block, or `null` when it is missing/ill-formed. */
function parseHostCollector(value: unknown): HostCollectorConfig | null {
  if (!isRecord(value)) return null;
  const { command, intervalMs } = value;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === "string")
  ) {
    return null;
  }
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return null;
  }
  return { command: [...(command as string[])], intervalMs };
}

/** A non-empty argv of strings, or `null`. */
function parseCommand(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((part) => typeof part === "string")) return null;
  return [...(value as string[])];
}

/** An optional descriptive string, trimmed, or `null` when absent/empty. */
function parseLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Validates the optional `llama` block. Only `launchArgv` is load-bearing — it
 * is the baseline the drift check diffs against — so a block without a usable
 * one yields `null` (drift checking unavailable) rather than a half-recorded
 * baseline that could report a mismatch against nothing.
 */
function parseLlama(value: unknown): LlamaLaunchConfig | null {
  if (!isRecord(value)) return null;
  const launchArgv = parseCommand(value.launchArgv);
  if (launchArgv === null) return null;
  return {
    launchArgv,
    mechanism: parseLabel(value.mechanism),
    label: parseLabel(value.label),
  };
}

/**
 * Validates the optional `control` block. All three commands are required
 * within it, so a half-written block yields `null` (control unconfigured)
 * rather than a set of actions the operator never fully declared.
 */
function parseControl(value: unknown): ServiceControlConfig | null {
  if (!isRecord(value)) return null;
  const start = parseCommand(value.start);
  const stop = parseCommand(value.stop);
  const restart = parseCommand(value.restart);
  if (start === null || stop === null || restart === null) return null;
  return { start, stop, restart };
}

/**
 * Validates the optional `log` block. Only a non-empty string path is usable;
 * anything else yields `null` and the discovery precedence takes over, rather
 * than handing the tailer a path it cannot watch.
 */
function parseLog(value: unknown): LogFileConfig | null {
  if (!isRecord(value)) return null;
  const path = parseLabel(value.path);
  return path === null ? null : { path };
}

/** Validates the consent map, keeping only `true` entries. */
function parseConsent(value: unknown): Record<string, true> {
  if (!isRecord(value)) return {};
  const consent: Record<string, true> = {};
  for (const [key, granted] of Object.entries(value)) {
    if (granted === true) consent[key] = true;
  }
  return consent;
}

/**
 * Reads the config artifact, returning a validated {@link StewardConfig} or
 * `null`. Returns `null` — quietly for a plain absence, with a warning for a
 * refusal — when the file does not exist, cannot be read, is not owned by the
 * current user, is world-writable, is not valid JSON, or fails schema
 * validation. Never throws.
 */
export function readStewardConfig(options: ReadStewardConfigOptions = {}): StewardConfig | null {
  const path = options.path ?? stewardConfigPath();
  const uid = options.uid !== undefined ? options.uid : currentUid();
  const warn = options.warn ?? ((message: string) => console.warn(message));

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    // Absent (or unreadable) is the normal cold-start case, not a warning.
    return null;
  }

  // Ownership: a config owned by another user could have been planted; refuse
  // it. Skipped only where the platform has no uid (Windows).
  if (uid !== null && stat.uid !== uid) {
    warn(`[steward] ignoring ${path}: not owned by the current user`);
    return null;
  }
  // World-writable means anyone on the box can rewrite the command Steward runs.
  if ((stat.mode & 0o002) !== 0) {
    warn(`[steward] ignoring ${path}: it is world-writable`);
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(`[steward] ignoring ${path}: it is not valid JSON`);
    return null;
  }
  if (!isRecord(parsed)) {
    warn(`[steward] ignoring ${path}: it is not a JSON object`);
    return null;
  }

  const memoryTopology = parsed.memoryTopology;
  if (memoryTopology !== "unified" && memoryTopology !== "discrete") {
    warn(`[steward] ignoring ${path}: memoryTopology must be "unified" or "discrete"`);
    return null;
  }

  const hostCollector = parseHostCollector(parsed.hostCollector);
  if (hostCollector === null) {
    warn(`[steward] ignoring ${path}: hostCollector.command / intervalMs is missing or invalid`);
    return null;
  }

  // Control is optional, and a present-but-ill-formed block is worth saying out
  // loud: the operator meant to configure it and the dashboard will show the
  // setup affordance instead, which is otherwise indistinguishable from having
  // never configured it at all.
  const control = parseControl(parsed.control);
  if (parsed.control !== undefined && control === null) {
    warn(`[steward] ${path}: ignoring control — it needs a start, stop and restart command`);
  }

  // The launch record is optional too, and losing it costs only the drift
  // check — but silently, so a block that is present and unusable says so:
  // otherwise the dashboard would look exactly like a compliant machine.
  const llama = parseLlama(parsed.llama);
  if (parsed.llama !== undefined && llama === null) {
    warn(`[steward] ${path}: ignoring llama — it needs a non-empty launchArgv array of strings`);
  }

  // The log path is optional as well, and losing it costs only the console —
  // but again, say so: a present-but-unusable block would otherwise look exactly
  // like a machine that never recorded one.
  const log = parseLog(parsed.log);
  if (parsed.log !== undefined && log === null) {
    warn(`[steward] ${path}: ignoring log — it needs a non-empty path string`);
  }

  return {
    memoryTopology,
    hostCollector,
    llama,
    control,
    log,
    consent: parseConsent(parsed.consent),
  };
}
