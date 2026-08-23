/**
 * Acceptance-only classifier for prompt-enhancer rewrites.
 *
 * **Test scaffolding, not shipped code.** This file is deliberately over-strict:
 * it scores responses in an offline corpus where a false positive costs a
 * re-read and a false negative costs a wrong conclusion. It must never be wired
 * into the extension as a runtime validator — shipping this ruleset would
 * reproduce the meta-text false-positive class the project already rejected.
 *
 * It is excluded from the published tarball: `package.json` `files` lists only
 * `index.ts`, `auto.ts`, `widget.ts`, `README.md`, `LICENSE`.
 */

export interface ClassifyInput {
  /** The prompt the user typed, before enhancement. */
  original: string;
  /** The final editor text the extension produced (the rewrite candidate). */
  enhanced: string;
  /** Provider stop reason, or "unknown" when the transport cannot see it. */
  stopReason: string;
  /** Repository paths that really exist (the runner passes `git ls-files`). */
  knownPaths: readonly string[];
  /** How many `set_editor_text` events the call emitted. */
  setEditorTextCount: number;
}

export interface ClassifyResult {
  verdict: "good" | "bad";
  codes: string[];
}

/**
 * Models emit typographic quotes and dashes; the phrase lists below are written
 * with ASCII apostrophes, so normalise before matching.
 */
function normalize(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
}

/** Openers that mean "the model narrated its plan instead of rewriting". */
const ANNOUNCEMENT_OPENERS = [
  "I'll",
  "I will",
  "Let me",
  "I'm going to",
  "I am going to",
  "First, I'll",
  "I need to check",
  "I need to inspect",
  "I need to look",
];

/**
 * The opener list above only sees position 0, and that misses roughly half of
 * the real thing. In the recorded baseline, 15 responses on one cell narrated a
 * retrieval plan and were scored `good` because the narration started one
 * clause late — `"Gathering Dependabot, release-please, and dependency layout …
 * I'll inspect config"`, `"The request is vague …, so I'll inspect the
 * prompt-enhancer files"`, `"I need more of the steward slot-parser code … I'll
 * look those up next"`. Those are textbook instances of the incident failure
 * mode. A gate reading "0 bad in every cell" against a rule that cannot see
 * them is a false pass, so the rules below scan the opening of the response
 * rather than only its first character.
 *
 * Three shapes, all evidenced in the corpus:
 *
 * 1. `NARRATION_RE` — first-person intent verb (`I'll`, `Let me`, `I need to`)
 *    followed within two words by a *retrieval* verb. The retrieval verb is
 *    what separates narration from a rewrite that legitimately speaks in the
 *    first person: the dependabot fixture itself contains "Next I need to know
 *    if this is a dev dependency", and a faithful rewrite may carry that
 *    forward. `know` is not retrieval; `inspect` is.
 * 2. `UNMET_CONTEXT_RE` — `"I need more/the rest of …"`, the model reporting
 *    that its context was insufficient. That is the root cause of the incident
 *    stated out loud, and it is never part of a rewritten request.
 * 3. `GERUND_OPENER_RE` — a bare gerund opener (`Gathering …`, `Checking …`).
 *    A rewritten *request* is imperative or declarative; a response that opens
 *    with a progressive verb is reporting what it is doing.
 */

/**
 * Narration only counts in the opening of the response, because that is where a
 * rewrite's payload lives and where every observed instance sat (deepest match
 * in the corpus: 137 characters). Bounding it keeps a long rewrite's body out
 * of scope, so first-person text carried forward from the user's own prompt
 * cannot trip the rule from paragraph four.
 */
const ANNOUNCEMENT_WINDOW = 400;

/**
 * Quoted and backticked spans are masked before the scan. `self-referential.txt`
 * is the deliberate false-positive probe: it asks about a model that writes
 * `"I'll inspect the repo"`, so a *faithful* rewrite quotes that phrase back.
 * All 48 legitimate responses that do so keep the narration inside quotes,
 * while all 15 real announcements state it unquoted — citing the failure mode
 * is not committing it. Replacement preserves length so offsets stay true.
 */
const QUOTED_SPAN_RE = /"[^"\n]{0,400}"|`{1,3}[^`]{0,600}`{1,3}/g;

function maskQuotedSpans(text: string): string {
  return text.replace(
    QUOTED_SPAN_RE,
    (span) => span[0] + " ".repeat(Math.max(0, span.length - 2)) + span[span.length - 1],
  );
}

const NARRATION_RE =
  /\b(?:I'll|I will|I'm going to|I am going to|I'm about to|Let me|I need to|I'll need to)\s+(?:\w+\s+){0,2}(?:inspect|check|look|read|review|examine|open|search|scan|gather|pull|confirm|verify|list|trace|survey|explore)\b/i;

const UNMET_CONTEXT_RE = /\bI need (?:more|the rest|additional|further)\b/i;

