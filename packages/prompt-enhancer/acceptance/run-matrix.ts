/**
 * Acceptance runner for @jmcombs/pi-prompt-enhancer.
 *
 * **Test scaffolding, not shipped code** (excluded from `package.json` `files`).
 *
 * Every result this produces comes from the real `pi` binary with the real
 * extension loaded — never from importing `index.ts` and calling a model
 * directly. Per (model, fixture) cell it spawns
 *
 *   pi --mode rpc --no-session --offline -ne -e ./packages/prompt-enhancer \
 *      --provider <provider> --model <id>
 *
 * writes one `{"type":"prompt","message":"/prompt_enhance <fixture>"}` line,
 * **holds stdin open**, reads the stdout JSONL stream and scores the rewrite
 * with `classifyEnhancement`.
 *
 * RPC transport contract (measured; see acceptance/README.md before changing
 * any of this):
 *
 *   1. `pi --mode rpc` aborts in-flight work on stdin EOF. Closing stdin after
 *      the write scores zero rewrites — or scores the pre-replace echo as a
 *      rewrite, a false PASS. Stdin stays open until the call is finished.
 *   2. `{"type":"response","command":"prompt"}` is the command ACK, not a
 *      terminator. It is the LAST line for a slash command, but it arrives
 *      before the enhancement finishes for a model prompt.
 *   3. The FIRST `set_editor_text` is the pre-replace echo (byte-equal to the
 *      trimmed fixture), emitted before any model call. The rewrite is a later
 *      one; on failure the last one is the restore, which is "" in RPC.
 *   4. A slash command produces no agent-loop events, so their absence proves
 *      nothing about the model call.
 *
 * Host failures are not measurements. `pi` can die before the extension runs
 * at all (a startup error such as an unknown provider), and the old runner
 * discarded the child's stderr, so such a call was scored as an enhancer
 * failure. The child's stderr is now captured to a bounded tail, and a call
 * that emitted no `set_editor_text` while `pi` exited non-zero (or printed a
 * startup-failure signature) records `verdict: "host_error"`. Those records are
 * excluded from every cell's bad/total counts and reported on their own line:
 * a cell must never be failed — or passed — by infrastructure.
 *
 * Completion rule: finished when `extension_error` is seen, OR a `response` for
 * `command:"prompt"` has been seen AND (`set_editor_text` count >= 2 OR a
 * `notify` has been seen), OR the per-call wall clock expires.
 *
 * Every call is bounded end to end by `withDeadline` — context gathering, the
 * child's whole lifetime, and the reap that follows the completion rule. See
 * acceptance/deadline.ts for the hang that motivated it. A `pi` that produces
 * no child process fails the call immediately with `spawn_failed` instead of
 * blocking the run.
 *
 * Model selection is open to contributors. With no `--model` the run uses the
 * maintainer's five default cells. `--model` (repeatable, comma-separable)
 * replaces that list with anything in the local `pi` catalog, capped at
 * `MAX_MODELS`. Every selected model is validated against `pi -ne
 * --list-models` before the first call, so a typo costs a second rather than
 * forty wasted requests.
 *
 * `BASELINE_MODEL` is the one column every run is expected to carry, so two
 * artifacts from two contributors have something in common. It is policy, not
 * scoring: nothing here or in `classify.ts` may branch on a provider, model id
 * or api when deciding a verdict (**D14**). A run without it still completes
 * and still writes an artifact; the artifact simply records that the baseline
 * was absent, plus the `--baseline-exempt` reason if one was given, and
 * `scripts/check-acceptance-artifact.mjs` surfaces both.
 *
 * Usage:
 *   npx tsx packages/prompt-enhancer/acceptance/run-matrix.ts --n 12 \
 *     --out docs/prompt-enhancer/baseline.json
 *
 *   npx tsx packages/prompt-enhancer/acceptance/run-matrix.ts --n 6 \
 *     --model anthropic/claude-haiku-4-5 --model xai/grok-4.6 \
 *     --out docs/prompt-enhancer/my-change.json
 *
 * This module is also imported by `scripts/check-acceptance-artifact.mjs` for
 * `scoreCall`, so that the re-score and the run share one decision tree rather
 * than two that can drift. `main()` therefore runs only when this file is the
 * process entry point.
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildEnhancerUserMessage, gatherEnhancerContext } from "../index.js";
import { classifyEnhancement, looksLikeHostFailure } from "./classify.js";
import { withDeadline } from "./deadline.js";

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
export const FIXTURE_DIR = path.join(HERE, "fixtures");
const EXTENSION_PATH = "./packages/prompt-enhancer";

export interface MatrixModel {
  /**
   * Unique cell key. One model id can be served over two different api paths
   * (`xai/grok-4.6` exists as both `openai-responses` and `openai-completions`),
   * so the key carries the api and the two cells can never collide.
   *
   * A cell whose api was not named is keyed on `provider/id` alone. The api is
   * a label for reading the artifact; `pi -ne --list-models` does not report
   * one, so a contributor's selection cannot invent it.
   */
  key: string;
  provider: string;
  id: string;
  api: string;
}

