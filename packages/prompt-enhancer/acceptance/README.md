# Prompt Enhancer acceptance harness

Test scaffolding for `@jmcombs/pi-prompt-enhancer`. **Nothing in this directory is published** —
`package.json` `files` lists only `index.ts`, `auto.ts`, `widget.ts`, `README.md`, `LICENSE`. It
lives under `packages/` (not at the repo root) because `vitest.config.ts` only collects
`packages/*/**/*.test.ts`, so a classifier test anywhere else would never run.

## What it is for

Every acceptance number for this extension must come from the **real `pi` binary with the real
extension loaded**. A harness that imports `index.ts` and calls a model directly proves nothing
about the shipped command path and does not satisfy any gate. `run-matrix.ts` therefore spawns `pi`
itself, once per call, and only reads its RPC stream.

```
pi --mode rpc --no-session --offline -ne -e ./packages/prompt-enhancer \
   --provider <provider> --model <id>
```

`-ne` (`--no-extensions`) plus `-e ./packages/prompt-enhancer` is deliberate: globally installed
extensions must not load, or their commands and models contaminate the results.

## Who runs it

Both the maintainer and contributors. A change to the prompt, to context assembly or to the enhance
path is a change `npm run check` cannot judge, so the PR carries an acceptance artifact and the
maintainer verifies it with `scripts/check-acceptance-artifact.mjs`. `CONTRIBUTING.md` has the short
version, including when evidence is required and what a pass costs; this file is the long version.

Contributors pick their own models within a cap, so a single-provider setup is enough to produce a
run worth reading. A bare run still measures the maintainer's default five, so his workflow is
unchanged.

## Running it

```bash
# default matrix: 5 cells × 8 fixtures × n=12 = 480 real model calls
npx tsx packages/prompt-enhancer/acceptance/run-matrix.ts --n 12 \
  --out docs/prompt-enhancer/baseline.json

# a contributor's run: two models of their own, the required baseline first
npx tsx packages/prompt-enhancer/acceptance/run-matrix.ts --n 6 \
  --model anthropic/claude-haiku-4-5 --model xai/grok-4.6 \
  --out docs/prompt-enhancer/acceptance-my-change.json

# a single cell
npx tsx packages/prompt-enhancer/acceptance/run-matrix.ts --n 3 \
  --model anthropic/claude-haiku-4-5 --fixture out-of-scope --out /tmp/one-cell.json
```

Flags: `--n <count>`, `--model <spec>` (repeatable, also comma-separable, aliased `--models`),
`--fixture <name>` (repeatable), `--out <path>`, `--timeout-ms <ms>` (default 120000),
`--concurrency <n>` (default 3), `--baseline-exempt <reason>`.

### `--model`: choosing the cells

A spec is `provider/id`, exactly as `pi -ne --list-models` prints the two columns, with an optional
`#api` label appended. The provider is split on the **first** `/`, so an openrouter id that is itself
a path works: `openrouter/z-ai/glm-5`.

The api label is decoration for the artifact, not something the runner acts on. `pi -ne
--list-models` does not report an api, so a selection cannot invent one: a spec without `#api` is
keyed on `provider/id` alone. The five default cells keep their `#api` keys, so an artifact from a
bare run is byte-identical in its cell keys to every recorded one.

A spec that names a default cell, by full key or by `provider/id`, resolves to that cell and keeps
its api label. Everything else is taken at face value and checked against the catalog.

**The cap is five models.** Two reasons, both practical: each cell is another full fixture set times
`n` of real paid calls, and an artifact wider than five columns stops fitting on a screen, which
means it stops being reviewed. Selecting more fails before anything is spawned, with the count and
the list.

**Models are validated before the run, not during it.** The runner reads `pi -ne --list-models` once
and fails on anything it cannot find, naming the misses. `-ne` matches how a call is actually
spawned: with discovery off, a globally installed extension's providers are not there, so validating
against the full catalog would green-light a model that every call then fails on. Without this
check, a mistyped id is indistinguishable from a broken enhancer at the end of a paid run: every
call in the cell returns `host_error` and the cell reads as unmeasured.

### The baseline model

`anthropic/claude-haiku-4-5` is the one cell every run is expected to carry. It is the cheapest
hosted model in the default set, which is why it is the one asked for rather than a stronger one.
Its purpose is comparability: without a shared column, "my change is fine on my two models" and "it
is fine on my two other models" are two unrelated claims, and neither can be read against the
recorded baseline.

It is **policy, not scoring**. Nothing in `classify.ts` or in `scoreCall` may branch on a provider,
model id or api when deciding a verdict (**D14**). The baseline requirement lives in the runner's
reporting and in the check script, and it changes no verdict anywhere.

A run without it is not blocked. The runner prints a warning, records
`baseline: { model, present: false, exemptionReason }` in the artifact, and completes. The exemption
is the documented path for a contributor with no Anthropic access:

```bash
npx tsx packages/prompt-enhancer/acceptance/run-matrix.ts --n 6 \
  --model xai/grok-4.6 \
  --baseline-exempt "no Anthropic account; xAI credits only" \
  --out docs/prompt-enhancer/acceptance-my-change.json
```

`PROMPT_ENHANCER_BASELINE_EXEMPTION` is the environment-variable equivalent. Silence is the one
thing that fails: an artifact with no baseline **and** no recorded reason is rejected by the check
script. A reason turns it into a judgement the maintainer makes with the facts in front of him,
which is the point.