const GERUND_OPENER_RE =
  /^(?:First,?\s+)?(?:Gathering|Checking|Reviewing|Inspecting|Looking|Reading|Examining|Searching|Scanning|Pulling|Collecting|Fetching|Surveying|Exploring|Tracing)\b/i;

function looksLikeAnnouncement(trimmed: string): boolean {
  if (ANNOUNCEMENT_OPENERS.some((opener) => trimmed.startsWith(opener))) return true;
  const head = maskQuotedSpans(trimmed).slice(0, ANNOUNCEMENT_WINDOW);
  return GERUND_OPENER_RE.test(head) || NARRATION_RE.test(head) || UNMET_CONTEXT_RE.test(head);
}

/** Phrases that mean "the model addressed the user instead of rewriting". */
const REFUSAL_PHRASES = [
  "I appreciate",
  "I'm a prompt rewriter",
  "I am a prompt rewriter",
  "not an answerer",
  "I can't",
  "I cannot",
  "I won't",
  "I'm not able to",
  "my job is to",
];

/** Phrases that mean "the model described the request rather than restating it". */
const THIRD_PERSON_META_PHRASES = [
  "The user is asking",
  "The user wants",
  "The user's request",
  "They want me to",
];

const THIRD_PERSON_META_WINDOW = 200;

/**
 * Path-shaped tokens: at least one `/`, made of path-safe characters. Leading
 * punctuation, wrapping backticks and trailing sentence punctuation are trimmed
 * by the caller.
 */
const PATH_TOKEN_RE = /[A-Za-z0-9_.@~-]+(?:\/[A-Za-z0-9_.@~-]+)+/g;

/**
 * A final segment that names a file: a dot followed by an alphabetic extension.
 * Requiring it is what keeps English alternation out of the results — real
 * responses wrote "the list of packages/paths" and "package.json/pnpm workspace
 * config", neither of which is a path. A fabricated *directory* is therefore
 * invisible to this rule; that is the deliberate trade, because a classifier
 * that invents failures is worse than one that misses them.
 */
const FILE_EXTENSION_RE = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

function stripWrappers(token: string): string {
  return token.replace(/^[^A-Za-z0-9_.~/@-]+/, "").replace(/[^A-Za-z0-9_~/-]+$/, "");
}

function hasFileExtension(token: string): boolean {
  return FILE_EXTENSION_RE.test(token.slice(token.lastIndexOf("/") + 1));
}

/**
 * ESM specifiers name the emitted file, so this repo's own source imports
 * `./auto.js` for `auto.ts`. A rewrite quoting the specifier is quoting the
 * repository, not inventing a path.
 */
const ESM_SPECIFIER_RE = /\.(js|mjs|cjs)$/;