/**
 * The api label used when a `--model` spec named no api. Kept out of the cell
 * key so the default cells keep the keys every recorded artifact already uses.
 */
const UNSPECIFIED_API = "unspecified";

/**
 * The maintainer's default matrix: the five cells a bare run measures, with
 * this casing. Do not re-case, do not pin dated snapshots. Contributors
 * override the whole list with `--model`; these stay the default so the
 * maintainer's own workflow is unchanged by that.
 *
 * Grok runs on `xai/grok-4.6` over `openai-responses`, which is the maintainer's
 * own account and is covered by his xAI credits. An `openrouter/x-ai/grok-4.6`
 * cell was removed: it billed the maintainer directly, and the api shape it
 * covered (`openai-completions`) is already exercised by the llama.cpp cell.
 * The failure this harness was built for was a prompt problem that appeared on
 * every model and every api path, so the api shape is not the variable.
 */
const DEFAULT_MODELS: readonly MatrixModel[] = [
  {
    key: "xai/grok-4.6#openai-responses",
    provider: "xai",
    id: "grok-4.6",
    api: "openai-responses",
  },
  {
    key: "anthropic/claude-sonnet-5#anthropic-messages",
    provider: "anthropic",
    id: "claude-sonnet-5",
    api: "anthropic-messages",
  },
  {
    key: "anthropic/claude-haiku-4-5#anthropic-messages",
    provider: "anthropic",
    id: "claude-haiku-4-5",
    api: "anthropic-messages",
  },
  {
    key: "anthropic/claude-opus-5#anthropic-messages",
    provider: "anthropic",
    id: "claude-opus-5",
    api: "anthropic-messages",
  },
  {
    key: "llama.cpp/Qwen3.6-35B-A3B-Q8_0#openai-completions",
    provider: "llama.cpp",
    id: "Qwen3.6-35B-A3B-Q8_0",
    api: "openai-completions",
  },
];

/**
 * The one model every acceptance run is expected to include.
 *
 * A shared column is the only thing that makes two contributors' artifacts
 * comparable: without it, "my change is fine on my two models" and "it is fine
 * on my two other models" are two unrelated claims. `claude-haiku-4-5` is the
 * cheapest hosted cell in the default matrix, which is why it is the one asked
 * for rather than a stronger model.
 *
 * It is a *policy* requirement checked here and in
 * `scripts/check-acceptance-artifact.mjs` — never a scoring rule. Missing it
 * does not stop a run and does not change a single verdict.
 */
export const BASELINE_MODEL = "anthropic/claude-haiku-4-5";

/**
 * Ceiling on `--model` selections.
 *
 * Two reasons, both practical. Each cell multiplies the whole fixture set by
 * `n` real paid calls, and the artifact is meant to be read: a table wider than
 * five columns stops fitting on a screen and stops being reviewed. Five is what
 * the maintainer's own matrix uses, so it is a cap contributors are not
 * disadvantaged by.
 */
export const MAX_MODELS = 5;

/** Env fallback for `--baseline-exempt`, for CI or a shell profile. */
const BASELINE_EXEMPTION_ENV = "PROMPT_ENHANCER_BASELINE_EXEMPTION";

/**
 * Resolve one `--model` value.
 *
 * A value naming a default cell (by full key or by `provider/id`) resolves to
 * that cell, so its api label and key survive verbatim. Anything else is parsed
 * as `provider/id` with an optional `#api` label. Provider is split on the
 * FIRST `/`: an openrouter id is itself a path (`openrouter/z-ai/glm-5`).
 */
function parseModelSpec(value: string): MatrixModel {
  const matches = DEFAULT_MODELS.filter(
    (model) => model.key === value || `${model.provider}/${model.id}` === value,
  );
  if (matches.length === 1) return matches[0] as MatrixModel;
  if (matches.length > 1) {
    throw new Error(
      `--model ${value} is ambiguous (same id on two api paths); use one of:\n  ${matches
        .map((m) => m.key)
        .join("\n  ")}`,
    );
  }

  const hash = value.indexOf("#");
  const spec = hash >= 0 ? value.slice(0, hash) : value;
  const api = hash >= 0 ? value.slice(hash + 1) : UNSPECIFIED_API;
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1 || api.length === 0) {
    throw new Error(
      `--model ${value} is not a model spec. Use provider/id, optionally with an\n` +
        "api label: anthropic/claude-haiku-4-5, openrouter/z-ai/glm-5,\n" +
        "xai/grok-4.6#openai-responses. Run `pi -ne --list-models <search>` to see ids.",
    );
  }
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  return {
    key: api === UNSPECIFIED_API ? `${provider}/${id}` : `${provider}/${id}#${api}`,
    provider,
    id,
    api,
  };
}

