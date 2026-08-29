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
  /**
   * Observations that are *not* verdicts.
   *
   * Some behaviour is worth seeing in the artifact without being scoreable.
   * Whether a rewrite carried a misspelled path forward or corrected it is the
   * motivating case: both are defensible — "invent no path that is not in the
   * context" argues for carrying it, and "fix misspellings including in paths"
   * argues for correcting it — so turning either into `bad` would encode a
   * preference this harness has no evidence for. Signals never touch `verdict`.
   */
  signals: string[];
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

/**
 * Refusal: a *first-person self-decline* or a *role assertion*, never a bare
 * phrase.
 *
 * The previous revision matched substrings — `"i appreciate"`, `"my job is
 * to"`, `"as an ai,"`, `"^unable to"` — anywhere in a 400-character window.
 * Four of those fired on rewrites that are entirely correct, and one of the
 * four is real model output under the shipped `SYSTEM_PROMPT`:
 *
 * | rewrite | why the old rule fired |
 * | --- | --- |
 * | `"Unable to reach staging from the laptop. Figure out why the deploy hangs at the migration step."` | `^unable to` treated a status line as a decline |
 * | `"My job is to ship this by Friday; find the regression that broke the build."` | `my job is to` with no rewriting anywhere near it |
 * | `"I appreciate that the schema is messy, but fix the migration anyway."` | `i appreciate` as a bare substring |
 * | `"As an AI, I would still like the summariser rewritten."` | the `as an ai,` frame with no decline after it |
 *
 * None of the six fixtures the recorded baseline used produces those shapes, so
 * 0 of its 216 records tripped them. That makes it a latent bug, not a harmless
 * one: `CELL_BAD_THRESHOLD` is 0, so a single such rewrite fails a whole cell.
 *
 * Every rule below therefore requires a **subject declining this job**:
 *
 * - a role assertion (`"I'm a prompt rewriter, not an answerer"`, `"my job is
 *   to rewrite prompts"`) — the rewriter describing itself instead of working;
 * - a first-person modal (`I can't`, `I won't`, `I'm unable to`, `I don't`)
 *   whose object is the job (`rewrite this`, `comply`, `help with that`);
 * - the same with the subject elided, but only at position 0, where a bare
 *   `"Unable to comply with that request."` is unambiguous;
 * - a terse self-decline with no object at all (`"I must decline."`);
 * - the `"As an AI, I …"` frame, and only when a decline follows it;
 * - an apology that names the prompt or the rewriting it is declining.
 *
 * What was deliberately dropped: the soft-opener branch (`"Sorry"` /
 * `"Unfortunately"` plus any modal). Every genuine refusal it caught is caught
 * by the modal rules on their own, and it fired on
 * `"Unfortunately I cannot get the profiler to attach; instrument the hot path
 * instead."` — an apology and an inability that belong to the user.
 */

/**
 * The rewriter describing its own role.
 *
 * The `my job/role/…` half must reach a rewriting verb *and* the thing being
 * rewritten (a prompt or a request) within one clause. That conjunction is what
 * keeps `"My job is to ship this by Friday"` and `"My role is to rewrite the
 * onboarding docs this quarter"` out: both are a user talking about their own
 * work, and neither names the prompt.
 */