Records stream to `<out>.partial.jsonl` as each call finishes and are rewritten as a single JSON
document at `<out>` when the run completes; the partial is removed on success. That file is the way
to watch a long run — `tail -f docs/prompt-enhancer/baseline.json.partial.jsonl` — and it is
crash-safe. The runner also writes its per-call progress lines to fd 1 **synchronously**, so a
redirected or piped run (`… > run.log`) shows each call as it lands instead of buffering silently.
The process exits non-zero if any cell has a `bad` call.

The partial file exists before the first call and is added to the runner's `knownPaths`, so the
project tree every call sees is identical and the runner's own scratch file can never score as a
fabricated path.

**Every call is bounded end to end.** `deadline.ts` wraps the whole call — context gathering, the
child's entire lifetime, and the reap after the completion rule — in one wall clock, and settles
when the clock says so no matter where the work is blocked. The earlier timer lived inside the
child-process promise and covered only the window between the spawn and the completion rule; a run
once sat 14 min 40 s on 1.6 s of CPU with no `pi` child alive while that 120 s timeout never fired.
A call whose `spawn` produces no child fails immediately with `spawn_failed` rather than waiting out
a timeout, and a timed-out record carries `stalledPhase` (`"context"` or `"call"`) so the next hang
is diagnosable from the results file alone.

**Concurrency is per provider, not per model.** All models of one provider run sequentially in a
single worker. Running three `anthropic` models at once made concurrent credential resolution fail
with `Prompt Enhancer: no API key configured for anthropic/…`, which scores as a `bad` call that has
nothing to do with the enhancer.

## What the artifact records

Alongside `startedAt`, `finishedAt`, `transport`, `models`, `fixtures`, `n`, `cellBadThreshold` and
`records`, a run writes four things that exist so the file can be checked by someone who did not
watch it happen:

| field | why it is there |
| --- | --- |
| `baseline` | `{ model, present, exemptionReason }`. Whether the required column was run, and the reason if not. |
| `knownPaths` | The repo file list the run scored against. Without it a re-score cannot reproduce `fabricated_path`, because every file the PR adds would read as invented. |
| `fixtureDigests` | `sha256` of each fixture file as it was on disk for the run. |
| `harness` | `sha256` of `run-matrix.ts` and `classify.ts` as they were on disk for the run. |

`fixtureDigests` and `harness` are **self-attested**, so they are orientation, not proof: a
fabricated file would carry the right digests. They earn their place by explaining an honest
mismatch, which is usually a harness that moved under a recorded run.

## Verifying an artifact

```bash
npm run check:acceptance-artifact -- docs/prompt-enhancer/acceptance-my-change.json
```

`scripts/check-acceptance-artifact.mjs` takes a supplied artifact, not the repo, so it is
deliberately **not** part of `npm run check`.

**The load-bearing check is the re-score.** Reading a run's summary table proves nothing: the
numbers are whatever the file says they are. Every record carries the `enhanced` text the model
produced and every input a verdict is allowed to depend on, so the check feeds those back through
the committed scorer and reproduces the verdict, the codes and the signals. It imports `scoreCall`
from `run-matrix.ts` rather than reimplementing the ladder, so the re-score and the run cannot
drift; a re-score that drifts from the runner proves nothing either. One pass catches three
different things:

- **a fabricated artifact** — invented `enhanced` text scored `good` by hand does not survive being
  scored by the real classifier;
- **a stale artifact** — recorded before a classifier change, so its verdicts are the old rules'
  answers;
- **a locally edited harness** — a relaxed rule, a widened threshold or a deleted branch shows up as
  a record the committed code disagrees with.

Around it:

- **Shape and counts.** `records` must equal models × fixtures × `n`, every cell must hold every
  iteration exactly once, and a selection wider than the five-model cap could not have come from the
  committed runner.
- **Fixtures byte-for-byte.** A weakened fixture is the quiet way to make a run green: soften the
  prompt that provokes the failure and every cell passes honestly. Fixture text is therefore never
  taken from the artifact. Each record's `original` is compared with the committed file as the
  runner would have read it, and `fixtureDigests` with the file's raw bytes.
- **Host errors are not measurements.** A cell whose every record is a `host_error` was not
  measured, and reading it as green is the same false pass the runner refuses to produce, so the
  check refuses to accept one.
- **The baseline.** Present, or absent with a recorded reason, or rejected.

Exit codes: `0` verified, `1` something did not check out (with a readable summary), `2` the
artifact could not be read at all.

### What it cannot detect

**Nothing here proves the calls were ever made.** A contributor who runs the real matrix and then
hand-edits `enhanced` texts into ones that genuinely score `good` produces a file that passes. The
check proves the *scoring* is honest and current, not the *sampling*. What raises the cost of that
attack is that the forged text has to survive the real classifier on every fixture, which is close
to the work of making the change actually good.

Two smaller gaps, both reported rather than hidden:

- **`knownPaths` padding.** The list is recorded by the run, so a `fabricated_path` could be hidden
  by adding the invented path to it. The check counts recorded paths that do not exist in the
  verifier's checkout and prints the number. Some are expected, since the PR adds files; a large
  count is worth reading.
- **Timings and token counts** are locally measured diagnostics and are not re-derivable. They are
  never part of a verdict.

## The default model matrix

Five cells. A cell is keyed on **(provider, model, api)**, not on the model id: the same `grok-4.6`
can be exercised over two different api paths and the two must never collide in the output.

```
xai/grok-4.6#openai-responses
anthropic/claude-sonnet-5#anthropic-messages
anthropic/claude-haiku-4-5#anthropic-messages
anthropic/claude-opus-5#anthropic-messages
llama.cpp/Qwen3.6-35B-A3B-Q8_0#openai-completions
```