/**
 * Every `provider\tid` pair the local `pi` can actually reach.
 *
 * `-ne` matches how the runner spawns `pi` for a call: with discovery off, a
 * globally installed extension's providers are not there, so validating
 * against the full catalog would green-light a model that every call then
 * fails on.
 */
async function loadModelCatalog(): Promise<Set<string>> {
  const { stdout } = await execFileAsync("pi", ["-ne", "--list-models"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const catalog = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^(\S+)\s+(\S+)(?:\s|$)/);
    if (match === null) continue;
    const [, provider, id] = match;
    if (provider === undefined || id === undefined) continue;
    // The table header, not a model.
    if (provider === "provider" && id === "model") continue;
    catalog.add(`${provider}\t${id}`);
  }
  return catalog;
}

/**
 * Fail before the first call, not after forty.
 *
 * A mistyped id is otherwise indistinguishable from a broken enhancer at the
 * end of a paid run: every call in that cell comes back `host_error` and the
 * cell reads as unmeasured.
 */
async function validateAgainstCatalog(models: readonly MatrixModel[]): Promise<void> {
  let catalog: Set<string>;
  try {
    catalog = await loadModelCatalog();
  } catch (error) {
    throw new Error(
      "Could not read the model catalog with `pi -ne --list-models`, so the\n" +
        "selection cannot be checked before the run. Fix `pi` first: every call\n" +
        `depends on it.\n  ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const missing = models.filter((model) => !catalog.has(`${model.provider}\t${model.id}`));
  if (missing.length === 0) return;
  throw new Error(
    `${missing.length} selected model(s) are not in this machine's pi catalog:\n` +
      `${missing.map((m) => `  ${m.provider}/${m.id}`).join("\n")}\n` +
      "Run `pi -ne --list-models <search>` to see the exact provider and id, and\n" +
      "check the provider's credential is configured. Nothing was called.",
  );
}

/** What the run recorded about the required baseline column. */
interface BaselinePolicy {
  /** The `provider/id` every run is expected to include. */
  model: string;
  present: boolean;
  /** Why the baseline was skipped, when it was. `null` means no reason given. */
  exemptionReason: string | null;
}

function resolveBaselinePolicy(
  models: readonly MatrixModel[],
  exemptFlag: string | undefined,
): BaselinePolicy {
  const present = models.some((model) => `${model.provider}/${model.id}` === BASELINE_MODEL);
  if (present) return { model: BASELINE_MODEL, present: true, exemptionReason: null };
  const raw = exemptFlag ?? process.env[BASELINE_EXEMPTION_ENV] ?? "";
  const reason = raw.trim();
  return {
    model: BASELINE_MODEL,
    present: false,
    exemptionReason: reason.length > 0 ? reason : null,
  };
}

export const FIXTURES = [
  "dependabot",
  "repo-question",
  "trivial",
  "out-of-scope",
  "control-token",
  "self-referential",
  // Added after the 216-call pass, for the rules that pass could not cover:
  // a pasted failing test (fenced sample preservation) and a draft full of
  // misspellings including one in a real repo path.
  "fenced-trace",
  "typo-path",
] as const;

const DEFAULT_N = 12;
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Providers run in parallel; every model and call *within* a provider stays
 * strictly sequential. Running several models of the same provider at once made
 * concurrent credential reads fail ("no API key configured for …"), which would
 * score as a `bad` call that has nothing to do with the enhancer.
 */
const DEFAULT_CONCURRENCY = 3;
/** A cell fails the run when it has more bad calls than this. */
const CELL_BAD_THRESHOLD = 0;
/** Rough tokens-per-character for the input-size report. */
const CHARS_PER_TOKEN = 4;
/** How long to keep escalating signals at a child that will not exit. */
const CHILD_SIGTERM_MS = 2_000;
const CHILD_SIGKILL_MS = 5_000;
/**
 * How long to wait for the child's `close` after the completion rule fires.
 * `close` is not guaranteed — a child whose stdio is inherited by a survivor
 * never emits it — so the reap gives up rather than hanging the run. The
 * per-call deadline still covers this window; this is the tighter of the two.
 */
const CHILD_REAP_MS = 8_000;
/**
 * How much of the child's stderr to keep on each record. Enough to hold a
 * startup error and its stack, bounded so a chatty child cannot bloat the
 * artifact. The tail is kept rather than the head: the fatal line comes last.
 */
const STDERR_TAIL_CHARS = 4_000;

/**
 * Progress output that survives redirection.
 *
 * When stdout is a pipe (`… > run.log`, `… | tee`) Node buffers writes and
 * flushes them on the event loop, so a stalled run shows nothing at all — which
 * is how a 14-minute hang looked like a silent process. `writeSync` on fd 1
 * puts each line out as it happens. A non-blocking pipe can refuse the
 * synchronous write (EAGAIN), so the async path stays as a fallback.
 */
function progress(line: string): void {
  try {
    writeSync(1, `${line}\n`);
  } catch {
    process.stdout.write(`${line}\n`);
  }
}

interface CallRecord {
  model: string;
  provider: string;
  modelId: string;
  /** The provider api path this cell exercises. */
  api: string;
  fixture: string;
  iteration: number;
  startedAt: string;
  durationMs: number;
  /** Locally measured context gathering (not observable over RPC). */
  contextMs: number;
  inputChars: number;
  inputTokensEstimate: number;
  original: string;
  enhanced: string;
  /** RPC does not surface the provider stop reason for an out-of-band call. */
  stopReason: string;
  setEditorTextCount: number;
  notifies: string[];
  extensionError?: string;
  /** Set when `pi` never produced a child process for this call. */
  spawnError?: string;
  /** Bounded tail of the child's stderr. Omitted when it said nothing. */
  stderrTail?: string;
  timedOut: boolean;
  /** Where the wall clock caught the call. Only meaningful when `timedOut`. */
  stalledPhase?: "context" | "call";
  exitCode: number | null;
  /**
   * `"host_error"` means the host failed and this call is not a measurement —
   * never that the enhancer misbehaved. Such records are excluded from cell
   * counts entirely.
   */
  verdict: "good" | "bad" | "host_error";
  codes: string[];
  /**
   * Non-verdict observations from the classifier. Reported and recorded, never
   * counted against a cell. See `ClassifyResult.signals`.
   */
  signals: string[];
}

interface CliOptions {
  n: number;
  models: MatrixModel[];
  fixtures: string[];
  out: string;
  timeoutMs: number;
  concurrency: number;
  /** Recorded reason for running without `BASELINE_MODEL`; undefined when none. */
  baselineExempt: string | undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    n: DEFAULT_N,
    models: [],
    fixtures: [],
    out: path.join("docs", "prompt-enhancer", "acceptance.json"),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    concurrency: DEFAULT_CONCURRENCY,
    baselineExempt: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const requireValue = (): string => {
      if (value === undefined) throw new Error(`${flag} requires a value`);
      i += 1;
      return value;
    };
    switch (flag) {
      case "--n":
        options.n = Number.parseInt(requireValue(), 10);
        break;
      case "--model":
      case "--models":
        for (const spec of requireValue().split(",")) {
          const trimmed = spec.trim();
          if (trimmed.length > 0) options.models.push(parseModelSpec(trimmed));
        }
        break;
      case "--baseline-exempt":
        options.baselineExempt = requireValue();
        break;
      case "--fixture":
        options.fixtures.push(requireValue());
        break;
      case "--out":
        options.out = requireValue();
        break;
      case "--timeout-ms":
        options.timeoutMs = Number.parseInt(requireValue(), 10);
        break;
      case "--concurrency":
        options.concurrency = Number.parseInt(requireValue(), 10);
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  if (!Number.isInteger(options.n) || options.n < 1)
    throw new Error("--n must be a positive integer");
  for (const fixture of options.fixtures) {
    if (!(FIXTURES as readonly string[]).includes(fixture)) {
      throw new Error(`--fixture ${fixture} is unknown: ${FIXTURES.join(", ")}`);
    }
  }

  // Repeating a spec is a typo, not a request for two identical columns.
  const seen = new Map<string, MatrixModel>();
  for (const model of options.models) seen.set(model.key, model);
  options.models = [...seen.values()];
  if (options.models.length > MAX_MODELS) {
    throw new Error(
      `${options.models.length} models selected; the cap is ${MAX_MODELS}.\n` +
        "  Every cell is a full fixture set × n of real paid calls, and an artifact\n" +
        "  wider than five columns stops being readable, so it stops being reviewed.\n" +
        `  Selected:\n${options.models.map((m) => `    ${m.key}`).join("\n")}`,
    );
  }
  return options;
}

/** `sha256:<hex>` over a file's raw bytes. */
async function hashFile(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Digest of each fixture file **as it was on disk for this run**, so a run
 * against a locally weakened fixture is visible in the artifact. Records also
 * carry `original`, which is the same file trimmed; the check script compares
 * both against the committed files, and that comparison is the authoritative
 * one because it does not trust the artifact.
 */
async function hashFixtureFiles(names: readonly string[]): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const name of names) {
    digests[name] = await hashFile(path.join(FIXTURE_DIR, `${name}.txt`));
  }
  return digests;
}

/** Digests of the two files that decide a verdict, for reader orientation. */
async function hashHarnessFiles(): Promise<Record<string, string>> {
  const files = ["run-matrix.ts", "classify.ts"];
  const digests: Record<string, string> = {};
  for (const file of files) {
    digests[`acceptance/${file}`] = await hashFile(path.join(HERE, file));
  }
  return digests;
}

async function readFixtures(names: readonly string[]): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  for (const name of names) {
    const text = await fs.readFile(path.join(FIXTURE_DIR, `${name}.txt`), "utf8");
    entries.set(name, text.trim());
  }
  return entries;
}