function pathCandidates(token: string): string[] {
  const needle = token.replace(/^\.\//, "").replace(/\/+$/, "");
  const candidates = [needle];
  const match = ESM_SPECIFIER_RE.exec(needle);
  if (match) {
    const stem = needle.slice(0, -match[0].length);
    candidates.push(`${stem}.ts`, `${stem}.mts`, `${stem}.cts`, `${stem}.tsx`);
  }
  return candidates;
}

function isKnownPath(token: string, knownPaths: readonly string[]): boolean {
  for (const needle of pathCandidates(token)) {
    for (const known of knownPaths) {
      if (known === needle) return true;
      // A directory mention: some known file lives under it.
      if (known.startsWith(`${needle}/`)) return true;
      // A relative fragment of a real path ("core/__fixtures__/llama/x.json").
      if (known.endsWith(`/${needle}`)) return true;
    }
  }
  return false;
}

/**
 * English alternation reads exactly like a path: real responses wrote
 * `package.json/package-lock.json` and `the lockfile/package.json files`.
 * A repository path starts at a real top-level entry, and nothing can live
 * *under* a regular file, so a token only counts when its first segment is a
 * top-level directory that exists.
 *
 * The cost is that a fabricated path rooted at a directory this repo does not
 * have (`src/utils/helper.ts` here) goes unflagged. That is the deliberate
 * trade: a classifier that invents failures is worse than one that misses them.
 */
function startsAtRealDirectory(token: string, knownPaths: readonly string[]): boolean {
  const first = token.replace(/^\.\//, "").split("/")[0] ?? "";
  if (first.length === 0) return false;
  return knownPaths.some((known) => known.startsWith(`${first}/`));
}

/**
 * Tokens in `enhanced` that name a file which appears neither in `original` nor
 * on disk. Only file-shaped tokens count, so prose like `and/or`, `24/7`,
 * `input/output` or `packages/paths` is left alone, and URLs are skipped.
 *
 * **Known blind spot, deliberate and left as-is.** A token must clear *both*
 * `hasFileExtension` and `startsAtRealDirectory` before it can be flagged, so a
 * fabrication that fails either half is invisible: `src/utils/helper.ts` goes
 * unflagged here because this repo has no top-level `src/`, and a fabricated
 * bare directory goes unflagged because it has no extension. The conjunction is
 * what keeps English alternation (`package.json/pnpm workspace config`,
 * `the lockfile/package.json files`) out of the results. Precision on the
 * recorded corpus is clean; widening either half trades that for recall and a
 * classifier that invents failures is worse than one that misses them.
 */
function findFabricatedPaths(input: ClassifyInput): string[] {
  const { enhanced, original, knownPaths } = input;
  const fabricated: string[] = [];
  const seen = new Set<string>();

  PATH_TOKEN_RE.lastIndex = 0;
  for (let match = PATH_TOKEN_RE.exec(enhanced); match; match = PATH_TOKEN_RE.exec(enhanced)) {
    // A match preceded by "/" or ":" is the tail of a URL, not a repo path.
    const previous = match.index > 0 ? enhanced[match.index - 1] : "";
    if (previous === "/" || previous === ":") continue;

    const token = stripWrappers(match[0]);
    if (!token.includes("/") || seen.has(token)) continue;
    seen.add(token);
    // Scoped package names look like paths and are not.
    if (token.startsWith("@")) continue;
    if (!hasFileExtension(token)) continue;

    if (original.includes(token)) continue;
    if (isKnownPath(token, knownPaths)) continue;
    if (!startsAtRealDirectory(token, knownPaths)) continue;
    fabricated.push(token);
  }
  return fabricated;
}

/**
 * Score one enhancement. `verdict` is `"bad"` whenever any code fires.
 *
 * `echo` keys on the transport only (`setEditorTextCount === 1`, i.e. no
 * rewrite ever arrived). It must NOT key on `enhanced.trim() === original.trim()`:
 * the system prompt tells the model to return the original request unchanged
 * for out-of-scope prompts, so byte-equality is compliant behaviour.
 */
export function classifyEnhancement(input: ClassifyInput): ClassifyResult {
  const codes: string[] = [];
  const enhanced = normalize(input.enhanced);
  const trimmed = enhanced.trim();

  if (input.setEditorTextCount === 1) codes.push("echo");
  if (trimmed.length === 0) codes.push("empty");
  if (input.stopReason === "length") codes.push("truncated");

  if (looksLikeAnnouncement(trimmed)) {
    codes.push("announcement");
  }
  if (REFUSAL_PHRASES.some((phrase) => trimmed.includes(phrase))) {
    codes.push("refusal");
  }
  const head = trimmed.slice(0, THIRD_PERSON_META_WINDOW);
  if (THIRD_PERSON_META_PHRASES.some((phrase) => head.includes(phrase))) {
    codes.push("third_person_meta");
  }
  if (findFabricatedPaths({ ...input, enhanced }).length > 0) {
    codes.push("fabricated_path");
  }

  return { verdict: codes.length > 0 ? "bad" : "good", codes };
}

/**
 * Host failures are not measurements.
 *
 * A call that `pi` itself killed before the extension ever ran says nothing
 * about the enhancer, and scoring it as `bad` fails a cell on infrastructure.
 * This happened for real: two records in `acceptance-short-context.json` were
 * scored `empty` when `pi` had actually exited at startup with
 * `Error: Unknown provider "…". Use --list-models to see available
 * providers/models.` — no enhancer code ran at all.
 *
 * The gate is `setEditorTextCount === 0`, and it is the whole safety property.
 * The extension emits its pre-replace echo (the first `set_editor_text`)
 * synchronously, before any model call; see the RPC transport contract in
 * `README.md`. So a call that emitted even one `set_editor_text` reached the
 * enhancer and is scored normally, whatever `pi` did afterwards. Only a call
 * that emitted none can be a host failure, and this rule can therefore never
 * absolve a real enhancer failure.
 *
 * Kept model-agnostic per **D14**: no provider, model id or api appears here or
 * in `HOST_STARTUP_FAILURE_RE`, and none may be added. The phrases below are
 * generic host and CLI diagnostics.
 */
export interface HostFailureInput {
  /** Child exit code, or `null` when it was signalled or never reaped. */
  exitCode: number | null;
  /** How many `set_editor_text` events the call emitted. */
  setEditorTextCount: number;
  /** Bounded tail of the child's stderr. */
  stderrTail: string;
}

const HOST_STARTUP_FAILURE_RE =
  /\b(?:unknown provider|unknown model|no such model|use --list-models|cannot find module|err_module_not_found|command not found|permission denied)\b/i;

/**
 * True when the call is host infrastructure failing, not the enhancer: `pi`
 * exited non-zero having emitted no `set_editor_text` at all, or its stderr
 * carries a startup-failure signature and, again, nothing was ever emitted.
 */
export function looksLikeHostFailure(input: HostFailureInput): boolean {
  if (input.setEditorTextCount > 0) return false;
  if (input.exitCode !== null && input.exitCode !== 0) return true;
  return HOST_STARTUP_FAILURE_RE.test(input.stderrTail);
}