const REFUSAL_ROLE_RE =
  /\b(?:I'm|I am)\s+(?:just\s+|only\s+|merely\s+)?(?:an?|the)\s+(?:prompt\s+)?(?:rewriter|rephraser|reworder)\b|\bnot an answerer\b|\bmy (?:job|role|function|purpose|task)\b[^.!?;\n]{0,40}\b(?:rewrit|rephras|restat|refin|rewor)\w*[^.!?;\n]{0,20}\b(?:prompts?|requests?)\b/i;

/**
 * First-person modals that can precede an object.
 *
 * `"not something I can"` is here rather than in its own rule because it takes
 * the same object test: `"That is not something I can help with."` declines the
 * job, and the object is what says so.
 */
const REFUSAL_SELF_MODAL =
  "(?:I can't|I cannot|I can not|I won't|I will not|I'm not able to|I am not able to|I'm unable to|I am unable to|I'm not going to|I am not going to|I'm not willing to|I am not willing to|I refuse to|not something I (?:can|could|will|am able to))";

/**
 * `don't` / `do not` take no gap at all.
 *
 * `"I don't rewrite prompts like this one"` is a refusal; `"I don't want to
 * rewrite the whole module"` is the user's own sentence, and the space between
 * the modal and the object is the whole difference. The third-person form
 * (`it doesn't help …`) is gone entirely: without a first-person subject it was
 * scoring `"It doesn't help to restate the error; find the root cause."`
 */
const REFUSAL_SELF_WEAK_MODAL = "(?:I don't|I do not)";

/** The same decline with the subject elided, recognised only at position 0. */
const REFUSAL_ELIDED_MODAL = "(?:Unable to|Not able to|Can't|Cannot|Won't|Will not|Not going to)";

/**
 * The gap between modal and object: one clause, at most one comma-delimited
 * aside.
 *
 * `"I'm not able to, for policy reasons, rewrite this."` needs the aside;
 * `"I can't reproduce it, so help with that."` must not be allowed to bridge
 * two clauses on a single comma, which a plain `.{0,32}` gap does. Sentence
 * punctuation ends the clause outright.
 */
const REFUSAL_GAP = "(?:,[^,.!?;\\n]{1,24},)?[^,.!?;\\n]{0,24}";

/**
 * The job as an object: a rewriting verb whose own object is the prompt.
 *
 * The lookahead is what separates the two halves of `"I won't rewrite this
 * prompt"` from `"I won't rewrite history on this branch"`. A rewriting verb
 * alone is not a decline — the user's draft may well contain one.
 *
 * An opening quote counts as a complement because a model that declines often
 * quotes the prompt it is declining — `I am not going to rewrite "honestly
 * I've been at this all afternoon …"` — and by then the quoted span has already
 * been blanked, so nothing is left after the verb to match on.
 */
const REFUSAL_JOB_OBJECT =
  "(?:rewrit|rephras|rewor[dk]|recast|restat|reformulat|paraphras)\\w*" +
  "(?=[^\\w\\n]{0,3}(?:$|[.!?;,\"']|\\b(?:it|this|that|these|those|anything|prompts?|requests?|(?:the|this|that|your|a|any)\\s+(?:prompt|request|question|original|version|draft))\\b))";

/**
 * The generic objects — `comply`, `help`, `answer`, `do` — which a user's own
 * sentence also reaches for, so each needs its complement pinned.
 *
 * The complement is either the end of the sentence (`"Unfortunately I cannot
 * comply."`), a pronoun that ends it (`"I can't do that."`, optionally with a
 * short adverb: `"I can't do that here."`), or the job named outright (`"I
 * cannot help with this request."`). `"I can't do this migration by hand"` and
 * `"I can't answer that myself, which is why I'm asking"` fail all three: their
 * object runs on into the user's actual request.
 *
 * The adverb list is a small tuning surface; it exists so a decline that ends
 * `"… do that here."` still reads as terminal.
 */
const REFUSAL_TASK_OBJECT =
  "(?:compl(?:y|ying)|fulfil{1,2}\\w*|assist(?:ing)?|help(?:ing)?|answer(?:ing)?|respond(?:ing)?|engage|do)" +
  "(?:\\s+(?:with|to|in))?" +
  "(?=\\s*(?:[.!?]|$)" +
  "|\\s+(?:that|this|it|so)(?:\\s+(?:here|now|today|either|at all|for you))?\\s*(?:[.!?]|$)" +
  "|\\s+(?:this|that|your|the|any)\\s+(?:request|question|prompt)s?\\b" +
  "|\\s+questions?\\b)";

const REFUSAL_OBJECT = `(?:${REFUSAL_JOB_OBJECT}|${REFUSAL_TASK_OBJECT})`;

const REFUSAL_SELF_RE = new RegExp(
  `\\b${REFUSAL_SELF_MODAL}${REFUSAL_GAP}\\b${REFUSAL_OBJECT}`,
  "i",
);
const REFUSAL_WEAK_RE = new RegExp(`\\b${REFUSAL_SELF_WEAK_MODAL}\\s+\\b${REFUSAL_OBJECT}`, "i");
const REFUSAL_ELIDED_RE = new RegExp(
  `^${REFUSAL_ELIDED_MODAL}\\b${REFUSAL_GAP}\\b${REFUSAL_OBJECT}`,
  "i",
);

/**
 * Self-declines that carry no object because they need none.
 *
 * Each still needs its subject and a terminal position: `"I must decline."`
 * declines the job, `"I have to decline the vendor meeting, so summarise the
 * thread instead."` is the user's calendar. Same for `"Not rewriting that."`
 * against `"Not rewriting the tests is fine — just fix the parser."`
 */
const REFUSAL_TERSE_RE =
  /\bI (?:must|have to|need to|will have to|'ll have to|am going to|'m going to) (?:decline|pass)(?=\s*(?:[.!?]|$)|\s+(?:on\s+)?(?:this|that|it|here)\b)|\bI (?:refuse|decline)(?=\s*(?:[.!?]|$))|\bI(?:'m| am) declining\b|^(?:not rewriting (?:that|this|it)|no rewrite here)\b/i;

/**
 * The `"As an AI, I …"` frame, and only when a decline follows it in the same
 * sentence.
 *
 * The comma is load-bearing — it separates the self-description from a prompt
 * that legitimately talks about AI (`"As an AI safety researcher, I want …"`),
 * where the noun phrase runs on instead. The decline is load-bearing too:
 * `"As an AI, I would still like the summariser rewritten."` is a rewrite.
 */
/**
 * An apology that names the job it is declining.
 *
 * The bare soft-opener rule this replaces asked only for an apology plus any
 * first-person modal, and that scored `"Unfortunately I cannot get the profiler
 * to attach; instrument the hot path instead."` as a refusal. Requiring the
 * clause to also *name* the prompt or the rewriting keeps the user's apologies
 * out while still catching a decline phrased outside the object vocabulary:
 * `"I'm sorry, but I don't turn rough questions into polished prompts."`
 */
const REFUSAL_APOLOGY_RE =
  /^(?:sorry|i(?:'m| am)(?:\s+\w+){0,2}\s+sorry|i(?:'m| am)\s+afraid|unfortunately|regrettably)\b[^.!?;\n]{0,80}\bI (?:can't|cannot|can not|won't|will not|don't|do not|am not|'m not)\b[^.!?;\n]{0,60}\b(?:prompts?|rewrit\w*|rephras\w*|restat\w*)\b/i;

const REFUSAL_AI_FRAME_RE =
  /\bas an ai(?:\s+language\s+model)?\s*,[^.!?\n]{0,60}\b(?:can't|cannot|can not|won't|will not|unable|not able|don't|do not|must decline|have to decline|refuse|not going to|not permitted|not allowed)\b/i;

/**
 * Refusals are bounded and masked exactly as announcements are.
 *
 * Same two reasons: a refusal is an opening move, not something that surfaces in
 * paragraph four of a rewrite; and a rewrite that *quotes* a refusal (the
 * `self-referential.txt` probe asks about a model that produces one) is citing
 * the failure mode, not committing it.
 *
 * The two costs are accepted rather than hidden: a refusal a model chooses to
 * put inside quotes, and one that starts past character 400, are not counted.
 * Neither has been observed; a quoted refusal that *is* the whole response would
 * still be scored `echo` or `empty`.
 */
const REFUSAL_WINDOW = 400;

function looksLikeRefusal(trimmed: string): boolean {
  const head = maskQuotedSpans(trimmed).slice(0, REFUSAL_WINDOW);
  return (
    REFUSAL_ROLE_RE.test(head) ||
    REFUSAL_TERSE_RE.test(head.trimStart()) ||
    REFUSAL_AI_FRAME_RE.test(head) ||
    REFUSAL_APOLOGY_RE.test(head.trimStart()) ||
    REFUSAL_SELF_RE.test(head) ||
    REFUSAL_WEAK_RE.test(head) ||
    REFUSAL_ELIDED_RE.test(head.trimStart())
  );
}

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
 * Fenced blocks in the *original*, as the text between the fences.
 *
 * Pasting a stack trace, a diff or a failing test into a draft is ordinary, and
 * a reworded trace is worse than no rewrite: the line numbers and identifiers
 * are the whole payload. The system prompt tells the model to carry these
 * through unchanged, so the harness checks that whatever sample it did emit is
 * still the user's lines and not the model's retyping of them.
 *
 * Only the block *body* is captured. The fence markers themselves, the info
 * string, and where the block sits in the rewrite are all free to move.
 */
const FENCED_BLOCK_RE = /```[^\n]*\n([\s\S]*?)```/g;

function fencedBlockBodies(text: string): string[] {
  const bodies: string[] = [];
  FENCED_BLOCK_RE.lastIndex = 0;
  for (let m = FENCED_BLOCK_RE.exec(text); m; m = FENCED_BLOCK_RE.exec(text)) {
    const body = (m[1] ?? "").replace(/\s+$/, "");
    if (body.length > 0) bodies.push(body);
  }
  return bodies;
}

/**
 * Line endings and trailing whitespace are normalised before comparison.
 *
 * Those are transport and editor artifacts, not the model rewording anything —
 * failing a cell on a stripped trailing space would be a measurement of the RPC
 * stream. Everything else, including every space *inside* a line, must match:
 * a trace whose indentation moved is a trace that was retyped.
 */
function normalizeBlock(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

/**
 * How many of the original's payload lines an excerpt may skip *between* the
 * first and last line it kept.
 *
 * Trimming a trace to its head or its tail drops lines from an end, which this
 * does not count at all. A gap in the middle is different: it is the shape a
 * model makes when it decides which lines matter and stitches the survivors
 * together, and past a line or two that is no longer an excerpt of the sample.
 */
const BLOCK_ELISION_TOLERANCE = 2;

/** Payload lines: blank lines carry nothing and are not part of the comparison. */
function payloadLines(block: string): string[] {
  return normalizeBlock(block)
    .split("\n")
    .filter((line) => line.length > 0);
}

/**
 * Whether `emitted` is a contiguous — or near-contiguous — run of `source`.
 *
 * Every emitted line must be a line of the source, verbatim, in order. Leading
 * and trailing lines may be dropped without limit; interior gaps are capped by
 * `BLOCK_ELISION_TOLERANCE`. A reworded, re-indented or invented line matches
 * nothing and fails here, which is the whole point: this tolerates a shorter
 * sample, never a rewritten one.
 *
 * Matching takes the earliest candidate for each line. That decides subsequence
 * membership correctly; with a repeated line it could in principle report a
 * wider gap than some other alignment would, which errs toward flagging.
 */
function isExcerptOf(emitted: readonly string[], source: readonly string[]): boolean {
  if (emitted.length === 0) return false;
  let cursor = -1;
  let elided = 0;
  for (const line of emitted) {
    const at = source.indexOf(line, cursor + 1);
    if (at === -1) return false;
    if (cursor >= 0) elided += at - cursor - 1;
    cursor = at;
  }
  return elided <= BLOCK_ELISION_TOLERANCE;
}

/** What became of one fenced body from the original. */
type BlockOutcome = "verbatim" | "trimmed" | "mangled";

/**
 * How each fenced body from the original fared in the rewrite.
 *
 * Returns `[]` when the original has no fenced block, so this rule is inert on
 * every prompt that does not carry a sample — including all six fixtures the
 * recorded baseline was measured on.
 *
 * Three outcomes, because the corpus shows three behaviours:
 *
 * - `verbatim` — the body appears in the rewrite unchanged. Checked against the
 *   whole rewrite, not against its fenced blocks, so a model that kept the
 *   sample but dropped the fences still passes.
 * - `trimmed` — the rewrite carries a *block* whose lines are an excerpt of the
 *   body: same lines, fewer of them. Not a verdict; see `code_block_trimmed`.
 * - `mangled` — anything else, which is the pair of failures worth catching:
 *   lines that were reworded or re-indented, and a sample paraphrased away into
 *   prose entirely.
 *
 * The trim tolerance deliberately requires a surviving fenced block. An
 * unchanged sample may lose its fences to an editor; a *shortened* one that is
 * no longer set off as a sample has been absorbed into the prose, which is the
 * failure this rule exists to catch and not a trim at all.
 */
function classifyFencedBlocks(original: string, enhanced: string): BlockOutcome[] {
  const bodies = fencedBlockBodies(original).filter((body) => normalizeBlock(body).length > 0);
  if (bodies.length === 0) return [];

  const haystack = normalizeBlock(enhanced);
  const emitted = fencedBlockBodies(enhanced).map(payloadLines);

  return bodies.map((body) => {
    if (haystack.includes(normalizeBlock(body))) return "verbatim";
    const source = payloadLines(body);
    if (emitted.some((block) => isExcerptOf(block, source))) return "trimmed";
    return "mangled";
  });
}

/** Levenshtein distance, abandoned as soon as it is known to exceed `max`. */
function withinEditDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  if (a === b) return true;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > max) return false;
    previous = current;
  }
  return (previous[b.length] ?? max + 1) <= max;
}

/** How far off a path may be and still read as a misspelling of a real one. */
const PATH_TYPO_MAX_DISTANCE = 2;

/**
 * File-shaped tokens in the *original* that are one or two edits away from a
 * path that really exists — a misspelled path, in other words.
 *
 * Fixture-agnostic: it derives the near-miss from `knownPaths`, so it needs no
 * list of expected typos and fires on any prompt that misspells a real path.
 * Model-agnostic per D14: nothing here can see the provider, model or api.
 */
function findMisspelledPaths(
  original: string,
  knownPaths: readonly string[],
): { typo: string; actual: string }[] {
  const found: { typo: string; actual: string }[] = [];
  const seen = new Set<string>();

  PATH_TOKEN_RE.lastIndex = 0;
  for (let match = PATH_TOKEN_RE.exec(original); match; match = PATH_TOKEN_RE.exec(original)) {
    const token = stripWrappers(match[0]);
    if (!token.includes("/") || seen.has(token)) continue;
    seen.add(token);
    if (token.startsWith("@")) continue;
    if (!hasFileExtension(token)) continue;
    if (isKnownPath(token, knownPaths)) continue;

    const actual = knownPaths.find((known) =>
      withinEditDistance(token, known, PATH_TYPO_MAX_DISTANCE),
    );
    if (actual !== undefined) found.push({ typo: token, actual });
  }
  return found;
}

/**
 * Anchor retention: how much of the request's subject matter survived.
 *
 * **A signal, and only ever a signal.** It was proposed as a hard verdict at
 * `< 0.5` and that was refuted before it shipped: 5 of 9 hand-written
 * legitimate rewrites and 6 of 8 live ones under the shipped `SYSTEM_PROMPT`
 * score below 0.5 while being genuine rewrites, because an "anchor" is any word
 * of six letters or more and that admits `unfortunately`, `honestly`,
 * `whatever`, `basically`, `probably`. Stripping exactly those is what a good
 * rewrite does, so as a verdict the metric penalises the enhancer for working.
 * No threshold above 0 was clean: at 0.2, where recall has already collapsed,
 * a legitimate rewrite still failed. With `CELL_BAD_THRESHOLD` at 0 that would
 * make the harness less trustworthy, not more. It stays out of `verdict`
 * permanently; `typo_path_*` is the precedent.
 *
 * As a signal it is worth having: a response that dropped nearly every
 * content-bearing word of the request is worth a human glance whatever the
 * lexical rules concluded, and it is the only thing here with any purchase on
 * a refusal written in a language the phrase rules do not cover.
 *
 * **Tuning surfaces, disclosed.** There is deliberately no stopword or filler
 * list — an earlier proposal carried a hand-authored 137-word one, undisclosed,
 * and rebuilding it three ways moved its headline false-positive count from 7
 * to 1 at no cost in recall, which is the definition of a knob. What remains
 * tunable is: the six-character anchor floor, the edit-distance tolerance, the
 * suffix stemmer, the three-anchor minimum, and the threshold itself. All five
 * are in this block, none of them can see a provider, model or fixture, and the
 * whole thing is inert on `verdict`.
 */
const ANCHOR_MIN_LENGTH = 6;

/**
 * Below three anchors a single dropped word swings the score across the whole
 * range, so short prompts are not scored at all.
 */
const ANCHOR_MIN_COUNT = 3;

/**
 * 0.3, from a sweep over 45 constructed refusals and 297 legitimate rewrites:
 * it flags 71% of the refusals and 2 of 14 live legitimate rewrites. 0.4 and
 * 0.5 buy a few more refusals for 5 and 7 legitimate ones. Since this only ever
 * asks a human to look, the cheap direction is the quiet one.
 */
const ANCHOR_RETENTION_SIGNAL_THRESHOLD = 0.3;

/** Words, split out of paths, dotted names and camelCase, lowercased. */
function anchorTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9_./@'-]+/)) {
    if (raw.length === 0) continue;
    for (const segment of raw.split(/[./@_'-]+/)) {
      if (segment.length === 0) continue;
      for (const word of segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/)) {
        const token = word.toLowerCase();
        if (token.length >= 3) out.push(token);
      }
    }
  }
  return out;
}