/**
 * Paths that really exist: tracked files plus untracked-but-present ones. The
 * enhancer's project tree shows untracked files too, so scoring against tracked
 * files alone marks a correctly-named new file as fabricated.
 */
async function readKnownPaths(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    {
      cwd: REPO_ROOT,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return stdout.split("\n").filter((line) => line.length > 0);
}

interface RpcOutcome {
  editorTexts: string[];
  notifies: string[];
  /** Bounded tail of the child's stderr; "" when it said nothing. */
  stderrTail: string;
  extensionError?: string;
  spawnError?: string;
  timedOut: boolean;
  exitCode: number | null;
}

/**
 * Drive one `/prompt_enhance` through the real `pi` binary, recording the raw
 * transport observations into `outcome` as they arrive. Stdin is held open
 * until the completion rule fires.
 *
 * The caller owns `outcome` and the wall clock: this function has no timer of
 * its own. Aborting `signal` kills the child and settles immediately, and
 * because every observation is written into the caller's object as it happens,
 * a call abandoned at its deadline still reports what it saw before stalling.
 */
function driveOneCall(
  provider: string,
  modelId: string,
  promptText: string,
  signal: AbortSignal,
  outcome: RpcOutcome,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const child = spawn(
      "pi",
      [
        "--mode",
        "rpc",
        "--no-session",
        "--offline",
        "-ne",
        "-e",
        EXTENSION_PATH,
        "--provider",
        provider,
        "--model",
        modelId,
      ],
      { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );

    let sawPromptResponse = false;
    let settled = false;
    let tearingDown = false;
    let buffer = "";

    function done(): void {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    }

    /**
     * Wind the child down after the completion rule (or an abort). Bounded on
     * both ends: signals escalate at a child that will not exit, and the reap
     * gives up rather than waiting on a `close` that may never come — the hang
     * the old `finish()` could sit in with its own timer already cleared.
     */
    function finish(immediate = false): void {
      if (tearingDown) {
        if (immediate) done();
        return;
      }
      tearingDown = true;
      try {
        child.stdin.end();
      } catch {
        // The child may already be gone; nothing to flush.
      }
      if (immediate) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already reaped.
        }
        done();
        return;
      }
      // Nudge, then force, a child that does not exit on stdin EOF.
      const term = setTimeout(() => child.kill("SIGTERM"), CHILD_SIGTERM_MS);
      const hardKill = setTimeout(() => child.kill("SIGKILL"), CHILD_SIGKILL_MS);
      const giveUp = setTimeout(() => {
        done();
      }, CHILD_REAP_MS);
      const clearAll = (): void => {
        clearTimeout(term);
        clearTimeout(hardKill);
        clearTimeout(giveUp);
      };
      child.once("close", (code) => {
        clearAll();
        outcome.exitCode = code;
        done();
      });
    }

    function onAbort(): void {
      outcome.timedOut = true;
      finish(true);
    }

    // Registered before anything can settle the call. A failed spawn emits
    // `error` asynchronously, and an unlistened `error` on a ChildProcess is an
    // uncaught exception that kills the run mid-matrix.
    child.on("error", (error: Error) => {
      outcome.spawnError ??= `pi failed to start: ${error.message}`;
      done();
    });
    // A child that dies mid-write turns the pipe into an EPIPE `error` event,
    // which is likewise fatal when unlistened.
    child.stdin?.on("error", () => {
      /* handled by the completion rule and the deadline */
    });

    // Fail fast rather than block the run: no pid means `pi` never started, so
    // there is nothing to wait for and nothing a timeout would ever recover.
    if (child.pid === undefined) {
      outcome.spawnError = "pi produced no child process (spawn returned no pid)";
      done();
      return;
    }
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    function handleEvent(event: Record<string, unknown>): void {
      if (event.type === "extension_error") {
        outcome.extensionError = String(event.error ?? "unknown extension error");
        finish();
        return;
      }
      if (event.type === "response" && event.command === "prompt") {
        sawPromptResponse = true;
      }
      if (event.type === "extension_ui_request") {
        if (event.method === "set_editor_text") {
          outcome.editorTexts.push(typeof event.text === "string" ? event.text : "");
        } else if (event.method === "notify") {
          outcome.notifies.push(typeof event.message === "string" ? event.message : "");
        }
      }
      if (sawPromptResponse && (outcome.editorTexts.length >= 2 || outcome.notifies.length > 0)) {
        finish();
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          try {
            handleEvent(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // Non-JSON chatter on stdout is not part of the protocol.
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    // Keep a bounded tail of stderr (and keep draining it, so a chatty child
    // never blocks on a full pipe). Without this, a `pi` that failed at startup
    // left no trace at all and its call scored as an enhancer failure.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      outcome.stderrTail = (outcome.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on("close", (code) => {
      outcome.exitCode = code;
      done();
    });

    try {
      child.stdin.write(`${JSON.stringify({ type: "prompt", message: promptText })}\n`);
    } catch (error) {
      outcome.spawnError ??= `could not write to pi stdin: ${String(error)}`;
      finish(true);
    }
    // Deliberately NOT calling child.stdin.end(): EOF aborts the in-flight turn.
  });
}