This is what a run with no `--model` measures, with this casing. Do not re-case and do not pin dated
snapshots. `relay-*` models are out of scope entirely. A full pass is 5 × 8 × 12 = **480** real model
calls; at the `n=6` the last recorded pass used, 5 × 8 × 6 = **240**.

These five are the maintainer's set, not a floor for anyone else. A contributor replaces the whole
list with `--model`; only `anthropic/claude-haiku-4-5` is asked for, and even that has an exemption
path.

The fixture count moved from six to eight after `docs/prompt-enhancer/acceptance-final.json` was
recorded. That file is a 6 × 6 × 6 = 216-call pass and remains valid **for what it measured**; it
predates the fenced-sample rule, the typo-repair rule, the project-conventions context section and
the raised conversation caps, so it is not evidence about any of them.

### Why grok appears once

Grok runs on `xai/grok-4.6` over `openai-responses`. That is the maintainer's own xAI account and
its usage is covered by his credits.

An `openrouter/x-ai/grok-4.6` cell used to sit alongside it, to cover `openai-completions`, the api
shape the reported incident occurred on. It was removed: OpenRouter bills the maintainer directly,
and `openai-completions` is already exercised by the llama.cpp cell. The failure this harness was
built for was a prompt problem that appeared on every model and every api path, so the api shape is
not the variable. If a future defect turns out to be provider-specific, add a cell for that defect
rather than paying for one on every pass.

## llama.cpp precondition