/**
 * The tokens that carry the request's subject matter: long words, plus anything
 * inside a path-shaped token or carrying a digit or an internal capital, which
 * is how short identifiers (`ci`, `iva`, `v2`) stay in.
 */
function anchorsOf(text: string): string[] {
  const structural = new Set<string>();
  PATH_TOKEN_RE.lastIndex = 0;
  for (let match = PATH_TOKEN_RE.exec(text); match; match = PATH_TOKEN_RE.exec(text)) {
    for (const token of anchorTokens(match[0])) structural.add(token);
  }
  for (const word of text.match(/[A-Za-z0-9_]+/g) ?? []) {
    if (/[a-z][A-Z]/.test(word) || /\d/.test(word)) {
      for (const token of anchorTokens(word)) structural.add(token);
    }
  }
  const anchors = new Set<string>();
  for (const token of anchorTokens(text)) {
    if (token.length >= ANCHOR_MIN_LENGTH || structural.has(token)) anchors.add(token);
  }
  return [...anchors];
}

/** Crude suffix stemmer, so `migrations` still matches `migration`. */
function stemToken(token: string): string {
  return token
    .replace(/ies$/, "y")
    .replace(/(?:es|s)$/, "")
    .replace(/(?:ing|ed)$/, "");
}

/**
 * The fraction of the original's anchors that reappear in the rewrite, allowing
 * a stem match or a small edit distance — the system prompt asks the model to
 * fix misspellings, so a repaired identifier must still count as retained.
 */