/**
 * Everything a verdict is allowed to depend on. Deliberately carries no
 * provider, model id or api (**D14**): the same rules score every cell.
 */
export interface ScoreInput {
  original: string;
  enhanced: string;
  stopReason: string;
  knownPaths: readonly string[];
  setEditorTextCount: number;
  extensionError?: string;
  spawnError?: string;
  stderrTail?: string;
  timedOut: boolean;
  exitCode: number | null;
}

export interface ScoreOutput {
  verdict: "good" | "bad" | "host_error";
  codes: string[];
  signals: string[];
}

/**
 * The whole verdict decision for one call: the infrastructure branches the
 * runner owns, then `classifyEnhancement` for anything that actually reached
 * the enhancer.
 *
 * It is exported and pure so that `scripts/check-acceptance-artifact.mjs` can
 * re-derive a stored record's verdict from the record's own fields. Two copies
 * of this ladder would drift, and a re-score that drifts from the runner proves
 * nothing.
 */
export function scoreCall(input: ScoreInput): ScoreOutput {
  if (input.spawnError !== undefined) {
    // `pi` never started. That is the host failing, not the enhancer.
    return { verdict: "host_error", codes: ["spawn_failed"], signals: [] };
  }
  if (input.extensionError !== undefined) {
    return { verdict: "bad", codes: ["crash"], signals: [] };
  }
  if (input.timedOut) {
    return { verdict: "bad", codes: ["timeout"], signals: [] };
  }
  if (
    looksLikeHostFailure({
      exitCode: input.exitCode,
      setEditorTextCount: input.setEditorTextCount,
      stderrTail: input.stderrTail ?? "",
    })
  ) {
    // `pi` died before the extension emitted even its pre-replace echo, so no
    // enhancer code ran. Not scoreable in either direction.
    return { verdict: "host_error", codes: ["host_error"], signals: [] };
  }
  const classified = classifyEnhancement({
    original: input.original,
    enhanced: input.enhanced,
    stopReason: input.stopReason,
    knownPaths: input.knownPaths,
    setEditorTextCount: input.setEditorTextCount,
  });
  return { verdict: classified.verdict, codes: classified.codes, signals: classified.signals };
}

