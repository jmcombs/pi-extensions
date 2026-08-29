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

## Running it

```bash
# full matrix: 6 cells × 8 fixtures × n=12 = 576 real model calls
npx tsx packages/prompt-enhancer/acceptance/run-matrix.ts --n 12 \
  --out docs/prompt-enhancer/baseline.json

# a single cell
npx tsx packages/prompt-enhancer/acceptance/run-matrix.ts --n 3 \
  --model anthropic/claude-haiku-4-5 --fixture out-of-scope --out /tmp/one-cell.json
```

Flags: `--n <count>`, `--model <cell key or provider/id>` (repeatable), `--fixture <name>`
(repeatable), `--out <path>`, `--timeout-ms <ms>` (default 120000), `--concurrency <n>` (default 3).

`--model` takes either a full cell key (`xai/grok-4.6#openai-responses`) or a `provider/id` when
that is unambiguous. Grok appears twice, under different providers and ids, so `provider/id` still
resolves: `xai/grok-4.6`.

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

## The model matrix (locked)

Six cells. A cell is keyed on **(provider, model, api)**, not on the model id: the same `grok-4.6`
is exercised over two different api paths and the two must never collide in the output.

```
xai/grok-4.6#openai-responses
anthropic/claude-sonnet-5#anthropic-messages
anthropic/claude-haiku-4-5#anthropic-messages
anthropic/claude-opus-5#anthropic-messages
llama.cpp/Qwen3.6-35B-A3B-Q8_0#openai-completions
```

Exactly these six, with this casing. Do not re-case, do not pin dated snapshots, do not add or
substitute. `relay-*` models are out of scope entirely. A full pass is 6 × 8 × 12 = **576** real
model calls; at the `n=6` the last recorded pass used, 6 × 8 × 6 = **288**.

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
The rule extracts the body of every fenced block in the **original** and requires each to appear in
the rewrite verbatim. Fence markers, info strings and where the block sits in the rewrite are all
free to move; line endings and trailing whitespace are normalised, because those are transport
artifacts rather than the model rewording anything. Everything else, including indentation inside a
line, must match.

The rule returns immediately when the original carries no fenced block, so it is inert on all six
fixtures the recorded 216-call pass used. Re-scoring that file with this rule present changes **no
verdict and adds no code**.

### Signals: recorded, never counted

`ClassifyResult.signals` is a second list that never touches `verdict`. It exists for behaviour worth
seeing without being scoreable, and today it carries one family:

| signal | meaning |
| --- | --- |
| `typo_path_carried` | the original misspelled a real repo path and the rewrite reproduced the misspelling |
| `typo_path_corrected` | the rewrite replaced it with the path that actually exists |
| `typo_path_dropped` | the rewrite kept neither |

The near miss is derived, not listed: a file-shaped token in the original that is not a known path
but is within edit distance 2 of one. No fixture-specific expectations, and nothing here can see the
provider, model or api.

**Why this is a signal and not a code.** Both outcomes are defensible on the shipped prompt.
*"Invent nothing: no path that is not in the context"* argues for carrying the typo through; *"fix
typos and misspellings, in identifiers and paths too"* argues for correcting it. Scoring either as
`bad` would encode a preference this harness has no evidence for. The counts print on their own
`signals (not verdicts)` line and are stored per record; the judgement stays with the maintainer.

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