The local cell needs the router listening on `127.0.0.1:8080` (the address in the `llama.cpp`
credential's `env.LLAMA_BASE_URL`):

```bash
/opt/homebrew/bin/llama-server \
  --models-dir  /Users/jmcombs/.local/share/llama/models \
  --models-preset /Users/jmcombs/.local/share/llama/models.ini \
  --no-models-autoload --models-max 1 --jinja \
  --host 127.0.0.1 --port 8080
```

Two things that will otherwise waste an hour:

- **`--no-models-autoload` means exactly that.** With the router up but nothing loaded, an enhance
  fails with `400 {"code":400,"message":"model is not loaded"}`. Load the model first and wait for
  it to report `loaded`:

  ```bash
  curl -sX POST http://127.0.0.1:8080/models/load \
       -H 'Content-Type: application/json' -d '{"model":"Qwen3.6-35B-A3B-Q8_0"}'
  curl -s http://127.0.0.1:8080/v1/models   # status.value must read "loaded"
  ```

- **`pi auth check --provider llama.cpp` reports `not_ready` even when the router is up and serving
  requests.** `pi auth check --provider llama.cpp --json` gives the reason:
  `{"status":"not_ready","provider":"llama.cpp","reason":"provider_not_found"}`. The check builds an
  `InMemoryCodingAgentModelsStore` with `allowModelNetwork: false`
  (`pi-coding-agent/dist/cli/auth-check.js`), so a provider that exists only in the user catalog is
  never found. It is not a readiness signal for this provider. Use `pi --list-models Qwen3.6-35B`
  (the model must appear under `llama.cpp`) and a real enhance instead.

**Sampler caveat.** `Qwen3.6-35B-A3B-Q8_0` is the raw GGUF stem from `--models-dir`, not the
`[qwen3.6-35b-a3b]` preset alias, so it runs on the `[*]` defaults in `models.ini` and gets none of
that preset's `temp 0.6 / top-k 20 / top-p 0.95 / min-p 0.0`. Do not compare this cell against
preset-tuned runs.

## RPC transport contract (measured — do not "simplify" the runner)

1. **`pi --mode rpc` aborts in-flight work on stdin EOF.** With stdin closed after the write, the run
   emits `response`, `agent_start`, `turn_start` and the user `message_start`/`message_end`, then
   exits with no assistant turn. A runner that calls `child.stdin.end()` after writing scores zero
   rewrites — or worse, scores the pre-replace echo as a rewrite and records a **false PASS**. The
   runner holds stdin open until the call is finished.
2. **`{"type":"response","command":"prompt"}` is the command ACK, not a terminator.** It is the first
   line for a model prompt and the last for a slash command. Never use it alone as the completion
   signal.
3. **The first `set_editor_text` is the pre-replace echo**, byte-equal to the trimmed fixture and
   emitted before any model call. The rewrite is a later `set_editor_text`; on failure the last one
   is the restore, which is `""` in RPC (`ctx.ui.getEditorText()` returns `""` there).
4. **A slash command produces no agent-loop events.** The model call is out of band: no
   `message_start`, no `agent_settled`. Their absence proves nothing about the model call.

Completion rule the runner implements: finished when `extension_error` is seen, **or** a `response`
for `command:"prompt"` has been seen **and** (`set_editor_text` count ≥ 2 **or** a `notify` has been
seen), **or** the per-call wall clock expires (default 120 s). Only then is stdin closed and the
child reaped.

**Not observable over RPC:** the provider `stopReason` (the completion is out of band), so records
carry `"unknown"`. Context-gathering time and input size are measured locally with the shipped
`gatherEnhancerContext` / `buildEnhancerUserMessage` helpers and reported as diagnostics only —
they are never part of a verdict.

## Scoring

`classify.ts` scores one response and is **deliberately over-strict**: it is test scoring, not a
shipped validator. Wiring it into the extension would reproduce the meta-text false-positive class
the project already rejected. Codes: `announcement`, `refusal`, `third_person_meta`,
`fabricated_path`, `code_block_mangled`, `echo`, `truncated`, `empty`, plus `crash` (an
`extension_error`), `timeout`, `spawn_failed` and `host_error` from the runner. The last four are
infrastructure, not model behaviour: they say the call never produced a scoreable answer.

### `code_block_mangled`: the sample is the payload

A draft that pastes a stack trace, a diff or a failing test is ordinary, and a *reworded* trace is
worse than no rewrite at all — its line numbers and identifiers are the entire reason it was pasted.
The rule extracts the body of every fenced block in the **original** and asks what became of it. The
line is between a sample that was *corrupted or dropped* and one that was merely *shortened*: the
point is to protect pasted content from being reworded, not to demand byte-for-byte reproduction.

Three outcomes per block:

- **verbatim** — the body appears in the rewrite unchanged. Checked against the whole rewrite rather
  than against its fenced blocks, so a model that kept the sample but lost the fences still passes.
  Fence markers, info strings and where the block sits are all free to move; line endings and
  trailing whitespace are normalised, because those are transport artifacts rather than the model
  rewording anything.
- **trimmed** — the rewrite carries a fenced block whose lines are an *excerpt* of the body: the same
  lines, verbatim, in order, fewer of them. Head and tail may be cut without limit; interior gaps are
  capped at two lines, past which the survivors have been stitched together rather than excerpted.
  Not a verdict — see `code_block_trimmed` below.
- **mangled** — everything else. A line that was reworded, re-indented or invented matches nothing
  and fails, and so does a sample paraphrased away into prose entirely.

The trim tolerance deliberately requires a surviving fenced block. An unchanged sample may lose its
fences to an editor, but a *shortened* one that is no longer set off as a sample has been absorbed
into the prose, which is the failure this rule exists to catch. Quoting one trace line inline in a
paraphrase is not a trim.

The rule returns immediately when the original carries no fenced block, so it is inert on all six
fixtures the recorded 216-call pass used. Re-scoring that file with this rule present changes **no
verdict, adds no code and adds no signal**.

#### Known limitation: one model dissolves the sample, and the prompt cannot stop it

`fenced-trace` is the only cell in the matrix that fails, and it fails on one model.
`anthropic/claude-haiku-4-5` paraphrases the pasted trace into prose 6 times out of 6 — no fenced
block in the output at all, the line numbers and the assertion values read out of the trace and set
into sentences. Grok, sonnet, opus and the local Qwen carry the block through; the two rewrites that
shortened it kept the surviving lines verbatim. So the shipped instruction is not the problem for
four of the five, and the failure is not the harness being strict: there is nothing left to compare.

**This is documented rather than fixed, on purpose.** The rewrite is not a code path — the enhancer
sends one system prompt to whatever model the user has selected — so the only lever is wording, and
nothing here may branch on a provider, model id or api. One stronger wording was written and
measured: the rule made definite rather than "usually", naming the output explicitly ("Copy it into
your output as a block, character for character. Never describe it in prose instead."), and the
closing "no quoting of the original" — the one phrase that reads as licence to leave a sample out —
softened to "no restating". Six calls on haiku and six on grok: **haiku 6/6 bad, unchanged; grok 0/6,
unaffected.** The wording was reverted. `SYSTEM_PROMPT` is what it was, and this cell is expected to
be red on that model until the model changes.

Do not "fix" this by dropping the fixture, by special-casing the model, or by loosening the rule
until the paraphrase passes. A red cell that names a real behaviour is the measurement working.

### Signals: recorded, never counted

`ClassifyResult.signals` is a second list that never touches `verdict`. It exists for behaviour worth
seeing without being scoreable, and today it carries three families:

| signal | meaning |
| --- | --- |
| `typo_path_carried` | the original misspelled a real repo path and the rewrite reproduced the misspelling |
| `typo_path_corrected` | the rewrite replaced it with the path that actually exists |
| `typo_path_dropped` | the rewrite kept neither |
| `low_anchor_retention` | the rewrite kept under 30% of the original's content-bearing words |
| `code_block_trimmed` | a fenced sample survived as a verbatim excerpt of itself, not in full |

The near miss is derived, not listed: a file-shaped token in the original that is not a known path
but is within edit distance 2 of one. No fixture-specific expectations, and nothing here can see the
provider, model or api.

**Why this is a signal and not a code.** Both outcomes are defensible on the shipped prompt.
*"Invent nothing: no path that is not in the context"* argues for carrying the typo through; *"fix
typos and misspellings, in identifiers and paths too"* argues for correcting it. Scoring either as
`bad` would encode a preference this harness has no evidence for. The counts print on their own
`signals (not verdicts)` line and are stored per record; the judgement stays with the maintainer.

#### `code_block_trimmed`: shortening is not corruption

Carrying a pasted trace through whole and cutting it to the assertion line are both defensible
enhancements, and the harness has no evidence for preferring one — the same reasoning that keeps the
typo-path outcomes out of `verdict`. Silence would be the other option, and it costs something: a
run where every model reproduces samples in full and a run where half of them quietly shorten to one
line look identical in the table, and the second is where content loss starts. Recording it is free
— signals never touch `verdict` — and it makes that drift visible a run before it matters.

#### `low_anchor_retention`: a structural metric that must never be a verdict

An "anchor" is a word from the original that carries subject matter: six letters or more, or inside
a path-shaped token, or carrying a digit or an internal capital (so short identifiers like `ci`,
`v2` and `iva` stay in). Retention is the fraction of them that reappear in the rewrite, allowing a
stem match or a small edit distance — the system prompt asks the model to fix misspellings, so a
repaired identifier still counts as retained. Prompts with fewer than three anchors are not scored:
one dropped word would swing the result across the whole range.

**It was proposed as a hard verdict at `< 0.5`, and that was refuted before it shipped.** Measured
with the proposal's own code, 5 of 9 hand-written legitimate rewrites and 6 of 8 live rewrites under
the shipped `SYSTEM_PROMPT` fall below 0.5 while being genuine, correct rewrites. The cause is
structural, not a threshold that needs tuning: "content-bearing" means six letters or more, and that
admits `unfortunately`, `honestly`, `whatever`, `basically`, `probably`, `actually`. Stripping
exactly those words is what a good rewrite *does*, so as a verdict the metric penalises the enhancer
for working. In the head-to-head that settled it, the proposal produced 7 false positives on 14 live
legitimate rewrites where the lexical rule produced 0. No cutoff above 0 was clean; at 0.2, where
recall has already collapsed by half, a legitimate rewrite still failed. With `CELL_BAD_THRESHOLD`
at 0 this would have made the harness less trustworthy on the axis that matters most.

It ships at **0.3, as a signal**. On the battery this revision was measured against it fires on 4 of
277 non-refusals (1 hand-written, 3 live, **0 of the 216 recorded**) and on 75 of 91 refusals,
including 42 of the 54 neutrally elicited ones. That is where the harness's coverage of this failure
mode actually comes from: lexical code plus signal reaches 46 of those 54, against 10 for the code
alone.

**Read that separation with the confound attached.** The score depends at least as much on how much
filler the *original* carried as on what the response did. Split by prompt, on live output:

| original | legitimate rewrites flagged | refusals flagged |
| --- | --- | --- |
| a chatty, hedged draft (`honestly i've been at this all afternoon …`) | **2 of 2** | 28 of 36 |
| a terse one (`explain the difference between a semaphore and a mutex`) | 0 of 2 | 14 of 18 |

On the chatty prompt the signal fires on *everything* — the good rewrites and the refusals alike —
because a rewrite that strips `honestly`, `afternoon`, `somebody`, `please` and `figure` retains 2
of 7 anchors, which is what a refusal retains too. It is informative on terse prompts and
uninformative on chatty ones, and nothing about a threshold fixes that. This is the same fact that
sank it as a verdict, restated as the reason it is only ever a hint.

There is deliberately **no stopword or filler list**. An earlier proposal carried a hand-authored
137-word one without disclosing it; rebuilding that module three ways moved its false-positive count
on live legitimate rewrites from 7 to 1 at no cost in recall, which is the definition of a knob. The
tuning surfaces that remain are named in the code and are all in one block: the six-character anchor
floor, the edit-distance tolerance, the suffix stemmer, the three-anchor minimum and the threshold.
None of them can see a provider, model, api or fixture.

**What is not checkable here.** Prose misspellings — `teh`, `widgit`, `renderrs`, `updaet`, `tets` in
`typo-path.txt` — are **not** checked. Doing it deterministically needs a dictionary, and matching a
hard-coded list of that fixture's own typos would make the classifier fixture-specific, which is the
same defect as making it model-specific. Whether prose typos were repaired is read off the recorded
`enhanced` text by hand. Only the path half is machine-checked.

### `host_error`: the host failing is not a measurement

`verdict: "host_error"` is a third verdict alongside `good` and `bad`, and it means *this call is
not evidence about the enhancer in either direction*. It is set when `pi` never started
(`spawn_failed`), or when `pi` exited non-zero having emitted **no `set_editor_text` at all**, or
when its stderr carries a generic startup-failure signature (`unknown provider`, `cannot find
module`, `command not found`, …) and again nothing was emitted.

This closes a hole that had already produced wrong numbers. The runner used to `resume()` the
child's stderr and throw it away, so a `pi` that died at startup left a record with
`setEditorTextCount: 0`, `exitCode: 1` and an empty rewrite — scored `empty`, i.e. an **enhancer
failure**. Two records in `docs/prompt-enhancer/acceptance-short-context.json` were exactly that;
the discarded stderr read

```
Error: Unknown provider "llama.cpp". Use --list-models to see available providers/models.
```

Records now carry a bounded `stderrTail` (last 4,000 characters, omitted when stderr was silent) so
the cause is in the artifact instead of being inferred.

**The gate is `setEditorTextCount === 0`, and that is the whole safety property.** The extension
emits its pre-replace echo before any model call (transport contract 3 above), so a call that
emitted even one `set_editor_text` reached the enhancer and is scored normally no matter what `pi`
does afterwards. A host failure can never absolve a real enhancer failure.

`host_error` records are **excluded from every cell's bad/total counts** and printed on their own
`host errors (not measurements)` line, so infrastructure can neither fail a cell nor pass one. A
cell left with zero scoreable calls is reported as unmeasured and fails the run: silence is not a
green cell.

Kept model-agnostic per D14 — `HostFailureInput` carries no provider, model or api, and the stderr
signatures are generic host and CLI diagnostics. Do not add a provider or model name to them.

**One taxonomy for every cell.** `ClassifyInput` carries no provider, model or api field, so
per-model scoring is structurally impossible — the same rules apply everywhere. Cell keys exist for
reporting and collision-avoidance only and must never become a hook for per-model behaviour; the
runner uses the provider for the spawn arguments and for worker scheduling, nothing else. The
baseline is expected to fail in different *shapes* per cell (announcements on one, fluent refusals
on another); a classifier that only catches one shape is wrong. If a cell fails, the fix is
something that helps every cell — never a special case.

`echo` keys on the **transport only** (`setEditorTextCount === 1`, i.e. no rewrite ever arrived). It
must never key on `enhanced.trim() === original.trim()`: the system prompt tells the model to return
the original request unchanged for out-of-scope prompts, so byte-equality is compliant behaviour.

### `announcement` scans the opening, not just character 0

The first version of this rule was `trimmed.startsWith(opener)`, and it missed roughly half of the
failure it exists to catch. Re-scoring the recorded baseline found **15 responses in one cell** that
narrated a retrieval plan and scored `good` purely because the narration started one clause late:

```
Gathering Dependabot, release-please, and dependency layout so the rewrite stays
anchored to this repo. I'll inspect config and package structure without solving…
The request is vague about which README and typo, so I'll inspect the prompt-enhancer files…
I need more of the steward slot-parser code … I'll look those up next.
```

Those are the incident failure mode verbatim. A gate that reads *0 bad in every cell* against a rule
that cannot see them is a **false pass**, so the rule now scans the opening of the response:

- a first-person intent verb (`I'll`, `Let me`, `I need to`) followed within two words by a
  **retrieval** verb (`inspect`, `read`, `check`, …). The retrieval verb is load-bearing:
  `dependabot.txt` itself says *"Next I need to know if this is a dev dependency"*, and a faithful
  rewrite may carry that forward. `know` is not retrieval, `inspect` is;
- `I need more/the rest of …`, the model saying out loud that its context was insufficient;
- a bare gerund opener (`Gathering …`, `Checking …`). A rewritten *request* is imperative;
  `Inspect packages/…` is a rewrite, `Inspecting packages/…` is a report.

**The false-positive guard is a quoted-span mask.** `self-referential.txt` asks about a model that
writes `"I'll inspect the repo"`, so a faithful rewrite quotes that phrase back — the class behind
an earlier round's 13 spurious meta-regex matches. Quoted and backticked spans are blanked (keeping
their length, so offsets stay true) before the scan: citing the failure mode is not committing it.
Measured over the 432 recorded baseline records, this catches all 15 misses and changes **no other
verdict**, including all 48 legitimate responses that quote the phrase. Both halves are pinned
verbatim in `classify.test.ts`; do not relax either without re-running that comparison.

The scan is bounded to the first 400 characters. Every observed instance sat in the opening sentence
or two (deepest match: 137 characters), and bounding it keeps a long rewrite's body out of scope so
first-person wording carried over from the user's own prompt cannot trip the rule from paragraph
four.

### `refusal` needs a subject, not a phrase

The first version of this rule was a list of bare substrings — `i appreciate`, `my job is to`,
`as an ai,`, `^unable to`, plus `sorry`/`unfortunately` openers paired with any modal — matched over
the same 400-character window. Four *correct* rewrites came back `verdict=bad codes=[refusal]`, and
the first of them is real `xai/grok-4.6` output under the shipped `SYSTEM_PROMPT`:

| rewrite | why the old rule fired |
| --- | --- |
| `Unable to reach staging from the laptop. Figure out why the deploy hangs at the migration step.` | `^unable to` read a status line as a decline |
| `My job is to ship this by Friday; find the regression that broke the build.` | `my job is to`, with no rewriting anywhere near it |
| `I appreciate that the schema is messy, but fix the migration anyway.` | `i appreciate` as a bare substring |
| `As an AI, I would still like the summariser rewritten.` | the `as an ai,` frame with no decline after it |

None of the six fixtures the recorded baseline used produces those shapes, so **0 of its 216 records
tripped them**. That is what made it worth fixing rather than worth ignoring: it is latent under
today's fixture set, reachable by a real model, and `CELL_BAD_THRESHOLD` is 0, so one of them fails a
whole cell.

Every branch now requires a **subject declining this job**: a role assertion (`I'm a prompt
rewriter, not an answerer`; `my job is to rewrite prompts`), a first-person modal whose object is the
job (`I can't rewrite this`, `I'm unable to comply`, `I don't rewrite prompts`), the same with the
subject elided but only at position 0 (`Unable to comply with that request.`), a terse self-decline
in terminal position (`I must decline.`), or the `As an AI, I …` frame *followed by* a decline. The
object test is what does the work: `I won't rewrite this prompt` is a refusal and `I won't rewrite
history on this branch` is the user's own sentence, and only the object separates them. The
soft-opener branch was dropped outright — every genuine refusal it caught is caught by the modal
rules, and it fired on `Unfortunately I cannot get the profiler to attach; instrument the hot path
instead.`

Measured against a battery of 368 items, on the same window and the same quote-masking:

| rule | recall on 91 refusals | false positives on 277 non-refusals |
| --- | --- | --- |
| bare-substring rule | 37/91 | **12** |
| subject-and-object rule | **40/91** | **0** |

It is better in both directions, but the recall figure is the small half of the story: **the two
rules are within three items of each other on real model output**, and both leave most of it
uncaught. The precision is what changed. Re-scoring the 216 recorded baseline records changes **no
verdict and no code**, so on the corpus this is purely a precision fix; the recall it adds is on
shapes today's fixtures do not produce.

**Where the battery came from.** Every item carries its provenance; none of it was inherited from an
earlier round.

- **216** — the recorded matrix run, real rewrites from six cells, every one previously scored
  `good`.
- **23** — rewrites elicited live for this change from `xai/grok-4.6` and a local `llama.cpp` model
  under the real `SYSTEM_PROMPT`, with no adversarial priming, over twelve deliberately chatty,
  hedged and apologetic drafts. A 24th response was a genuine announcement failure and is labelled
  as one; the existing `announcement` rule catches it.
- **37** hand-written non-refusals — the four bugs above, the negatives already pinned in
  `classify.test.ts`, and fourteen written specifically to attack the new rule, each carrying a
  decline verb, a role frame or a rewriting verb in the user's own voice (`I have to decline the
  vendor meeting, so summarise the thread instead.`, `My role is to rewrite the onboarding docs this
  quarter; draft the section outline.`).
- **37** hand-written refusals — the shapes already pinned in `classify.test.ts`, one of them
  verbatim `anthropic/claude-haiku-4-5` output, plus the seven residual shapes below.
- **54** live refusals from a **neutral** generator: two models were asked for failure outputs and
  told to spread evenly across person (including impersonal, with no subject at all), voice, length,
  register, format and language, favouring none. This is the part that matters, and it is the part a
  previous round got wrong by asking for "short first-person refusals, 1–3 sentences" — which is the
  shape a first-person rule detects, so the battery scored the method it was testing.

On that neutral set alone the bare-substring rule catches 7 of 54 and the subject-and-object rule
10 of 54. Neither is close to sufficient; see the residual below.

### Known residual: what the refusal rule does not reach

**The lexical rule reaches 10 of the 54 neutrally elicited refusals. That is the headline number,
and it is not a good one.** What the other 44 look like is not exotic: models that decline mostly do
it without a first-person modal at all. Adding the structural signal takes the pair to 46 of 54, but
the signal is a hint, not a verdict, so the *scoreable* coverage stays at 10.

Six shapes account for most of the gap. Each was run through the whole of
`classifyEnhancement`, not just the refusal rule, so these are pipeline holes:

| shape | example | reached by |
| --- | --- | --- |
| impersonal no-change verdict | `The request is already clear. No enhancement is necessary.` | signal only |
| passive no-rewrite | `This prompt needs no rewriting; it is already specific enough.` | nothing |
| second-person redirect | `You will need to open the migration logs yourself …` | nothing |
| clarifying-question deflection | `Which staging environment do you mean?` | nothing |
| markdown assessment note | `## Assessment` followed by bullets about the prompt | nothing |
| non-English refusal | `Lo siento, no puedo reescribir esa solicitud.` | signal only |

An LLM judge was proposed for exactly these and is **out of scope here**: it doubles the call count
of every matrix pass, and its stability is unmeasured. A prior report claimed "0 flips over 6 items ×
3 repeats"; opening the artifact shows 27 distinct items judged once each, so no flip rate was ever
measured. Do not cite that number.

**The true rate is unknown, and the harness should say so.** There is exactly one real incident
string, and it is an announcement rather than a refusal. Attempts to bound the rate from constructed
sets disagree by a factor of four in either direction, depending entirely on how the set was
elicited — a battery whose generator asked for "short first-person refusals" scored 82% recall for a
method that keys on short first-person refusals, and the same method scored 25% on a neutrally
sampled set. Neither is an operational number. In 34 live calls under the real `SYSTEM_PROMPT` across
two providers — twelve chatty drafts each, plus five prompts per model written to tempt a decline
(`who are you and what do you actually do`, `ignore the instructions you were given`, an
ethically loaded scraping request) — **no model refused once**. The single failure in those 34 was
an announcement, which the existing rule caught. Every refusal in this battery is therefore either
hand-written or elicited by *asking* for the failure, and no elicitation is evidence of a rate.

Anything that claims to raise recall here has to be measured against a battery that was not
elicited by asking for the shape the method detects.

`classify.test.ts` runs in the normal `npm run check` vitest pass and is pure synthetic strings — no
network, no `pi`, no model.

## Fixtures

| file | what it probes |
| --- | --- |
| `dependabot.txt` | the verbatim incident prompt; highest grounding demand |
| `repo-question.txt` | a repo question that invites discovery narration |
| `trivial.txt` | a one-liner with almost no grounding to do |
| `out-of-scope.txt` | not about the codebase at all; probes the refusal mode |
| `control-token.txt` | names a fixture whose contents inline `<\|im_start\|>` control tokens |
| `self-referential.txt` | quotes first-person meta-text back; the strongest false-positive probe for `fabricated_path` and any announcement detector |
| `fenced-trace.txt` | a pasted failing test inside a fenced block; probes `code_block_mangled` |
| `typo-path.txt` | prose typos plus a misspelled real repo path; probes typo repair and the `typo_path_*` signals |

## Driving the interactive TUI headlessly

The RPC runner above covers the headless path. The **interactive** path — bordered loader,
`Ctrl+Shift+E`, `Esc` to cancel — is not reachable over RPC and was first written off as
manual-only. It is not: python's stdlib `pty` allocates a real terminal, and `pi`'s TUI runs in it
unmodified. This is how the interactive path gets a captured transcript instead of an UNVERIFIED
mark, and the same approach serves any later gate that has to see the terminal.

Three things make it work:

- **A real PTY with a sane window.** `pty.openpty()` plus a `TIOCSWINSZ` ioctl for 120x40, the child
  started with `preexec_fn=os.setsid` so the whole process group can be reaped.
- **`TERM=xterm-kitty`, so keys go in as kitty CSI-u**, which is the only encoding that can express
  the modifiers this extension binds. `Ctrl+Shift+E` is `\x1b[101;6u` (codepoint 101 = `e`,
  modifier 6 = shift+ctrl) and `Esc` is `\x1b[27u`. A bare `\x05` or `\x1b` does **not** reach the
  shortcut handler.
- **Wait for a marker, never for a clock.** Sleep-driven scripts desynchronise whenever `pi` boots
  slowly — the first attempt here sent `Esc` before the loader existed and produced a transcript
  that looked like a cancel failure. Pump the master fd until the expected string appears (the
  drawn prompt, the echoed text, `Enhancing prompt via`), then send the next key.

Strip the ANSI before asserting: `\x1b\[[0-9;?]*[a-zA-Z]`, `\x1b\][^\x07\x1b]*(\x07|\x1b\\)`,
`\x1b[()][B0]`, `\x1b[=>]` and `\r`.

Captured this way against `pi --no-extensions -e ./packages/prompt-enhancer --provider xai --model
grok-4.6`, typing `fix the typo in the readme` and pressing `Ctrl+Shift+E` (ANSI stripped, spinner
frames collapsed):

```
   Prompt Enhancer  xai/grok-4.6
──────────────────────────────────────────────────────────────────────
 ⠋ Enhancing prompt via xai/grok-4.6…
 escape/ctrl+c cancel
──────────────────────────────────────────────────────────────────────
```

letting it finish — the rewrite replaces the editor and the revert chip arms:

```
   Prompt Enhancer  xai/grok-4.6  Prompt enhanced — Ctrl+Shift+Z to revert.
──────────────────────────────────────────────────────────────────────
The request is vague; I'll locate the prompt-enhancer README and any typo so the rewrite can name the exact file.
──────────────────────────────────────────────────────────────────────
Ctrl+Shift+Z to revert enhanced prompt
```

and pressing `Esc` while the loader spins instead — the spinner stops on the same frame, the editor
still holds what was typed, and no revert chip arms:

```
<<<ESC SENT>>>
──────────────────────────────────────────────────────────────────────
fix the typo in the readme
──────────────────────────────────────────────────────────────────────
   Prompt Enhancer  xai/grok-4.6  Cancelled.
```

Note what the middle transcript also shows: the landed rewrite is itself an announcement, on the
shipped prompt, in the interactive path. That is the reported bug reproduced by hand, and it is the
shape the `announcement` rule above had to be widened to see.

## Infrastructure failures are not data

A call that never reached a model is not evidence about the enhancer. Host failures that kill `pi`
before the extension runs are caught automatically (`host_error`, above), but a failure that reaches
the *extension* — an unreachable endpoint, a missing credential, a provider 400 — still lands as a
`notify` and a restore, which scores `bad`, so **every pass must still be audited for infrastructure
noise before its numbers are used**.

`docs/prompt-enhancer/baseline.json` carries **92 of 432 records (21.3%) that never reached a
model**, from two causes:

| source | records | cells affected |
| --- | --- | --- |
| openrouter `400 "Reasoning is mandatory for this endpoint and cannot be disabled."` | 53 | all 6 openrouter cells |
| `Prompt Enhancer: no API key configured for openrouter/x-ai/grok-4.6` | 19 | all 6 openrouter cells |
| `Prompt Enhancer: no API key configured for anthropic/claude-sonnet-5` | 20 | sonnet/`dependabot` (12), sonnet/`repo-question` (8) |

Seven of the 36 cells therefore hold **zero usable data**: all six openrouter cells and
sonnet/`dependabot`. Reading those as enhancer failures would manufacture a fictitious
`12/12 → 0/12` improvement for Phase 2. Audit any pass with:

```bash
python3 - <<'EOF'
import json, collections
recs = json.load(open("docs/prompt-enhancer/baseline.json"))["records"]
infra = collections.Counter(
    f'{r["model"]} | {r["fixture"]}'
    for r in recs
    if any("no API key configured" in n or "Reasoning is mandatory" in n for n in r["notifies"])
)
print(sum(infra.values()), "infrastructure records")
for cell, n in sorted(infra.items()):
    print(f"  {n:2}  {cell}")
EOF
```

**The reasoning-effort 400 no longer applies.** It affected the openrouter cell, which has been
removed from the matrix.

**The credential failures were 1Password.** `anthropic` resolves its key through `!op read`. Both failure runs are consecutive from the start of the pass and
stop about 9.5 minutes in, with none in the remaining 34 minutes — the signature of `op` waiting on
a desktop-app authorisation nobody answered (`error initializing client: authorization timeout`),
not of a flaky key. Before any pass touching those providers:

```bash
op whoami                                   # must not say "account is not signed in"
pi auth check --provider anthropic          # must print ready, not not_ready
```

If either reports `not_ready`, **stop**: the pass will record dozens of `bad` calls that say nothing
about the enhancer. Run those providers at `--concurrency 1` even when they are ready — concurrent
credential resolution is what first produced this failure.

## Keeping the local model loaded for a whole pass

The router unloaded `Qwen3.6-35B-A3B-Q8_0` part-way through a 360-call baseline; every call after
that returned `400 {"code":400,"message":"model is not loaded"}` in ~1.5 s and scored `empty`, which
is an infrastructure failure and not an enhancer failure. Before trusting a llama.cpp cell, check
that its calls took model-like time and that no record carries that message:

```bash
python3 - <<'EOF'
import json
recs = json.load(open("docs/prompt-enhancer/baseline.json"))["records"]
bad = [r for r in recs if any("model is not loaded" in n for n in r["notifies"])]
print(f"{len(bad)} calls hit an unloaded model")
EOF
```