export function anchorRetention(
  original: string,
  enhanced: string,
): { score: number; count: number } {
  const source = anchorsOf(original);
  if (source.length === 0) return { score: 1, count: 0 };
  const target = anchorTokens(enhanced);
  const exact = new Set(target);
  const stems = new Set(target.map(stemToken));
  let hit = 0;
  for (const token of source) {
    if (exact.has(token) || stems.has(stemToken(token))) {
      hit += 1;
      continue;
    }
    const tolerance = token.length >= 8 ? 2 : 1;
    if (target.some((candidate) => withinEditDistance(token, candidate, tolerance))) hit += 1;
  }
  return { score: hit / source.length, count: source.length };
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
  const signals: string[] = [];
  const enhanced = normalize(input.enhanced);
  const trimmed = enhanced.trim();

  if (input.setEditorTextCount === 1) codes.push("echo");
  if (trimmed.length === 0) codes.push("empty");
  if (input.stopReason === "length") codes.push("truncated");

  if (looksLikeAnnouncement(trimmed)) {
    codes.push("announcement");
  }
  if (looksLikeRefusal(trimmed)) {
    codes.push("refusal");
  }
  const head = trimmed.slice(0, THIRD_PERSON_META_WINDOW);
  if (THIRD_PERSON_META_PHRASES.some((phrase) => head.includes(phrase))) {
    codes.push("third_person_meta");
  }
  if (findFabricatedPaths({ ...input, enhanced }).length > 0) {
    codes.push("fabricated_path");
  }
  // Compared against the *raw* original and rewrite: `normalize` rewrites
  // quotes, and a trace's quotes are part of the payload.
  const blocks = classifyFencedBlocks(input.original, input.enhanced);
  if (blocks.includes("mangled")) {
    codes.push("code_block_mangled");
  }
  if (blocks.includes("trimmed")) {
    signals.push("code_block_trimmed");
  }

  const retention = anchorRetention(input.original, enhanced);
  if (retention.count >= ANCHOR_MIN_COUNT && retention.score < ANCHOR_RETENTION_SIGNAL_THRESHOLD) {
    signals.push("low_anchor_retention");
  }

  for (const { typo, actual } of findMisspelledPaths(input.original, input.knownPaths)) {
    if (input.enhanced.includes(typo)) signals.push("typo_path_carried");
    else if (input.enhanced.includes(actual)) signals.push("typo_path_corrected");
    else signals.push("typo_path_dropped");
  }

  return { verdict: codes.length > 0 ? "bad" : "good", codes, signals };
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