async function runCell(
  model: MatrixModel,
  fixture: string,
  fixtureText: string,
  iteration: number,
  knownPaths: readonly string[],
  timeoutMs: number,
): Promise<CallRecord> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const outcome: RpcOutcome = {
    editorTexts: [],
    notifies: [],
    stderrTail: "",
    timedOut: false,
    exitCode: null,
  };
  let contextMs = 0;
  let inputChars = 0;
  let stalledPhase: "context" | "call" = "context";

  // One deadline over the whole call. The old timer covered only the child's
  // lifetime, so a stall in context gathering — or in the reap after the
  // completion rule — was bounded by nothing at all.
  const bounded = await withDeadline(timeoutMs, async (signal) => {
    // Locally measured: the RPC stream carries no timing or token counts for an
    // out-of-band completion, so context cost is measured with the shipped
    // helpers. This is a diagnostic, never an acceptance verdict.
    const contextStart = Date.now();
    const context = await gatherEnhancerContext(fixtureText, REPO_ROOT, signal);
    contextMs = Date.now() - contextStart;
    inputChars = buildEnhancerUserMessage(fixtureText, context).length;
    stalledPhase = "call";
    await driveOneCall(model.provider, model.id, `/prompt_enhance ${fixtureText}`, signal, outcome);
  });
  if (!bounded.ok) outcome.timedOut = true;
  const durationMs = Date.now() - started;

  const texts = outcome.editorTexts;
  const enhanced = texts.length > 1 ? (texts[texts.length - 1] ?? "") : (texts[0] ?? "");
  const stopReason = "unknown";

  const { verdict, codes, signals } = scoreCall({
    original: fixtureText,
    enhanced,
    stopReason,
    knownPaths,
    setEditorTextCount: texts.length,
    ...(outcome.extensionError !== undefined ? { extensionError: outcome.extensionError } : {}),
    ...(outcome.spawnError !== undefined ? { spawnError: outcome.spawnError } : {}),
    stderrTail: outcome.stderrTail,
    timedOut: outcome.timedOut,
    exitCode: outcome.exitCode,
  });

  return {
    model: model.key,
    provider: model.provider,
    modelId: model.id,
    api: model.api,
    fixture,
    iteration,
    startedAt,
    durationMs,
    contextMs,
    inputChars,
    inputTokensEstimate: Math.round(inputChars / CHARS_PER_TOKEN),
    original: fixtureText,
    enhanced,
    stopReason,
    setEditorTextCount: texts.length,
    notifies: outcome.notifies,
    ...(outcome.extensionError !== undefined ? { extensionError: outcome.extensionError } : {}),
    ...(outcome.spawnError !== undefined ? { spawnError: outcome.spawnError } : {}),
    ...(outcome.stderrTail.length > 0 ? { stderrTail: outcome.stderrTail } : {}),
    timedOut: outcome.timedOut,
    ...(outcome.timedOut ? { stalledPhase } : {}),
    exitCode: outcome.exitCode,
    verdict,
    codes,
    signals,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/**
 * Print the per-cell table and return true when the run must exit non-zero.
 *
 * Host failures never enter a cell's counts. They are not evidence about the
 * enhancer, so they can neither fail a cell nor pass one: they are subtracted
 * from the denominator and reported on their own line. A cell left with no
 * scoreable call at all is *unmeasured*, which also fails the run — silence
 * from infrastructure must never read as a green cell.
 */
function printSummary(records: CallRecord[], models: MatrixModel[], fixtures: string[]): boolean {
  const keys = models.map((model) => model.key);
  const width = Math.max(...keys.map((key) => key.length), 5) + 2;
  const columns = fixtures.map((f) => f.padStart(Math.max(f.length, 7)));
  const scored = records.filter((r) => r.verdict !== "host_error");
  const hostErrors = records.filter((r) => r.verdict === "host_error");
  progress("");
  progress(`bad/total per cell (${scored.length} scored calls of ${records.length})`);
  progress(`${"model".padEnd(width)}${columns.join("  ")}`);

  let anyOverThreshold = false;
  let anyUnmeasured = false;
  for (const key of keys) {
    const cells: string[] = [];
    for (const fixture of fixtures) {
      const cell = scored.filter((r) => r.model === key && r.fixture === fixture);
      const bad = cell.filter((r) => r.verdict === "bad").length;
      if (bad > CELL_BAD_THRESHOLD) anyOverThreshold = true;
      if (cell.length === 0) anyUnmeasured = true;
      cells.push(`${bad}/${cell.length}`.padStart(Math.max(fixture.length, 7)));
    }
    progress(`${key.padEnd(width)}${cells.join("  ")}`);
  }

  const codeCounts = new Map<string, number>();
  for (const record of scored) {
    for (const code of record.codes) codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
  }

  // Signals are printed next to the codes and counted nowhere else: they exist
  // to be read, not to decide anything.
  const signalCounts = new Map<string, number>();
  for (const record of scored) {
    for (const signal of record.signals) {
      signalCounts.set(signal, (signalCounts.get(signal) ?? 0) + 1);
    }
  }
  const signalSummary =
    signalCounts.size === 0
      ? "none"
      : [...signalCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([signal, count]) => `${signal}=${count}`)
          .join(", ");
  const codeSummary =
    codeCounts.size === 0
      ? "none"
      : [...codeCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([code, count]) => `${code}=${count}`)
          .join(", ");

  const hostErrorCells = new Map<string, number>();
  for (const record of hostErrors) {
    const cell = `${record.model} | ${record.fixture}`;
    hostErrorCells.set(cell, (hostErrorCells.get(cell) ?? 0) + 1);
  }
  const hostErrorSummary =
    hostErrors.length === 0
      ? "none"
      : `${hostErrors.length} (${[...hostErrorCells.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([cell, count]) => `${cell} ×${count}`)
          .join("; ")})`;

  const maxEnhancedLength = records.reduce((max, r) => Math.max(max, r.enhanced.length), 0);
  const contextP95 = percentile(
    records.map((r) => r.contextMs),
    95,
  );
  const meanInputTokens =
    records.length === 0
      ? 0
      : Math.round(records.reduce((sum, r) => sum + r.inputTokensEstimate, 0) / records.length);

  progress("");
  progress(`bad codes:                       ${codeSummary}`);
  progress(`signals (not verdicts):          ${signalSummary}`);
  progress(`host errors (not measurements):  ${hostErrorSummary}`);
  progress(`max enhanced.length:             ${maxEnhancedLength}`);
  progress(`context gathering p95 (local):   ${contextP95} ms`);
  progress(`mean input tokens (local est.):  ${meanInputTokens}`);
  progress(
    `call duration p50/p95:           ${percentile(
      records.map((r) => r.durationMs),
      50,
    )} / ${percentile(
      records.map((r) => r.durationMs),
      95,
    )} ms`,
  );
  if (anyUnmeasured) {
    progress("");
    progress("FAIL: at least one cell has no scoreable call — it was not measured, not passed.");
  }
  return anyOverThreshold || anyUnmeasured;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const models = options.models.length > 0 ? options.models : [...DEFAULT_MODELS];
  const fixtureNames = options.fixtures.length > 0 ? options.fixtures : [...FIXTURES];
  const fixtures = await readFixtures(fixtureNames);

  // Before anything is spawned or paid for.
  await validateAgainstCatalog(models);

  const baseline = resolveBaselinePolicy(models, options.baselineExempt);
  if (!baseline.present) {
    // Loud, and in the artifact, but never a block: a contributor with one
    // provider still has a run worth reading.
    progress("");
    progress(`WARNING: the baseline model ${baseline.model} is not in this run.`);
    progress(
      baseline.exemptionReason === null
        ? '  No exemption reason recorded. Pass --baseline-exempt "<why>" so the artifact\n' +
            "  says why, or the maintainer has to ask."
        : `  Recorded exemption: ${baseline.exemptionReason}`,
    );
    progress("  This run's numbers are not directly comparable with other contributors'.");
    progress("");
  }

  const outPath = path.resolve(REPO_ROOT, options.out);
  // Crash-safe, and the only progress a redirected run can be watched through:
  // `--out X.json` streams every finished call into `X.json.partial.jsonl` next
  // to it, so `tail -f` works while the run is going. It is created before the
  // first call and removed on success, so the project tree every call sees is
  // the same one. The path is added to `knownPaths` below: the runner's own
  // scratch file must never score as a fabricated path.
  const partialPath = `${outPath}.partial.jsonl`;
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(partialPath, "");

  const knownPaths = [...(await readKnownPaths()), path.relative(REPO_ROOT, partialPath)];

  const total = models.length * fixtureNames.length * options.n;
  progress(
    `Running ${total} calls: ${models.length} models × ${fixtureNames.length} fixtures × n=${options.n}`,
  );
  progress(`Per-call deadline: ${options.timeoutMs} ms · progress stream: ${partialPath}`);

  const records: CallRecord[] = [];
  let completed = 0;

  const runModel = async (model: MatrixModel): Promise<void> => {
    for (const fixture of fixtureNames) {
      const text = fixtures.get(fixture);
      if (text === undefined) continue;
      for (let iteration = 1; iteration <= options.n; iteration += 1) {
        const record = await runCell(
          model,
          fixture,
          text,
          iteration,
          knownPaths,
          options.timeoutMs,
        );
        records.push(record);
        await fs.appendFile(partialPath, `${JSON.stringify(record)}\n`);
        completed += 1;
        progress(
          `[${completed}/${total}] ${record.model} ${record.fixture} #${record.iteration} ` +
            `${record.verdict}${record.codes.length > 0 ? ` (${record.codes.join(",")})` : ""} ` +
            `${record.durationMs}ms`,
        );
      }
    }
  };

  // One queue entry per provider, so same-provider models never overlap.
  const providers = [...new Set(models.map((model) => model.provider))];
  const queue = providers.map((provider) => models.filter((model) => model.provider === provider));
  const workerCount = Math.min(Math.max(1, options.concurrency), queue.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (let group = queue.shift(); group !== undefined; group = queue.shift()) {
      for (const model of group) await runModel(model);
    }
  });
  await Promise.all(workers);

  const overThreshold = printSummary(records, models, fixtureNames);

  await fs.writeFile(
    outPath,
    `${JSON.stringify(
      {
        startedAt: records[0]?.startedAt ?? new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        transport: "pi --mode rpc --no-session --offline -ne -e ./packages/prompt-enhancer",
        models: models.map((model) => model.key),
        fixtures: fixtureNames,
        n: options.n,
        cellBadThreshold: CELL_BAD_THRESHOLD,
        baseline,
        // Self-attested, so informational only: a fabricated artifact would
        // simply carry the right digests. They tell a maintainer at a glance
        // which harness produced a *good-faith* run. The re-score in
        // `scripts/check-acceptance-artifact.mjs` is what actually proves it.
        harness: await hashHarnessFiles(),
        // Recorded so the re-score reproduces `fabricated_path` exactly. It is
        // repo state, not model output: without it the maintainer scores
        // against his own working tree and every path the contributor added
        // reads as fabricated.
        knownPaths,
        fixtureDigests: await hashFixtureFiles(fixtureNames),
        records,
      },
      null,
      2,
    )}\n`,
  );
  await fs.rm(partialPath, { force: true });
  progress(`\nWrote ${records.length} records to ${outPath}`);
  progress(
    baseline.present
      ? `baseline ${baseline.model}: present`
      : `baseline ${baseline.model}: ABSENT (${baseline.exemptionReason ?? "no reason recorded"})`,
  );
  progress(`Verify with: npm run check:acceptance-artifact -- ${options.out}`);

  process.exitCode = overThreshold ? 1 : 0;
}

/**
 * Run only as the process entry point. `scripts/check-acceptance-artifact.mjs`
 * imports `scoreCall` from here, and importing a module must not start a
 * 240-call paid run.
 */
const INVOKED_DIRECTLY =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (INVOKED_DIRECTLY) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
