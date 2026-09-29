# Pi 0.86 and 0.87.1 extension compliance

Make every publishable extension, and the `_template` scaffold, comply with the
three breaking changes shipped in pi `v0.86.0`, and with the `v0.87.0` changes
that actually hit these packages, on the latest published pi. This revision
re-ran `npm view @earendil-works/pi-coding-agent version`,
`npm view @earendil-works/pi-ai version`, and
`npm view @earendil-works/pi-tui version`. Each printed `0.87.1`. Each
package's `latest` dist-tag is `0.87.1`. `v0.86.1` and `v0.87.1` add no further
breaks. The floor is `^0.87.1`, not `^0.86.1`. Custom providers must read
prompts and tools from transcript system messages when the host does not pass
the legacy keys. `user_bash` fails closed. Tool-result `details` and
`ToolCall.arguments` must be JSON-compatible, and `registerTool` rejects a
missing object parameter schema. Headroom's converter must not send
`role: "system"` messages to the proxy. This plan adapts the packages those
contracts actually hit. It does not implement the fixes.

The first phase bumps the root pi devDependencies and fixes relay's transcript
readers together. Relay's `streamSimple` parameter is
`ProviderConfig["streamSimple"]`'s context, which is `TranscriptContext` on pi
0.86+, and `packages/relay/provider.ts` still reads `context.systemPrompt` and
`context.tools`. A bump that leaves those reads in place fails `npm run
typecheck`. A phase that stays on `^0.85.1` also cannot pass `npm run check`:
the installed `@earendil-works/pi-coding-agent@0.85.1` shrinkwrap pins
`undici@8.9.0`, and `npm run check` runs `npm audit --omit=dev` via
`scripts/check-audit.mjs`. On this tree that audit exits 1 with
`GHSA-3wwx-pv8p-q78v` (`undici`). The `v0.87.1` shrinkwrap pins `undici@8.10.2`.
No phase asks for `npm run check` on `0.85.1`.

Phase 1 also moves the only `@earendil-works/pi-*` devDependency pin in
`packages/1password/package.json` from `^0.85.1` to `^0.87.1`. That pin is
`@earendil-works/pi-coding-agent`. A root-only bump leaves it at `^0.85.1`.
Caret on `0.x` does not accept `0.87.1`, so npm nests
`@earendil-works/pi-coding-agent@0.85.1` at
`packages/1password/node_modules/@earendil-works/pi-coding-agent`. Files under
that package then resolve `ExtensionContext` from the old copy.
`packages/1password/credential-api.ts` exports
`UiContext = Pick<ExtensionContext, "ui">`. `onboardSecret` calls in
`packages/context7/index.ts`, `packages/grok-search/index.ts`,
`packages/grok-search/setup.ts`, `packages/headroom/index.ts`, and
`packages/tavily-search/index.ts` pass a context from the hoisted `0.87.1`
copy. That fails typecheck with `TS2345` in context7, grok-search, headroom,
and tavily-search. The verifier reproduced typecheck exit 1 with the nest
present. Once the nest was gone, only the relay `TranscriptContext` errors
remained. Those readers stay in Phase 1 with the root bump. The pin stays in
Phase 1 so the nest is gone before that typecheck. Do not add a root
`overrides` entry. A workspace reproduction with both pins at `^0.87.1` and
no `overrides` hoists `0.87.1` and leaves that nested directory absent. The
same reproduction with the workspace pin left at `^0.85.1` nests `0.85.1`.

Phase 1 still does not edit 1password tests or other 1password source. The
only path under `packages/1password` it may change is
`packages/1password/package.json`, plus the lockfile `npm install` writes.
Phase 1's `npm run check` still sets `HOME` and `PI_CODING_AGENT_DIR` to empty
temp directories, because the factory test is not edited yet. Phase 3 still
adds that isolation inside the tests. Phase 3 still fixes JSON account
details, the fail-closed `user_bash` handler, and the pre-existing `!` / `!!`
env injection. Do not drop the 1password fix.

Changing `packages/1password/package.json` may cause Release Please to open a
1password release pull request after Phase 1 is merged. A Release Please pull
request is not approval to merge it. Do not merge it. Merging it is out of
scope and is not required for Phase 1 to pass. An unmerged Release Please pull
request is not a failed phase.

The `!` / `!!` env injection is a pre-existing bug that predates 0.86. It stays
in the `user_bash` phase because the human approved including it. It is not an
0.86 break.

Phase 4 is assigned Steward quant polish. It is not optional. Phases 1–3 do
not implement it and do not edit Steward production code. The dashboard Quant
field shows `4-bit (Q4_K - Medium)` because it prints llama.cpp `/models`
`meta.ftype`, not the tensors. `meta.ftype` is `"Q4_K - Medium"` when
`general.file_type` is 15 (`MOSTLY_Q4_K_M`). That loaded file had dtype counts
Q8_0 453, F32 360, BF16 53, and Q4_K 0. Those counts are not a `/models` field.

## Authoritative sources

Upstream tags and npm (read for this plan; not vendored):

- `npm view @earendil-works/pi-coding-agent version`,
  `npm view @earendil-works/pi-ai version`, and
  `npm view @earendil-works/pi-tui version` each print `0.87.1`. Each package's
  `latest` dist-tag is `0.87.1`. Re-checked for this revision.
- Release notes: `https://github.com/earendil-works/pi/releases/tag/v0.86.0`,
  `v0.86.1`, `v0.87.0`, and `v0.87.1`.
- `packages/coding-agent/CHANGELOG.md` and `packages/ai/CHANGELOG.md` at
  `v0.87.1`. `## [0.86.0]` has the three breaking bullets. `## [0.86.1]` has no
  breaking section. `## [0.87.0]` has the five breaking bullets below.
  `## [0.87.1]` has no breaking section. `packages/agent/CHANGELOG.md` at
  `v0.87.0` removes `shouldStopAfterTurn`.
- `packages/ai/src/types.ts` at `v0.87.1`: `JsonValue`, `JsonObject`,
  `ToolCall.arguments`, `ToolResultMessage`, `Context` (`systemPrompt?: string`),
  `TranscriptContext`. These JSON and transcript types match `v0.86.1`.
- `packages/ai/src/utils/transcript.ts` at `v0.87.1`: `getCurrentSystemPrompt`,
  `getCurrentTools`, `getCurrentSystemMessage`. `packages/ai/src/index.ts`
  does `export * from "./utils/transcript.ts"`. `packages/ai/src/compat.ts`
  `complete` and `streamSimple` still accept `Context` and call
  `normalizeContext`.
- `packages/coding-agent/src/core/extensions/types.ts` at `v0.87.1`:
  `ProviderConfig.streamSimple` takes `TranscriptContext`; `ContextEvent`;
  `ContextWithSystemEvent`; `ExtensionAPI.on` returns an unsubscribe function.
- `packages/coding-agent/src/core/extensions/loader.ts` at `v0.87.1`:
  `registerTool` throws unless `parameters` is a non-null non-array object
  ("object parameter schema"); `on` returns an unsubscribe function.
- `packages/coding-agent/src/core/extensions/runner.ts` at `v0.87.1`:
  `isUserBashEventResult`, `emitContext` (filters `role !== "system"` before
  `context` handlers, then `restoreSystemMessages`; `context_with_system`
  handlers then see the full transcript and their output is used as returned).
- `packages/coding-agent/src/core/bash-executor.ts` at `v0.85.1`, `v0.86.0`,
  and `v0.87.1`: `operations.exec(command, cwd, { onData, signal })` with no
  `env`. The three files match at that call.
- `packages/coding-agent/src/core/tools/bash.ts` at `v0.87.1`:
  `createLocalShellOperations` uses `env: env ?? getShellEnv()`.
  `createLocalBashOperations` is a public export.
- `packages/coding-agent/src/utils/shell.ts` at `v0.87.1`: `getShellEnv` prepends
  `getBinDir()` to `PATH` when it is absent. `getShellEnv` is not a public
  export. Installed `dist/utils/shell.js` `getShellEnv` finds the path key
  case-insensitively, default `PATH`, and prepends `getBinDir()` with
  `path.delimiter` when that entry is absent.
- `packages/coding-agent/src/config.ts` at `v0.87.1`: public `getAgentDir()`;
  `getBinDir()` is `join(getAgentDir(), "bin")` and is not re-exported from
  `packages/coding-agent/src/index.ts` (that index exports `getAgentDir`, not
  `getBinDir` or `getShellEnv`). Installed `dist/config.js`: `getAgentDir`
  returns `process.env.PI_CODING_AGENT_DIR` when that variable is set, otherwise
  `join(homedir(), ".pi", "agent")`. `getBinDir` is `join(getAgentDir(), "bin")`.
- `packages/coding-agent/docs/extensions.md` at `v0.87.1`, anchors
  `context_with_system` and `user_bash`. `packages/coding-agent/docs/custom-provider.md`
  at `v0.87.1`: read prompts and tools with `getCurrentSystemPrompt` and
  `getCurrentTools`.
- `packages/coding-agent/npm-shrinkwrap.json` at `v0.87.1`: `undici` `8.10.2`.
  The installed `0.85.1` shrinkwrap pins `undici` `8.9.0`.
- oh-my-pi `@oh-my-pi/pi-ai` `src/types.ts` at `v17.0.5` and `v18.4.3`:
  `Context` is `{ systemPrompt?: string[]; messages; tools? }` (v18.4.3 also
  has optional `inactiveTools`). No `TranscriptContext`. No
  `getCurrentSystemPrompt` or `getCurrentTools` (zero hits in both tarballs).
- oh-my-pi `@oh-my-pi/pi-coding-agent` `packages/coding-agent/src/extensibility/legacy-pi-ai-shim.ts`
  at `v18.4.3`: re-exports `@oh-my-pi/pi-ai` via `export *` at line 133. Later
  lines re-export catalog symbols and JSON-repair helpers. The re-export does
  not include `getCurrentSystemPrompt` or `getCurrentTools`.
- oh-my-pi `@oh-my-pi/pi-coding-agent` `packages/coding-agent/src/config/model-registry.ts`
  at `v18.4.3`: `ProviderConfigInput.streamSimple` takes `Context`, and
  `registerProvider` forwards `streamSimple(model, context, options)`. That is
  the dual-read proof that oh-my-pi still passes the legacy shape.
- This repo: `package.json` (the three `@earendil-works/pi-*` devDependencies
  are `^0.85.1`), `packages/1password/package.json` (the only `@earendil-works/pi-*`
  devDependency pin is `@earendil-works/pi-coding-agent` at `^0.85.1`;
  `@earendil-works/pi-tui` is `"*"`; peers stay `"*"`),
  `packages/1password/credential-api.ts` (`UiContext` is
  `Pick<ExtensionContext, "ui">`),
  `packages/1password/index.ts` (`loadShellEnvMap` uses `homedir()`;
  `warmOpSessionIfNeeded` reads `getAgentDir()` auth.json and may `exec` `op`;
  `user_bash` returns `{ operations: piRuntime.createLocalBashOperations() }`;
  bash `spawnHook` spreads `env` then `currentShellEnv`),
  `packages/1password/index.test.ts` (the factory call at the registration test
  does not isolate `HOME`), `packages/relay/provider.ts`,
  `packages/relay/roles/resolver.ts`, `packages/relay/README.md`,
  `packages/relay/index.test.ts`, `packages/better-toolsy/index.ts`
  (`safeResolve` default root is `process.cwd()`; `ls` calls it outside the
  `readdir` try; `grep` catches `safeResolve` and, separately, `fs.stat`),
  `packages/better-toolsy/index.test.ts`, `packages/context7/index.ts`,
  `packages/grok-search/index.ts`, `packages/tavily-search/index.ts`,
  `packages/headroom/index.ts`, `packages/headroom/pi-format.ts`
  (`isPiFormat` is true only for a `toolResult` message or a `toolCall` /
  `thinking` part; `piToOpenAI` maps every other role, including `system`, to
  `user`), `packages/headroom/compress.ts` (non-Pi path calls
  `compress(original)` at the non-Pi branch), `packages/headroom/index.test.ts`
  (`vi.mock("./compress.js")` replaces that module for tests in this file),
  `packages/_template/index.ts`, `TEMPLATE.md`, `tsconfig.json`,
  `vitest.config.ts`, `scripts/typecheck.mjs`, `scripts/check-audit.mjs`,
  `.github/workflows/extension-load.yml` (oh-my-pi pin `17.0.5`),
  `release-please-config.json` (component map is per `packages/<dir>`; there is
  no root component), `VERSIONING.md` (a release PR opens for a package whose
  history contains release-relevant commits),
  `.github/workflows/update-1p-shell-plugins.yml` (a squash merge takes the
  commit message from the PR title). Root `PLAN.md` is the relay phase spec
  and is not a source to edit.
- Steward quant label, read for this revision.
  `packages/steward/core/llama-models.ts` `parseModel` sets
  `const quant = ftype ?? (argQuant !== "" ? argQuant : quantFromId(id))`.
  `quantFromArgs` reads `--model` / `-m`. `quantFromId` uses `QUANT_PATTERN`.
  `packages/steward/core/format.ts` `bitsFromCode` takes the first digit run.
  `formatQuantField`, when confirmed and the code has digits, returns the bit-depth, a space, and the raw code in parentheses.
  `packages/steward/core/select.ts` sets the Quant field with
  `formatQuantField(model.quant, confirmed)`. `packages/steward/core/types.ts`
  `ModelInfo.quant` is a string.
  `packages/steward/core/__fixtures__/llama/models-loaded.json` `meta` keys are
  `vocab_type`, `n_vocab`, `n_ctx`, `n_ctx_train`, `n_embd`, `n_params`,
  `size`, `ftype`. No tensor dtype counts.
  `packages/steward/core/llama-models.test.ts`,
  `packages/steward/core/format.test.ts`, and
  `packages/steward/core/select.test.ts` are the Vitest files.
  `vitest.config.ts` includes `packages/*/**/*.test.ts`. `npm run test` is
  `vitest run`. `release-please-config.json` maps `packages/steward` to the
  `steward` component.
- llama.cpp `b9960` `tools/server/server-context.cpp`
  `server_routes::get_model_info()`, not vendored: `meta` keys are exactly
  `vocab_type`, `n_vocab`, `n_ctx`, `n_ctx_train`, `n_embd`, `n_params`,
  `size`, `ftype`.
- llama.cpp `b9960` `tools/server/server-models.cpp` `get_router_models`, not
  vendored: merges child `loaded_info` and does not add a tensor list. The
  handler comment says other fields may require reading GGUF metadata.
- llama.cpp `b9960` `src/llama-model-loader.cpp` `llama_ftype_name`, not
  vendored: `LLAMA_FTYPE_MOSTLY_Q4_K_M` is `"Q4_K - Medium"`.
  `general.file_type` overrides the tensor-majority guess. Those counts are
  not copied into `/models`. `include/llama.h` at `b9960` sets
  `LLAMA_FTYPE_MOSTLY_Q4_K_M` to 15.
- Nest reproduction, not vendored, run for this revision on npm `11.19.1` with
  no `overrides` and no `install-strategy` (this repo's `.npmrc` sets neither):
  a workspace whose root devDependency `@earendil-works/pi-coding-agent` is
  `^0.87.1` and whose `packages/1password` devDependency is `^0.85.1` installs
  hoisted `0.87.1` and nests `0.85.1` at
  `packages/1password/node_modules/@earendil-works/pi-coding-agent`. The same
  workspace with that devDependency set to `^0.87.1` installs hoisted `0.87.1`
  and that nested directory is absent. The pin alone removes the nest. Do not
  add `overrides`. `tsconfig.json` `moduleResolution` is `NodeNext`, and
  `scripts/typecheck.mjs` runs root `tsc --noEmit`, so that nested copy is what
  `packages/1password` type-resolves. `commitlint.config.js` sets
  `header-max-length` to 100.

## How to use this document

- The builder implements exactly one phase, proves every Testing Gate with real
  command output, opens a PR, and stops. It never ticks checkboxes and never
  merges.
- A fresh verifier re-derives each gate from real output and returns PASS /
  CONDITIONAL PASS / FAIL / BLOCKED.
- Max 3 build→verify rounds per phase; the 3rd FAIL escalates to the human.
- Checkboxes are ticked by the verifier only. Merges are human-gated.
- TODO file paths are literal specs. Build exactly what they say, where they
  say.
- Deviations during BUILD: stop and escalate to the human.
- Tests may inject fixture names. Fixture values are not production freezes.
- Revising only this plan is not a phase. Nothing is merged or ticked for a
  plan-only revision.

## Environment capabilities

| Capability | Available here? | Note |
| --- | --- | --- |
| node | local | Node `>= 22.19.0`. Gates run `npm run typecheck`, `npm run test`, `npm run check`, and `npx --no -- tsc` from the repo root. No gate needs a 1Password account or a warm `op` session. Phase 1 and Phase 2 shippable gates set `HOME` and `PI_CODING_AGENT_DIR` themselves. Phase 4 gates are Vitest against fixtures. No gate needs a live llama.cpp server. |

## Git & PR conventions

Follow `git-hygiene`. One branch and one PR per phase. Never commit on `main`.
Branch prefix equals commit type. No WIP or fixup commits. Do not edit root
`PLAN.md`, `release-please-config.json`, `.release-please-manifest.json`,
`.github/workflows/ci.yml` job names, or `.github/CODEOWNERS`.

Before each branch, open a GitHub issue on `jmcombs/pi-extensions` with the
title frozen below. The PR title is the squash-merge subject (a squash merge
takes the commit message from the PR title; see
`.github/workflows/update-1p-shell-plugins.yml`). The PR body must contain
`Closes #<n>` for that issue. Do not invent the number. CI required checks
(`Quality Gate (Node 22)`, `Quality Gate (Node 24)`, `Commit Messages`) must
be green. The verifier does not merge. Checkboxes are verifier-ticked.

Phase 1 may change `packages/1password/package.json` and the lockfile
`npm install` writes. It must not change `packages/1password/index.test.ts`
or any other 1password source. `release-please-config.json` maps
`packages/1password` to the `1password` component and `packages/relay` to the
`relay` component, with `separate-pull-requests: true`. `VERSIONING.md` opens
a release PR for a package whose history contains release-relevant commits.
`.github/workflows/release-please.yml` runs on a push to `main` that changes
`packages/**`. Root `package.json` and `package-lock.json` are not a Release
Please component. The 1password manifest is. After Phase 1 is merged, Release
Please may open a 1password release pull request. A Release Please pull
request is not approval to merge it. Do not merge it. Merging it is out of
scope and is not required for this phase to pass. An unmerged Release Please
pull request is not a failed phase. Do not close it to make the phase pass.
Do not wait for it to exist. Its absence before the human merge is not a
failure either. Phase 3 still fixes 1password behavior and may cause Release
Please to open or update that release pull request. Do not merge that one
either. Phase 4 may cause Release Please to open a steward release pull
request. Do not merge that one either.

The Phase 1 pull request title must mention both the relay transcript readers
and the 1password pin. A squash merge takes the commit message from the pull
request title (`.github/workflows/update-1p-shell-plugins.yml`). That one
commit changes files under both `packages/relay` and `packages/1password`.
Release Please copies that subject into each affected component's changelog.
A relay-only subject would describe the 1password pin change as a relay
reader change. The title is therefore exactly
`fix(relay): pin pi 0.87.1, including 1password, and read transcript prompts`.
That header is 75 characters. `commitlint.config.js` rejects a header longer
than 100. Because the title names the 1password pin, Release Please may open
the 1password release pull request described above. That is expected. It is
not approval to merge it.

Phase 2 may use one unscoped `fix:` commit or several `fix(<package-dir>):`
commits. Phase 1, Phase 3, and Phase 4 use only the scoped subjects in the
table. Phase 1 must not use an unscoped `fix:` subject. Phase 1 must not use
`fix(1password):`. Phase 4 must not use an unscoped `fix:` subject.

| Phase | Branch | Commit subject | Issue title |
| --- | --- | --- | --- |
| 1 | `fix/pi-0871-relay-readers` | `fix(relay): pin pi 0.87.1, including 1password, and read transcript prompts` | `fix(relay): pin pi 0.87.1, including 1password, and read transcript prompts` |
| 2 | `fix/pi-0871-tool-contracts` | `fix: make tool details and parameter schemas JSON-safe` | `fix: make extension tool details and parameter schemas comply with pi 0.86` |
| 3 | `fix/pi-0871-user-bash` | `fix(1password): fail closed on user_bash and inject shell env` | `fix: make 1password user_bash fail closed and inject pre-existing shell env` |
| 4 | `fix/steward-quant-label` | `fix(steward): keep filename quants and label UD mixes mixed` | `fix(steward): keep filename quants and label UD mixes mixed` |

## Summary

| Phase | Scope | Entry | Branch type |
| --- | --- | --- | --- |
| 1 | Pi `^0.87.1` floor, 1password devDependency pin, and relay transcript readers. No 1password source or tests. | — | fix |
| 2 | JSON-compatible tool `details`, `Type.Object` schemas, headroom compress payload | 1 | fix |
| 3 | 1password JSON account details, factory isolation, fail-closed `user_bash`, pre-existing shell env. Pin already moved. | 1, 2 | fix |
| 4 | Steward Quant label: filename token wins over a conflicting `meta.ftype`; UD and spaced file-type labels display as `mixed`. | 1, 2, 3 | fix |

### What v0.86 changed, and who it hits

**1. Provider stream input is `TranscriptContext`.** Covered in Phase 1.
`v0.85.1` `ProviderConfig.streamSimple` takes `Context` (`systemPrompt?`,
`messages`, `tools?`). `v0.86.0` and `v0.87.1` take `TranscriptContext`, which
is `{ messages }` plus a brand. `systemPrompt` and `tools` are not on that
object. `getCurrentSystemPrompt(context.messages)` replays every system
message into one string. `getCurrentTools(context.messages)` replays
`toolsAdded` / `toolsRemoved`. Only `packages/relay/provider.ts`
`streamViaDriver` and `terminalYieldToolName` register a provider and still
read `context.systemPrompt` and `context.tools`. On pi 0.86+ that drops the
persona, inlined skills, tool allowlist, and the oh-my-pi `yield` call.
oh-my-pi through `18.4.3` still passes `systemPrompt?: string[]` and `tools`
(`model-registry.ts` `ProviderConfigInput.streamSimple`). Relay must read the
transcript when those keys are absent, and keep the legacy readers when they
are present. No other package calls `registerProvider`.

**2. `user_bash` fails closed.** Covered in Phase 3. `v0.86.0` and `v0.87.1`
`isUserBashEventResult` accepts only a defined result that has exactly one of
`operations` (non-null object whose `exec` is a function) or `result`. A
`{ result }` value is valid only when `output` is a string, the `exitCode` key
is present and its value is `undefined` or a number, `cancelled` and
`truncated` are booleans, and `fullOutputPath` is absent or a string. `undefined`
is the only continue. A throw is rethrown. Only `packages/1password/index.ts`
registers `user_bash`, and only when `createLocalBashOperations` is a function.
Its return `{ operations: createLocalBashOperations() }` is valid (`exec` is a
function), so the happy path is not rejected. This handler must not return
`{ result }`.

**3. JSON-only tool arguments and details.** Covered in Phase 2, except the
1password account object, which stays in Phase 3. Phase 1 may edit
`packages/1password/package.json` only. It must not edit the account object.
`ToolCall.arguments` is `JsonObject`.
`ToolResultMessage<TDetails>` is `never` unless `TDetails` is JSON-compatible.
`unknown`, `any`, `Record<string, unknown>`, and `[key: string]: unknown` fail.
`JsonValue` arrays are readonly. An explicit `undefined` property is not a
`JsonValue`. `ToolDefinition`'s details type parameter defaults to `unknown`
(`types.ts` at `v0.87.1`), so this is a contract fix, not the typecheck
blocker that forces the relay readers into Phase 1. Affected sites:
`packages/better-toolsy/index.ts` `ToolResult.details` and the `ls` / `grep`
error returns that store `path: params.path` when `path` is optional;
`packages/1password/index.ts` `OpStatus.account` (Phase 3);
`packages/context7/index.ts` index signatures; `packages/grok-search/index.ts`
`details.raw` typed from `response.json()`; `packages/tavily-search/index.ts`
only at the `response.json()` cast; `packages/headroom/index.ts` retrieve
details that assign `query: string | undefined`; `packages/_template/index.ts`
must state the same contract. Relay's synthetic yield arguments
`{ type: "result", result: {} }` are already a `JsonObject`. Do not widen them.

**4. `registerTool` object schema.** Covered in Phase 2 for every factory
except the 1password factory, which Phase 3 adds to the same schema test.
`loader.ts` `registerTool` throws unless `parameters` is a non-null, non-array
object. The error text says "object parameter schema". Every current
`registerTool` call already passes a TypeBox `Type.Object`. `createBashTool`'s
schema is `Type.Object` (`name: "bash"`). Do not register a tool without one.
`pi.on()` now returns an unsubscribe function. Existing handlers ignore the
return. That is valid. Do not migrate call sites.

### What v0.87 changed, and who it hits

**`context` no longer includes system messages. `context_with_system` is opt-in.**
Does not require a subscription change. Headroom registers `pi.on("context"` at
`packages/headroom/index.ts` and does not register `context_with_system`. No
package calls `pi.on("context_with_system")`. On `v0.87.1`, `emitContext`
filters `message.role !== "system"` before each `context` handler and
`restoreSystemMessages` puts the prompt back. The docs say to use
`context_with_system` only when a request-local transformation must own the
complete transcript, and to keep a system message at index zero. Subscribing
would give headroom that ownership, which is the opposite of leaving the
system prompt unchanged. Headroom stays on `context`.

The conversion functions are still wrong if a caller passes a system message.
`packages/headroom/pi-format.ts` `piToOpenAI` maps every role other than
`assistant` and `toolResult`, including `system`, to an OpenAI `user` message.
`packages/headroom/compress.ts` sends a non-Pi `[system, user]` array through
`compress(original)`, so the system message reaches the proxy even when
`piToOpenAI` is never called. `isPiFormat` returns true only for a `toolResult`
message or a `toolCall` / `thinking` part, so `[system, user]` is not Pi
format. Phase 2 fixes the payload handed to `compress()`. That is the 0.86
`transformContext` hole (the agent loop passed messages that start with the
leading system message; `convertToLlm` passes `role: "system"` through). It is
not a `context_with_system` migration. A test of `piToOpenAI` plus split /
reinsert helpers is not sufficient: it can pass while `compress(original)`
still runs.

**Other `v0.87.0` breaks do not hit these packages.** No package references
`shouldStopAfterTurn` or `finishTurn`. No package switches on `SessionEntry`
or constructs `context_edit` (`packages/steward/core/state.ts` switches on its
own `action.type`). No package assigns `session.agent.state.messages`.
`notify`, `blue-psl-10k`, and `steward` listen to `turn_end` and ignore the
event payload; they do not construct `TurnEndEvent`, switch on `ExtensionEvent`,
or call `ExtensionRunner.emit`. No package registers `agent_settled` (the only
hit is a comment in `packages/prompt-enhancer/acceptance/README.md`). Relay
spawns a CLI and has no provider HTTP payload, so it does not call
`options.onPayload` or `options.onResponse`.

Packages with no custom provider, no `user_bash`, and no tool-result `details`:
`notify`, `blue-psl-10k`, `prompt-enhancer` (`complete()` still takes public
`Context`; `compat.ts` calls `normalizeContext`), and `steward`. Phases 1–3 do
not edit their production code. The schema test still loads their factories.
Phase 4 edits only Steward's quant label. It does not edit `notify`,
`blue-psl-10k`, or `prompt-enhancer`.

## Phase 1 — Pi 0.87.1 floor, 1password pin, and relay transcript readers

**Entry:** none.

**Shippable as:** one PR on `fix/pi-0871-relay-readers` whose squash subject is
`fix(relay): pin pi 0.87.1, including 1password, and read transcript prompts`, and whose wrapped `npm run check` exits 0 against resolved pi
`0.87.1`. The root bump, the 1password devDependency pin, and the relay
readers land together. A bump that leaves `context.systemPrompt` reads in
place is not shippable. A root-only bump that leaves the nested
`@earendil-works/pi-coding-agent@0.85.1` in place is not shippable. Release
Please may open a 1password release pull request after this PR is merged,
because the subject names the 1password pin and the commit changes
`packages/1password/package.json`. A Release Please pull request is not
approval to merge it. Do not merge it. Merging that release pull request is
out of scope and is not required for this phase to pass. An unmerged Release
Please pull request is not a failed phase.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

Pin the repo's root pi devDependencies and the 1password
`@earendil-works/pi-coding-agent` devDependency to the published `0.87.1`
release, and make relay read prompts and tools from transcript system messages
on pi 0.87 without dropping oh-my-pi's `systemPrompt: string[]` / `tools`
shape. The shippable check command sets `HOME` and `PI_CODING_AGENT_DIR` to
empty temp directories so the existing 1password factory load does not exec
`op`. That isolation stays a check-command environment setting because this
phase does not edit the test file.

**Out:** any 1password file other than `packages/1password/package.json`.
That includes `packages/1password/index.ts`,
`packages/1password/index.test.ts`, `packages/1password/credential-api.ts`,
and every other 1password source or test (Phase 3). Isolating `HOME` inside
those tests (Phase 3). JSON account details, the fail-closed `user_bash`
handler, and the pre-existing `!` / `!!` injection (Phase 3). JSON details,
`registerTool` schema tests, headroom system-message passthrough, and
`_template` (Phase 2). `context_with_system` subscription.
`shouldStopAfterTurn`, `ContextEditEntry`, assigning
`session.agent.state.messages`, constructing `TurnEndEvent`, and
`agent_settled`. `options.onPayload` / `options.onResponse` (relay has no
provider HTTP body). Unsubscribe migration. Widening yield arguments
`{ type: "result", result: {} }`. Bumping `@oh-my-pi/pi-coding-agent` off
`17.0.5`. Pinning `peerDependencies` (they stay `"*"`). A root `overrides`
entry. Editing `release-please-config.json`,
`.release-please-manifest.json`, or root `PLAN.md`. Cache warming, `/bug`,
and `ctx.modelRegistry.stream` (no package uses them). `prompt-enhancer`
`complete()` (still public `Context`). An unscoped `fix:` squash subject. A
`fix(1password):` commit on this branch. Merging a Release Please pull
request. Treating an unmerged Release Please pull request as a failed phase.

### Architectural Constraints

- Phase 1 may change only `package.json`, `package-lock.json`,
  `packages/1password/package.json`, `packages/relay/provider.ts`,
  `packages/relay/roles/resolver.ts`, `packages/relay/README.md`, and
  `packages/relay/index.test.ts`. No other path. Do not edit
  `packages/1password/index.ts`, `packages/1password/index.test.ts`,
  `packages/1password/credential-api.ts`, or any other file under
  `packages/1password`.
- `package.json` devDependencies `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` are
  `^0.87.1`. Lockfile resolved versions of the three hoisted packages are
  `0.87.1`. Peer ranges stay `"*"`. Do not pin the floor at `^0.86.1`.
  Do not add an `overrides` field. The package pin removes the nest. An
  override is not required, and this phase must not add one.
- `packages/1password/package.json` devDependency
  `@earendil-works/pi-coding-agent` is `^0.87.1`. That is the only
  `@earendil-works/pi-*` pin in that file today; `@earendil-works/pi-tui`
  stays `"*"`. Peers stay `"*"`. After `npm install`,
  `packages/1password/node_modules/@earendil-works/pi-coding-agent` is absent,
  and the lockfile has no
  `packages/1password/node_modules/@earendil-works/pi-coding-agent` key.
  Do not hand-delete a nest while leaving the pin at `^0.85.1`. Caret on
  `0.x` does not accept `0.87.1`, so that old pin is what creates the nest.
- Do not add `getCurrentSystemPrompt` or `getCurrentTools` to a static named
  import from `@earendil-works/pi-ai`. oh-my-pi's shim re-exports
  `@oh-my-pi/pi-ai` via `export *` and does not export those readers; a named
  import fails the module link. Read them off
  `import * as piAi from "@earendil-works/pi-ai"`. The existing named import of
  `createAssistantMessageEventStream` stays.
- Host resolution, in order: if both readers are functions and the context does
  not own `systemPrompt` and does not own `tools` (`Object.hasOwn`), the prompt
  is `expandSkillReferences(getCurrentSystemPrompt(context.messages))` and the
  tools are `getCurrentTools(context.messages)`. Otherwise use today's legacy
  path: `expandSkillReferences(context.systemPrompt)` and `context.tools` with
  the existing `typeof tool.name === "string"` guard. An owned legacy key wins
  even if `messages` also contains a system message. That is what keeps
  oh-my-pi working. The dual-read proof is oh-my-pi v18.4.3
  `packages/coding-agent/src/config/model-registry.ts`: `streamSimple` is typed
  against `Context`, and `registerProvider` forwards that context.
- Empty prompt still skips the temp system-prompt file. Tool names forwarded to
  the driver are every current tool name, including `yield`.
  `terminalYieldToolName` uses that same tool list, still case-insensitive,
  still returning the host spelling. Do not throw on a malformed tool entry.
- Yield arguments stay exactly `{ type: "result", result: {} }`.
- One boundary view type may add optional legacy `systemPrompt` and `tools`
  fields so the legacy read typechecks against `TranscriptContext`. Do not use
  `any`. Do not read `context.systemPrompt` or `context.tools` on the
  transcript path.
- The squash-merge PR title is exactly
  `fix(relay): pin pi 0.87.1, including 1password, and read transcript prompts`. Every commit on the
  branch uses that same `fix(relay):` type and scope. Do not use an unscoped
  `fix:` subject. Do not use `fix(1password):`. The title must name both the
  relay readers and the 1password pin, because Release Please copies it into
  the changelog of each component path the squash commit touches.
- If Release Please opens a 1password release pull request, that pull request
  is not approval to merge it. Do not merge it. Merging it is out of scope
  and is not required for this phase to pass. An unmerged Release Please pull
  request is not a failed phase. The builder does not merge it. The verifier
  does not fail the phase because the release pull request is open, and does
  not fail the phase because it does not exist yet.
- `loadShellEnvMap` follows `homedir()`, which follows `HOME`, and may `exec`
  `op read` or another `!` command. `warmOpSessionIfNeeded` reads
  `getAgentDir()` auth.json. `getAgentDir()` prefers `PI_CODING_AGENT_DIR`.
  Both variables must be empty temp directories for this phase's `npm run
  check`. Do not edit the 1password tests to do that isolation in this phase.
  Do not declare a human 1Password capability. Do not raise a timeout to dodge
  a hang. Do not assign the shell variable `status` (`status` is read-only in
  zsh). Use `gate_status`.

### Actionable TODOs

- [x] `package.json`: set the three `@earendil-works/pi-*` devDependencies to
      `^0.87.1`. Do not add an `overrides` field.
- [x] `packages/1password/package.json`: set the devDependency
      `@earendil-works/pi-coding-agent` from `^0.85.1` to `^0.87.1`. That is
      the only `@earendil-works/pi-*` pin in this file. Leave
      `@earendil-works/pi-tui` at `"*"`. Leave every `peerDependencies` entry
      at `"*"`. Do not edit any other file under `packages/1password`.
- [x] `package-lock.json`: regenerate with `npm install` so
      `node_modules/@earendil-works/pi-ai`,
      `node_modules/@earendil-works/pi-coding-agent`, and
      `node_modules/@earendil-works/pi-tui` resolve to `0.87.1`, and so the
      key `packages/1password/node_modules/@earendil-works/pi-coding-agent` is
      absent. Do not hand-edit those version fields. Do not add `overrides`
      to remove the nest. The pin change is what removes it.
- [x] `packages/relay/provider.ts`: export `readHostPromptAndTools` implementing
      the resolution rule. `streamViaDriver` and `terminalYieldToolName` use it
      and do not read `context.systemPrompt` or `context.tools` directly.
      Update the file header comment that says the prompt arrives as
      `context.systemPrompt`.
- [x] `packages/relay/roles/resolver.ts`: the `normalizeSystemPrompt` comment
      must say pi 0.86+ does not pass `systemPrompt` on the provider context,
      and that oh-my-pi still passes `string[]`. Do not change the function's
      behavior.
- [x] `packages/relay/README.md`: the Fixes bullet that says oh-my-pi supplies
      `systemPrompt` as `string[]` stays true. Add that pi 0.86+ supplies the
      prompt and tools on transcript system messages, read with
      `getCurrentSystemPrompt` and `getCurrentTools`.
- [x] `packages/relay/index.test.ts`: add a test titled
      `reads persona, skills, and yield from transcript messages`. Build a temp
      `SKILL.md` whose body is `TRANSCRIPT SKILL BODY.` Context owns neither
      `systemPrompt` nor `tools`. `messages[0]` is a system message whose
      `content` contains `You are verifier.` and an `<available_skills>` block
      pointing at that file, and whose `toolsAdded` includes
      `{ name: "read", description: "read", parameters: { type: "object", properties: {} } }`
      and a `yield` tool with the same parameter shape. Set
      `PI_RELAY_HEARTBEAT_MS=0`. The capture driver must see a system-prompt
      file containing `You are verifier.` and `TRANSCRIPT SKILL BODY.`, and
      `invocation.tools` containing `read`. The done message contains a
      `toolCall` named `yield` whose `arguments` are
      `{ type: "result", result: {} }`.
- [x] `packages/relay/index.test.ts`: add a test titled
      `owned string[] systemPrompt wins over transcript messages`. Context owns
      `systemPrompt: ["OMP PERSONA"]` and `tools: [{ name: "yield" }]`, and
      `messages` also include a system message `PI PERSONA`. The captured
      prompt file is `OMP PERSONA`, not `PI PERSONA`. The done message still
      has a `yield` tool call. Existing tests that pass owned `systemPrompt` /
      `tools` keys must keep passing.

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| Lockfile hoists 0.87.1 | `node -e "const lock=require('./package-lock.json'); for (const name of ['node_modules/@earendil-works/pi-ai','node_modules/@earendil-works/pi-coding-agent','node_modules/@earendil-works/pi-tui']) { const version=lock.packages[name].version; if (version!=='0.87.1') { console.error(name, version); process.exit(1);} console.log(name, version);} "` | Exit 0. stdout is exactly those three lines, each ending in `0.87.1`. |
| No 0.85.1 or 0.86.1 pin in the manifests Phase 1 changes | `grep -nE '0\.8[56]\.1' package.json packages/1password/package.json; test $? -eq 1` | Exit 0. No matching lines. The command covers both `package.json` and `packages/1password/package.json`. On the current tree, before the bump, the same command exits non-zero because both files still contain `^0.85.1`. Do not add a backslash-pipe. |
| 1password devDependency pin is ^0.87.1 | `node -e "const p=require('./packages/1password/package.json'); const v=p.devDependencies['@earendil-works/pi-coding-agent']; if (v!=='^0.87.1') { console.error(v); process.exit(1);} if (p.devDependencies['@earendil-works/pi-tui']!=='*') { console.error('tui', p.devDependencies['@earendil-works/pi-tui']); process.exit(1);} if (p.peerDependencies['@earendil-works/pi-coding-agent']!=='*') { console.error('peer', p.peerDependencies['@earendil-works/pi-coding-agent']); process.exit(1);} console.log(v);"` | Exit 0. stdout is `^0.87.1`. |
| No root overrides | `node -e "const p=require('./package.json'); if (Object.hasOwn(p,'overrides')) { console.error(JSON.stringify(p.overrides)); process.exit(1);} console.log('no overrides');"` | Exit 0. stdout is `no overrides`. |
| Nested coding-agent directory is absent after install | `node -e "const fs=require('fs'); const version=JSON.parse(fs.readFileSync('node_modules/@earendil-works/pi-coding-agent/package.json','utf8')).version; const nested='packages/1password/node_modules/@earendil-works/pi-coding-agent'; if (version!=='0.87.1') { console.error('hoisted', version); process.exit(1);} if (fs.existsSync(nested)) { console.error('nested present'); process.exit(1);} console.log('absent');"` | Exit 0. stdout is `absent`. The hoisted install is `0.87.1`, and `packages/1password/node_modules/@earendil-works/pi-coding-agent` does not exist. On the current tree this exits non-zero because the hoisted package is still `0.85.1`. After a root-only bump that leaves the nest, it exits non-zero because the nested directory exists. |
| Lockfile does not nest coding-agent under 1password | `node -e "const lock=require('./package-lock.json'); const key='packages/1password/node_modules/@earendil-works/pi-coding-agent'; if (lock.packages[key]) { console.error(key, lock.packages[key].version); process.exit(1);} console.log('no nested coding-agent');"` | Exit 0. stdout is `no nested coding-agent`. |
| Transcript and legacy prompt tests | `npm run test -- --reporter=verbose packages/relay/index.test.ts` | Exit 0. stdout contains `reads persona, skills, and yield from transcript messages` and `owned string[] systemPrompt wins over transcript messages`. |
| Types against 0.87.1 | `npm run typecheck` | Exit 0. stdout and stderr do not contain `error TS`. A root-only bump that still has `packages/1password/node_modules/@earendil-works/pi-coding-agent` fails this gate with `TS2345` in context7, grok-search, headroom, and tavily-search. The verifier reproduced typecheck exit 1 with that nest, and only the relay `TranscriptContext` errors remained once the nest was gone. Leaving `context.systemPrompt` reads in `packages/relay/provider.ts` still fails this gate. Both fixes are in this phase. |
| Phase is shippable without a warm op session | `home=$(mktemp -d) && agent=$(mktemp -d) && HOME="$home" PI_CODING_AGENT_DIR="$agent" npm run check; gate_status=$?; rm -rf "$home" "$agent"; exit $gate_status` | Exit 0. The command sets both `HOME` and `PI_CODING_AGENT_DIR` to empty temp directories before `npm run check`, then deletes them. `PI_CODING_AGENT_DIR` is required, not optional: `warmOpSessionIfNeeded` uses `getAgentDir()`, which prefers that variable. Do not use the variable name `status`. The 1password factory test is still unedited, so this wrapper is the isolation. |

## Phase 2 — Tool result details, parameter schemas, and headroom compress payload

**Entry:** Phase 1. The pi floor is already `^0.87.1` at the root and in `packages/1password/package.json`. Do not change either pin.

**Shippable as:** one PR on `fix/pi-0871-tool-contracts` whose wrapped
`npm run check` exits 0 against resolved pi `0.87.1`.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

Make every tool `details` value that this phase's packages place on a tool
result assignable to `@earendil-works/pi-ai` `JsonValue`, lock the
`registerTool` object-schema contract with a real load of each factory this
phase owns, and make `compress()` receive no `role: "system"` message.

**Out:** any file under the 1password package, including its JSON account
narrowing, factory isolation, `user_bash` handler, and pre-existing
`!` / `!!` injection (Phase 3). The 1password pi pin is already `^0.87.1`
from Phase 1; do not change it. Changing the pi version floor. Subscribing
headroom to `context_with_system` (no package registers it; `emitContext`
already hides system messages from `context` handlers and restores them).
Unsubscribe migration. Pinning `peerDependencies`. Root `PLAN.md`. oh-my-pi
pin `17.0.5`. `notify`, `blue-psl-10k`, `prompt-enhancer`, and `steward`
production code (no tool `details` and no `registerTool`). Calling the
Headroom proxy, or mocking `headroom-ai`, from the new compress-payload test.
Deleting the process working directory to force `ls` / `grep` errors.
Treating `JSON.parse(JSON.stringify(details))` deep-equal as proof that an
omitted path was stored: vitest `toEqual` treats a missing key and an explicit
`undefined` as equal, and `JSON.stringify` drops `undefined`, so that
comparison passes on the unfixed tree.

### Architectural Constraints

- Import `JsonValue` with `import type` from `@earendil-works/pi-ai`. Do not add
  a runtime dependency on `pi-ai`. jiti loads these extensions from source;
  `import type` is erased.
- A details object that contains an explicit `undefined` property is not a
  `JsonValue`. Omit the key, or store a string. Do not assign `undefined`.
- Do not use `any`, `unknown`, `Record<string, unknown>`, or
  `[key: string]: unknown` as a details type or as a property of one.
- Do not add `// @ts-ignore`, `// @ts-expect-error`, or `// biome-disable`.
- `response.json()` is `any` at the boundary. Narrow it with a local
  `isJsonValue(value: unknown): value is JsonValue` before it enters `details`.
  Reject `undefined`, functions, and objects that contain them. On failure,
  return details `{ error: "invalid_json" }` and do not attach `raw`.
- `registerTool` `parameters` must be the existing TypeBox `Type.Object` schema
  for that tool. `createBashTool`'s schema is already `Type.Object`. Do not
  register a tool with omitted, null, array, or non-object `parameters`.
- `_template` is excluded by `scripts/typecheck.mjs` (`tsconfig.json` exclude
  `packages/_template/**`) and `vitest.config.ts`. `tsconfig.json` include does
  not cover `scripts/**/*.ts`. The contract is still mandatory. The schema test
  in `scripts/` and a dedicated `tsc --noEmit -p` config must typecheck both
  files.
- Headroom stays on `pi.on("context")`. Do not register `context_with_system`.
- `piToOpenAI` must not emit a `role: "system"` message as `role: "user"`.
  `compress()` from `headroom-ai` must not receive a system message. The proof
  is the exported seam `compressPayload`, which `compressMessages` must call.
  A helper-only test of `piToOpenAI` plus split / reinsert is not that proof.
  A leading system message that comes back is byte-identical to the input
  (`JSON.stringify` equal).
- `packages/headroom/index.test.ts` mocks `./compress.js`. The seam test must
  not live in that file. It must not mock `headroom-ai`.
- This phase's `npm run check` uses the same `HOME` and `PI_CODING_AGENT_DIR`
  wrapper as Phase 1. The 1password factory test is still unisolated. Do not
  edit that package to fix the hang. Do not use the variable name `status`.

### Actionable TODOs

- [x] `packages/better-toolsy/index.ts`: delete `ToolResult.details:
      Record<string, unknown>`. Import `JsonValue` as a type. Every returned
      `details` object must be `satisfies JsonValue`. Where `params.path` is
      optional, store `params.path ?? "."` instead of `params.path`. Change
      these three returns, and name each one. Do not store `undefined`.
      1. The `ls` `readdir` catch, whose content text is
      `Error listing directory: ${message}`, today
      `details: { error: true, path: params.path }`. `safeResolve` for `ls`
      sits outside that try. Store `path: params.path ?? "."`.
      2. The `grep` `safeResolve` catch, the return immediately after
      `safeResolve(params.path ?? ".")` throws, whose content text is
      `Error searching: ${message}`, today
      `details: { error: true, query: params.pattern, path: params.path }`.
      Store `path: params.path ?? "."`.
      3. The `grep` `stat` catch, the return after `fs.stat(searchPath)` throws,
      whose content text is `Error searching: ${message}`, today
      `details: { error: true, query: params.pattern, path: params.path }`.
      Store `path: params.path ?? "."`.
      The `ls` success return already uses `params.path ?? "."`. Leave it.
- [x] `packages/better-toolsy/index.test.ts`: add a test titled
      `ls and grep details round-trip as JSON`. This test fails on the unfixed
      tree and passes on the fixed one. Do not delete the working directory.
      `safeResolve`'s default root is `process.cwd()`, and that call throws
      once the working directory is gone. `ls` calls it outside the `readdir`
      try, so a deleted cwd makes `execute` throw instead of returning details.
      `grep` then lands in the `safeResolve` catch, not the `stat` catch.
      Keep `process.cwd()` working. Save `process.cwd()`. `mkdtemp` a parent,
      `mkdir` a child named `child`, `chmod` the child to `0o100`, and `chdir`
      into the child. Call the registered `ls` `execute` with `{}` and no
      `path` key. `ls` is not exported. Extend the file's stub so
      `registerTool` keeps the tool object, implement `on` (the factory calls
      it), call `factory`, and use the `ls` tool. Assert
      `content[0].text` includes
      `Error listing directory: EACCES: permission denied, scandir` and
      `details.path === "."`. Then `chmod` the parent to `0o000` and call
      exported `grepTool` with `{ pattern: "needle" }` and no `path` key.
      Assert `content[0].text` includes
      `Error searching: EACCES: permission denied, stat` and
      `details.path === "."`. Also assert
      `JSON.stringify(details)` includes `"path":"."` and that no details value
      is `undefined`. Do not assert
      `expect(JSON.parse(JSON.stringify(details))).toEqual(details)` as the
      failure signal. That comparison passes on the unfixed tree. In `finally`,
      `chmod` the parent back to `0o700` using the absolute path saved before
      the `0o000` chmod, `chmod` the child back to `0o700`, `chdir` to the
      saved cwd, then remove the parent. An explicit `path` cannot fail this
      bug and is not a substitute.
- [x] `packages/context7/index.ts`: delete both `[key: string]: unknown` index
      signatures. Export `isJsonValue`. `details.raw` is the guarded `JsonValue`,
      not `Context7SearchResponse` / `Context7DocsResponse`. `formatDocs` reads
      `codeSnippets` and `infoSnippets` by narrowing that `JsonValue`. Invalid
      JSON uses `details: { error: "invalid_json" }`.
- [x] `packages/context7/index.test.ts`: call `isJsonValue` on a fixture object,
      an array, `null`, a string, `undefined`, and `{ path: undefined }`. The
      last two are `false`. Test title: `context7 isJsonValue rejects undefined`.
- [x] `packages/grok-search/index.ts`: export `isJsonValue` with the same
      contract. `const data: unknown = await response.json()` stays unknown
      until the guard. `details.raw` is `JsonValue`. `source` stays
      `"oauth" | "api_key"`. Invalid JSON uses
      `details: { error: "invalid_json", source: auth.source }` and no `raw`.
- [x] `packages/grok-search/index.test.ts`: same `isJsonValue` cases as
      context7. Test title: `grok-search isJsonValue rejects undefined`.
- [x] `packages/tavily-search/index.ts`: keep the closed `TavilySearchResult` /
      `TavilySearchResponse` interfaces. Do not add an index signature. Export
      `isJsonValue`. Replace `as TavilySearchResponse` with the guard, then copy
      only `query`, `answer`, and `results` title/url/content/score/raw_content
      into the closed type for `formatResults`. `details.raw` is the guarded
      `JsonValue`. Invalid JSON uses `details: { error: "invalid_json" }`.
- [x] `packages/tavily-search/index.test.ts`: same `isJsonValue` cases. Test
      title: `tavily-search isJsonValue rejects undefined`.
- [x] `packages/headroom/index.ts`: in `fullRetrieveResult`, both query-match
      returns, the no-original-content return, and the `catch` details, include
      `query` only when it is a string. `retrieveExecute({ hash })` must produce
      details with no `query` key. Do not assign `query: undefined`.
- [x] `packages/headroom/index.test.ts`: using the existing no-network
      `createRetrieveStub`, call `retrieveExecute({ hash: "h123" }, { client })`
      and a throwing client with no query. Assert `!("query" in result.details)`
      and that `JSON.parse(JSON.stringify(result.details))` deep-equals
      `details`. Test title: `retrieve omits query when the caller omits it`.
- [x] `packages/headroom/pi-format.ts`: export `splitSystemMessages` and
      `reinsertSystemMessages`. `splitSystemMessages` removes `role: "system"`
      messages and records their original indexes. `piToOpenAI` must not convert
      those messages to `role: "user"` and must not include their text in its
      return value. `reinsertSystemMessages` splices the original system
      message objects back so a leading system message is byte-identical
      (`JSON.stringify` equal to the input).
- [x] `packages/headroom/compress.ts`: export
      `compressPayload(messages: readonly PiMessage[]): OpenAIMessage[] | PiMessage[]`.
      It is synchronous and pure. It does not call `compress()`. Body:
      drop `role: "system"` messages via `splitSystemMessages`, then if
      `isPiFormat(messages)` return `piToOpenAI(kept)`, otherwise return
      `kept`. `compressMessages` must use that seam. It contains exactly one
      call, the text `compress(compressPayload(messages), compressOptions)`.
      It must not contain `compress(original`, `compress(piToOpenAI(`, or
      `compress(openAIMessages`. On `!result.compressed` or any throw, return
      the original messages, including the original system message objects.
      On the Pi success path, `applyCompressedText` receives the kept Pi
      messages (not the full array) and the compressed OpenAI messages, then
      `reinsertSystemMessages` puts the original system message objects back.
      On the non-Pi success path, reinsert those same original system message
      objects into the compressed kept messages. `compress()` must not receive
      a system message on either path.
- [x] `packages/headroom/compress.test.ts`: add a test titled
      `compress payload omits system messages on both paths`. Do not put this
      test in `packages/headroom/index.test.ts`. Do not call `vi.mock`. Do not
      mock `headroom-ai`. Do not call `compress()` or `compressMessages()`.
      Import `compressPayload` from `./compress.js`. Non-Pi fixture, in order:
      `{ role: "system", content: "SYSTEM PROMPT BYTES" }`,
      `{ role: "user", content: "hello" }`, cast with `as unknown as PiMessage[]`.
      Pi fixture, in order: that same system message, that same user message,
      an assistant message whose `content` is
      `[{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "npm test" } }]`,
      and `{ role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "ok" }] }`,
      same cast. For both payloads: no entry has `role: "system"`, and
      `JSON.stringify(payload)` does not contain `SYSTEM PROMPT BYTES`.
      Read `packages/headroom/compress.ts` and assert it contains
      `compress(compressPayload(messages), compressOptions)` and does not
      contain `compress(original`, `compress(piToOpenAI(`, or
      `compress(openAIMessages`. This test fails on the unfixed tree because
      `compressPayload` is not exported and `compress(original` is present.
- [x] `packages/headroom/index.test.ts`: add a test titled
      `leading system message comes back byte-identical`. This test is not
      sufficient by itself. Build a leading
      `{ role: "system", content: "SYSTEM PROMPT BYTES" }` plus a user message.
      Assert the `piToOpenAI` payload does not contain `SYSTEM PROMPT BYTES`.
      Assert `reinsertSystemMessages` after `splitSystemMessages` returns a
      leading message whose `JSON.stringify` equals the input system message.
      Do not call `compress()` and do not mock `headroom-ai`.
- [x] `packages/_template/index.ts`: export `ExampleToolDetails` as
      `{ received: string }`. The `example_echo` details object is
      `satisfies ExampleToolDetails` and `satisfies JsonValue` via a type-only
      import. A comment states that details must be JSON-compatible: no
      `unknown`, `any`, `Record<string, unknown>`, or `[key: string]: unknown`,
      and no explicit `undefined`. `parameters` stays `exampleToolSchema`
      (`Type.Object`).
- [x] `TEMPLATE.md`: under Conventions, replace the `{ content, details }`
      bullet so it states the same JSON rule and that `registerTool`
      `parameters` must be a TypeBox `Type.Object`. Do not change the secrets
      bullet.
- [x] `scripts/tsconfig.pi-contracts.json`: a standalone config, not an extend
      of the root config (the root `exclude` drops `packages/_template/**`).
      `files` is `["../packages/_template/index.ts", "./register-tool-parameters.test.ts"]`.
      `compilerOptions` match the root `tsconfig.json`: `target` `ES2022`,
      `module` and `moduleResolution` `NodeNext`, `lib` `["ES2023"]`, `types`
      `["node"]`, `strict` true, `noUncheckedIndexedAccess` true,
      `noImplicitOverride` true, `exactOptionalPropertyTypes` false,
      `esModuleInterop` true, `forceConsistentCasingInFileNames` true,
      `resolveJsonModule` true, `skipLibCheck` true, `allowJs` false, `noEmit`
      true, `isolatedModules` true, `verbatimModuleSyntax` false. No `exclude`.
- [x] `scripts/register-tool-parameters.test.ts`: import each default factory
      from `packages/better-toolsy`, `context7`, `grok-search`, `headroom`,
      `tavily-search`, `notify`, `blue-psl-10k`, `prompt-enhancer`, `steward`,
      `relay`, and `_template`, using `.js` specifiers. Do not import the
      1password factory in this phase. The stub must implement `on`,
      `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`,
      `getFlag` (return `undefined`), and `registerProvider` as no-ops, and
      record every `registerTool` argument. `await` the factory. For each
      recorded tool, assert `parameters` is a non-null non-array object and
      `parameters.type === "object"`. Assert tool-name sets: `better-toolsy` =
      `ls`, `read`, `grep`, `find`, `edit`, `write`; `context7` =
      `context7_search`, `context7_get_docs`; `grok-search` = `grok_search`;
      `headroom` = `headroom_retrieve`; `tavily-search` = `tavily_search`;
      `_template` = `example_echo`; `notify`, `blue-psl-10k`,
      `prompt-enhancer`, `steward`, and `relay` register zero tools. Test
      titles: `Type.Object parameters: ` plus each of those package directory
      names. Phase 3 adds the 1password case to this file.

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| Omitted-path ls and grep error details (fails before the fix) | `npm run test -- --reporter=verbose packages/better-toolsy/index.test.ts` | Exit 0. stdout contains `ls and grep details round-trip as JSON`. The test keeps `process.cwd()` working, chdirs into a mode `0o100` child, and does not delete that directory. It asserts the `ls` text includes `Error listing directory: EACCES: permission denied, scandir` and `details.path === "."`. It then chmods the parent to `0o000` and asserts the `grep` text includes `Error searching: EACCES: permission denied, stat` and `details.path === "."`. It does not pass an explicit `path`. It fails on the unfixed tree because those returns store `path: undefined`. |
| JSON details and schema tests | `npm run test -- --reporter=verbose packages/context7/index.test.ts packages/grok-search/index.test.ts packages/tavily-search/index.test.ts packages/headroom/index.test.ts scripts/register-tool-parameters.test.ts` | Exit 0. stdout contains `context7 isJsonValue rejects undefined`, `grok-search isJsonValue rejects undefined`, `tavily-search isJsonValue rejects undefined`, `retrieve omits query when the caller omits it`, `leading system message comes back byte-identical`, and each title `Type.Object parameters: better-toolsy`, `Type.Object parameters: context7`, `Type.Object parameters: grok-search`, `Type.Object parameters: headroom`, `Type.Object parameters: tavily-search`, `Type.Object parameters: _template`, `Type.Object parameters: notify`, `Type.Object parameters: blue-psl-10k`, `Type.Object parameters: prompt-enhancer`, `Type.Object parameters: steward`, and `Type.Object parameters: relay`. |
| Headroom compress payload omits system messages | `npm run test -- --reporter=verbose packages/headroom/` | Exit 0. stdout contains `compress payload omits system messages on both paths` and `leading system message comes back byte-identical`. The payload test does not mock `headroom-ai`. |
| compressMessages calls the seam | `grep -n 'compress(compressPayload(messages), compressOptions)' packages/headroom/compress.ts` | Exit 0. Exactly one matching line. |
| Non-Pi path does not pass original messages to compress | `grep -n 'compress(original' packages/headroom/compress.ts; test $? -eq 1` | Exit 0. No matching lines. |
| Pi path does not pass piToOpenAI(messages) to compress | `grep -n 'compress(piToOpenAI(' packages/headroom/compress.ts; test $? -eq 1` | Exit 0. No matching lines. |
| No openAIMessages argument to compress | `grep -n 'compress(openAIMessages' packages/headroom/compress.ts; test $? -eq 1` | Exit 0. No matching lines. |
| Template and schema test are typechecked | `npx --no -- tsc --noEmit -p scripts/tsconfig.pi-contracts.json` | Exit 0. stdout and stderr do not contain `error TS`. |
| No unknown details index | `grep -n '\[key: string\]: unknown' packages/context7/index.ts packages/better-toolsy/index.ts packages/grok-search/index.ts packages/tavily-search/index.ts packages/headroom/index.ts; test $? -eq 1` | Exit 0. No matching lines. |
| Phase is shippable without a warm op session | `home=$(mktemp -d) && agent=$(mktemp -d) && HOME="$home" PI_CODING_AGENT_DIR="$agent" npm run check; gate_status=$?; rm -rf "$home" "$agent"; exit $gate_status` | Exit 0. Same wrapper as Phase 1. The 1password factory test is still unisolated, so the command itself sets both variables. |

## Phase 3 — 1password JSON details, user_bash, and pre-existing shell env

**Entry:** Phases 1 and 2. The pi floor is already `^0.87.1` at the repo root
and in `packages/1password/package.json`. This phase does not change that pin.
Phase 1 is the only earlier phase that edits a file under `packages/1password`,
and that file is only `packages/1password/package.json`. This phase is the only
phase that edits 1password source and tests.

**Shippable as:** one PR on `fix/pi-0871-user-bash` whose `npm run check`
exits 0 against resolved pi `0.87.1`. This phase changes 1password source, so
Release Please may open or update a 1password release pull request. A Release
Please pull request is not approval to merge it. Do not merge it. An unmerged
Release Please pull request is not a failed phase. Phase 1 may already have
caused one. Do not merge that one either.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

Make `OpStatus.account` JSON-compatible, keep `!` / `!!` from aborting when
the handler cannot build a valid operations object, inject `currentShellEnv`
on that path, and isolate `HOME` and `PI_CODING_AGENT_DIR` in this package's
tests. The `^0.87.1` pin is already set by Phase 1. Do not change it. Do not
put `^0.85.1` back.

The missing injection is a pre-existing bug that predates 0.86. The human
approved including it here. `packages/coding-agent/src/core/bash-executor.ts`
at `v0.85.1`, `v0.86.0`, and `v0.87.1` calls
`operations.exec(command, cwd, { onData, signal })` with no `env`. Do not call
that injection an 0.86 break. The 0.86 break in this phase is fail-closed:
an invalid defined result or a throw aborts the command.

**Out:** Relay transcript readers, the root pi floor, and the 1password
devDependency pin (Phase 1). Headroom compress payload, better-toolsy details,
and the other packages' JSON details (Phase 2). Registering `user_bash` on
oh-my-pi. Importing unexported `getShellEnv` or `getBinDir`. Changing
`loadShellEnvMap` away from `homedir()`. Returning `{ result }` from this
handler. A test whose only PATH assertion is `process.env.PATH`, or whose bin
path is only `join(getAgentDir(), "bin")` without first proving that path is
absent from `process.env.PATH`. Root `PLAN.md`. A human 1Password capability.
Dropping the fail-closed handler, the pre-existing injection, or the test
isolation. Adding a root `overrides` entry. Merging a Release Please pull
request.

### Architectural Constraints

- `packages/1password/package.json` devDependency
  `@earendil-works/pi-coding-agent` is already `^0.87.1` from Phase 1. Do not
  change it. Peers stay `"*"`. `@earendil-works/pi-tui` stays `"*"`. Do not
  reintroduce `^0.85.1` or `^0.86.1`. Do not add a root `overrides` entry.
  The lockfile must still not contain
  `packages/1password/node_modules/@earendil-works/pi-coding-agent`, and that
  directory must still be absent. The three hoisted `@earendil-works/pi-*`
  packages stay at `0.87.1`.
- `OpStatus.account` is the return type of `opAccountFromUnknown`. No
  `Record<string, unknown>`. The object returned as `1p_diagnose` `details` is
  `satisfies JsonValue`. Leave `AuthJson` and the auth.json writer alone except
  where the whoami parse must go through `opAccountFromUnknown`.
- Register `user_bash` only when
  `typeof piRuntime.createLocalBashOperations === "function"`. That
  feature-detect stays. oh-my-pi's shim does not export it.
- The handler return is `userBashOperationsResult(...)` and nothing else. It
  must not throw. `undefined` means continue. A defined return is exactly
  `{ operations: { exec } }` with `exec` a function and no `result` property.
  This handler does not return `{ result }`, so it does not set `exitCode`.
  A `{ result }` value elsewhere is valid only when the `exitCode` key is
  present and its value is `undefined` or a number.
- `userBashOperationsResult` returns `undefined` when `createLocal` throws or
  when `exec` is not a function. It must not return an invalid object.
- Env merge matches the current spawnHook: command and cwd pass through;
  overlay keys win. `mergeShellEnv(base, overlay)` is `{ ...base, ...overlay }`.
- The bash-tool `spawnHook` calls `mergeShellEnv(env, currentShellEnv)` so the
  agent bash path and the `!` path cannot drift.
- `executeBashWithOperations` does not pass `env`. When `options.env` is
  omitted, the base is not `process.env` alone. Rebuild pi's shell base from
  the public `getAgentDir()`, feature-detected on the existing
  `import * as piRuntime` namespace import, at call time, not at module load:
  if `typeof piRuntime.getAgentDir === "function"`, `binDir` is
  `join(piRuntime.getAgentDir(), "bin")` (that is `getBinDir()` in pi
  `config.ts`). Prepend `binDir` to the `PATH` key (case-insensitive, default
  `PATH`) when that entry is absent, using `path.delimiter`, matching
  `getShellEnv()` in pi `shell.ts`. If `getAgentDir` is not a function, the
  base is a copy of `process.env` and the helper does not throw. Then overlay
  `currentShellEnv`. Never pass an overlay-only env. Do not import
  `getShellEnv` or `getBinDir`.
- Do not mock `createLocalBashOperations` or `child_process`. The real-exec
  test calls the installed function. The throw / invalid-exec cases use a
  fixture function this package owns.
- Every `factory(` call in `packages/1password/index.test.ts` isolates `HOME`
  and `PI_CODING_AGENT_DIR` to an empty temp directory and restores both in
  `finally`, including when the saved value was `undefined`. The new
  `user_bash` test uses the same isolation. Do not declare a human 1Password
  capability. CI does not set those variables. The tests must, or a local
  `npm run check` can hang on a live `op` session.
- A PATH test that only asserts `join(getAgentDir(), "bin")` is already on the
  env passed to `exec` is not proof. pi's `getShellEnv()` may already have put
  the real bin directory on `process.env.PATH`. The test must point
  `PI_CODING_AGENT_DIR` at a fresh empty temp directory first.

### Actionable TODOs

- [x] `packages/1password/op-account.ts`: export
      `opAccountFromUnknown(value: unknown): { name?: string; email?: string;
      account_uuid?: string; url?: string } | null`. Copy only those keys when
      the value is a string. Ignore every other key. Return `null` for
      non-objects. No `Record<string, unknown>`.
- [x] `packages/1password/op-account.test.ts`: fixture objects only. A whoami-shaped
      object keeps the four string fields and drops a nested object and an
      `undefined` field. A string input returns `null`. Test title:
      `opAccountFromUnknown keeps only JSON account strings`.
- [x] `packages/1password/index.ts`: `OpStatus.account` uses the return type of
      `opAccountFromUnknown`. The `op whoami` parse goes through that function,
      not `as Record<string, unknown>`. `formatOpStatus` reads `name`, `email`,
      `account_uuid`, and `url` without casts. The object returned as
      `1p_diagnose` `details` is `satisfies JsonValue`. Leave `AuthJson` and the
      auth.json writer alone except for that parse.
- [x] `packages/1password/bash-env.ts`: export `mergeShellEnv` and
      `userBashOperationsResult` with the contracts above. `exec` forwards
      `onData`, `signal`, and `timeout` and always passes the merged `env`.
      When the caller omits `env`, the base is the rebuilt shell env, computed
      at call time from `piRuntime.getAgentDir()`, not `process.env` alone and
      not a module-load cache.
- [x] `packages/1password/bash-env.test.ts`: a fixture `exec` records the env it
      receives. Assert overlay wins over a base `PATH`. For the omitted-env
      case, `mkdtemp` a fresh empty directory, save `PI_CODING_AGENT_DIR`, set
      it to that directory, and restore it in `finally` (delete the key when
      the saved value was `undefined`). `bin` is `join(tmp, "bin")`. First
      assert `bin` is absent from `process.env.PATH` split on `path.delimiter`.
      Then call the omitted-env `exec` and assert `bin` is present as an entry
      of the `PATH` value passed to `exec` (case-insensitive key, default
      `PATH`, split on `path.delimiter`). Do not use
      `join(piRuntime.getAgentDir(), "bin")` as the only assertion. A throwing
      `createLocal` returns `undefined`. `createLocal` returning
      `{ exec: "nope" }` returns `undefined`. A valid `createLocal` returns an
      object whose only own keys are `operations`, and `operations.exec` is a
      function. Test titles: `mergeShellEnv keeps the pi bin directory on PATH`,
      `userBashOperationsResult returns undefined on throw`,
      `userBashOperationsResult rejects a non-function exec`.
- [x] `packages/1password/bash-env.test.ts`: call
      `userBashOperationsResult(() => createLocalBashOperations(), () =>
      ({ PI_EXT_087_MARKER: "injected-087" }))` and `exec` the command
      `printf '%s' "$PI_EXT_087_MARKER"` with `cwd` set to `os.tmpdir()`,
      collecting `onData`. Assert the decoded output is `injected-087`. Test
      title: `wrapped local exec injects the overlay`. Timeout `15000`.
- [x] `packages/1password/index.ts`: the bash-tool `spawnHook` calls
      `mergeShellEnv`. The `user_bash` handler returns
      `userBashOperationsResult(() => piRuntime.createLocalBashOperations(), () =>
      currentShellEnv)`. Do not return `createLocalBashOperations()` directly.
- [x] `packages/1password/index.test.ts`: wrap every `factory(` call, including
      the existing registration test, in the HOME isolation above. Restore
      `HOME` and `PI_CODING_AGENT_DIR` in `finally`, including when the saved
      value was `undefined`. Keep the `30000` timeout. Do not call `op`. The
      stub records the `user_bash` handler. When `createLocalBashOperations` is
      a function, the factory registers `user_bash`, awaiting the handler does
      not throw, and the result has `operations.exec` as a function and no
      `result` key. The new test uses the same isolation. Test title:
      `user_bash handler returns operations and does not throw`.
- [x] `scripts/register-tool-parameters.test.ts`: add the 1password factory
      import from `packages/1password` using a `.js` specifier. Before that
      factory call, set `HOME` and `PI_CODING_AGENT_DIR` to an empty temp
      directory and restore both in `finally`. Assert tool names `bash` and
      `1p_diagnose`, and that each `parameters` value is a non-null non-array
      object with `type === "object"`. Set that case timeout to `30000`. Test
      title: `Type.Object parameters: 1password`.

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| 1password manifest no longer pins 0.85.1 or 0.86.1 | `grep -nE '0\.8[56]\.1' packages/1password/package.json; test $? -eq 1` | Exit 0. No matching lines. Phase 1 already removed this pin. This gate fails if Phase 3 puts `0.85.1` or `0.86.1` back. |
| Nested coding-agent stays gone | `node -e "const lock=require('./package-lock.json'); const key='packages/1password/node_modules/@earendil-works/pi-coding-agent'; if (lock.packages[key]) { console.error(key, lock.packages[key].version); process.exit(1);} console.log('no nested coding-agent');"` | Exit 0. stdout is `no nested coding-agent`. Phase 1 already removed this key. This gate fails if Phase 3 puts it back. |
| Hoisted pi packages stay 0.87.1 | `node -e "const lock=require('./package-lock.json'); for (const name of ['node_modules/@earendil-works/pi-ai','node_modules/@earendil-works/pi-coding-agent','node_modules/@earendil-works/pi-tui']) { const version=lock.packages[name].version; if (version!=='0.87.1') { console.error(name, version); process.exit(1);} console.log(name, version);} "` | Exit 0. stdout is exactly those three lines, each ending in `0.87.1`. |
| Omitted env prepends a bin dir that was not already on PATH | `npm run test -- --reporter=verbose packages/1password/bash-env.test.ts` | Exit 0. stdout contains `mergeShellEnv keeps the pi bin directory on PATH`, `userBashOperationsResult returns undefined on throw`, `userBashOperationsResult rejects a non-function exec`, and `wrapped local exec injects the overlay`. The bin-directory test sets `PI_CODING_AGENT_DIR` to a fresh empty temp directory, first asserts `join(tmp, "bin")` is absent from `process.env.PATH`, then asserts that same path is present in the env passed to `exec`. |
| Handler, account, and schema tests do not need a warm op session | `npm run test -- --reporter=verbose packages/1password/index.test.ts packages/1password/op-account.test.ts scripts/register-tool-parameters.test.ts` | Exit 0. stdout contains `user_bash handler returns operations and does not throw`, `opAccountFromUnknown keeps only JSON account strings`, and `Type.Object parameters: 1password`. Every `factory(` call in `packages/1password/index.test.ts` sets `HOME` and `PI_CODING_AGENT_DIR` to an empty temp directory and restores them in `finally`. |
| No bare local return | `grep -n 'operations: piRuntime.createLocalBashOperations()' packages/1password/index.ts; test $? -eq 1` | Exit 0. No matching lines. |
| Phase is shippable | `npm run check` | Exit 0. The 1password tests isolate `HOME` and `PI_CODING_AGENT_DIR` themselves, so this command does not wrap them. |

## Phase 4 — Steward quant label

**Entry:** Phases 1, 2, and 3. Those phases do not edit Steward production
code. This phase does not change the pi floor, the 1password pin, relay
readers, tool-result details, or the `user_bash` handler.

**Shippable as:** one PR on `fix/steward-quant-label` whose squash subject is
`fix(steward): keep filename quants and label UD mixes mixed`, and whose
`npm run check` exits 0. `release-please-config.json` maps `packages/steward`
to the `steward` component. Release Please may open a steward release pull
request after this PR is merged. A Release Please pull request is not approval
to merge it. Do not merge it. An unmerged Release Please pull request is not a
failed phase.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

Stop the Steward Quant field from printing llama.cpp's GGUF file-type label as
a bit depth. The dashboard shows `4-bit (Q4_K - Medium)` because
`packages/steward/core/llama-models.ts` `parseModel` prefers `/models`
`meta.ftype` over the filename token, and `packages/steward/core/format.ts`
`formatQuantField` takes the first digit run. `meta.ftype` is
`"Q4_K - Medium"` when `general.file_type` is 15 (`MOSTLY_Q4_K_M`). The loaded
file behind that reading had tensor dtype counts Q8_0 453, F32 360, BF16 53,
and Q4_K 0. Those counts are not on `/models`. This phase keeps a conflicting
filename token. It labels a UD quant mixed. A file-type label that still
contains ` - ` must not be shown as that label's bit depth.

**Out:** any file under `packages/` other than the six paths in Architectural
Constraints. That includes `packages/steward/core/select.ts` (it already calls
`formatQuantField`; do not add a second formatter), `packages/steward/ui/`,
`packages/steward/server/`, `packages/steward/README.md`, and
`packages/steward/core/__fixtures__/llama/models-loaded.json` (do not add a
tensor field to the captured body). Phases 1–3 files. A live llama.cpp server,
a GGUF parser, and a shell-out to `llama-server`. Inventing a `/models` field.
Root `PLAN.md`. Merging a Release Please pull request. `notify`,
`blue-psl-10k`, and `prompt-enhancer` production code.

### Architectural Constraints

- Phase 4 may change only `packages/steward/core/llama-models.ts`,
  `packages/steward/core/format.ts`, `packages/steward/core/types.ts`,
  `packages/steward/core/llama-models.test.ts`,
  `packages/steward/core/format.test.ts`, and
  `packages/steward/core/select.test.ts`.
- `/models` does not expose per-tensor dtype counts. llama.cpp `b9960`
  `tools/server/server-context.cpp` `server_routes::get_model_info()`
  serializes `meta` with exactly these keys: `vocab_type`, `n_vocab`,
  `n_ctx`, `n_ctx_train`, `n_embd`, `n_params`, `size`, `ftype`. The captured
  body `packages/steward/core/__fixtures__/llama/models-loaded.json` has that
  same `meta` key set. The router handler in `tools/server/server-models.cpp`
  merges child `loaded_info` and does not add a tensor list. The phase may use
  `meta.ftype`, the `--model` / `-m` value already read by `quantFromArgs`,
  and `id` already read by `quantFromId`. The phase must not invent
  `meta.tensors`, `meta.dtype_counts`, `meta.tensor_types`, `meta.n_type`,
  `general.file_type`, or any other key. `general.file_type` is a GGUF
  metadata key. It is not a `/models` field. The integer 15 is not on the
  wire. Do not read a GGUF file. Do not require a live llama.cpp server in CI.
  Gates are Vitest against inline fixtures and the existing captured JSON.
  `packages/steward/core/llama-models.ts`, `packages/steward/core/format.ts`,
  and `packages/steward/core/types.ts` must not contain the substrings
  `dtype_counts`, `tensor_types`, `general.file_type`, or `meta.tensors`.
- Filename token, in today's order: `quantFromArgs(args)` when that string is
  non-empty, otherwise `quantFromId(id)`. A non-empty filename token is
  `ModelInfo.quant`. Do not let `meta.ftype` override it. When the filename
  token and `meta.ftype` disagree, keep the filename token. Disagreement is
  string inequality. `"Q4_K - Medium"` disagrees with `Q8_0`, with `Q4_K_M`,
  and with `UD-Q4_K_XL`. Equal strings (`Q4_0` and `Q4_0`) stay `Q4_0`. When
  both filename tokens are empty, store `meta.ftype` if it is a non-empty
  string, else `""`. Do not drop `meta.size` or `meta.n_ctx` parsing.
- `QUANT_PATTERN` stays case-sensitive. It captures an optional `UD-`
  immediately before the existing alternation, as the exact pattern
  `/\b((?:UD-)?(?:IQ\d+_[A-Z0-9]+|Q\d+_[A-Z0-9]+(?:_[A-Z0-9]+)?|Q\d+_\d+|Q\d+|F16|F32|BF16))\b/`.
  `Llama-3.1-8B-UD-Q4_K_XL` yields `UD-Q4_K_XL`, not `Q4_K_XL`. Do not add an
  `i` flag. Do not treat a bare `UD` or `ud-` as the marker. `quantFromArgs`
  keeps calling `quantFromId` on the `--model` / `-m` basename. Do not add a
  second scanner.
- `shortName` still receives the stored quant. For id
  `Llama-3.1-8B-UD-Q4_K_XL` and quant `UD-Q4_K_XL`, short is `Llama-3.1-8B`.
- `formatQuantField` still returns `n/a` when `confirmed` is false. When
  confirmed, a quant that starts with `UD-`, or a quant that contains ` - `
  (the `llama_ftype_name` separator in `"Q4_K - Medium"`), returns exactly
  `mixed`. It must not return `4-bit (Q4_K - Medium)`, `4-bit (UD-Q4_K_XL)`,
  or `n/a`. Every other confirmed code keeps today's `bitsFromCode` rule:
  `Q4_K_M` is `4-bit (Q4_K_M)`, `Q4_0` is `4-bit (Q4_0)`, `Q5_K_M` is
  `5-bit (Q5_K_M)`, `""` and `IQ` are `n/a`. Check the `UD-` prefix and the
  ` - ` separator before `bitsFromCode`, because those strings contain digits.
- A filename token `Q4_K_M` with `meta.ftype` `"Q4_K - Medium"` stays
  `Q4_K_M`, and the Quant field stays `4-bit (Q4_K_M)`. That file is not
  labeled mixed. Mixed is the UD token. Mixed is also the display of a stored
  file-type label that still contains ` - ` because no filename token existed.
  Do not map `"Q4_K - Medium"` to `Q4_K_M`. That mapping would claim 4-bit for
  the observed file, whose Q4_K tensor count was 0, and the wire cannot show
  that count.
- The observed counts Q8_0 453, F32 360, BF16 53, and Q4_K 0 are why a 4-bit
  claim is false for that file. They are not a fixture field and not an
  expected `/models` key. A test must not send them on the model record.
- `packages/steward/core/select.ts` keeps
  `{ label: "Quant", value: formatQuantField(model.quant, confirmed) }`. Do
  not edit that file.
- No `any`. No `// @ts-ignore`, `// @ts-expect-error`, or `// biome-disable`.
  Do not mock `fetch` or llama.cpp. Tests call `parseModels`,
  `formatQuantField`, and `selectDashboard` on fixtures this package owns.
- The squash subject is exactly
  `fix(steward): keep filename quants and label UD mixes mixed`. Every commit
  on the branch uses that `fix(steward):` type and scope. Do not use an
  unscoped `fix:`. That header is 59 characters. `commitlint.config.js`
  rejects a header longer than 100.
- If Release Please opens a steward release pull request, that pull request is
  not approval to merge it. Do not merge it. An unmerged Release Please pull
  request is not a failed phase. The builder does not merge it. The verifier
  does not fail the phase because the release pull request is open, and does
  not fail the phase because it does not exist yet.

### Actionable TODOs

- [x] `packages/steward/core/llama-models.ts`: change `QUANT_PATTERN` to
      `/\b((?:UD-)?(?:IQ\d+_[A-Z0-9]+|Q\d+_[A-Z0-9]+(?:_[A-Z0-9]+)?|Q\d+_\d+|Q\d+|F16|F32|BF16))\b/`.
      Keep it case-sensitive. The comment above it must say a leading `UD-` is
      part of the token, and that longest-first still lets `Q4_K_M` beat `Q4`.
      `quantFromArgs` still calls `quantFromId` on the `--model` / `-m`
      basename. Do not add a second scanner. Do not export `quantFromId`.
- [x] `packages/steward/core/llama-models.ts`: in `parseModel`, replace
      `const quant = ftype ?? (argQuant !== "" ? argQuant : quantFromId(id))`
      with `const idQuant = quantFromId(id)`,
      `const filenameQuant = argQuant !== "" ? argQuant : idQuant`, and
      `const quant = filenameQuant !== "" ? filenameQuant : (ftype ?? "")`.
      Keep `const ftype = readString(meta.ftype)` and
      `const argQuant = quantFromArgs(args)`. The comment above that block
      must say a non-empty filename token wins over `meta.ftype`, and that
      `meta.ftype` is stored only when both filename tokens are empty. It must
      not say the quant prefers `ftype`. Do not change `sizeBytes`,
      `nativeCtx`, or `meta.n_ctx` parsing. `shortName(id, quant)` stays.
- [x] `packages/steward/core/types.ts`: the `ModelInfo.quant` comment must say
      a non-empty filename token from `quantFromArgs` or `quantFromId` wins
      over `meta.ftype`, and that a `UD-` token or a file-type label
      containing ` - ` displays as `mixed`. Do not add a field.
- [x] `packages/steward/core/format.ts`: `formatQuantField` returns `n/a` when
      `confirmed` is false. When confirmed, a quant that starts with `UD-`, or
      a quant that contains ` - `, returns exactly `mixed`. Those checks run
      before `bitsFromCode`. Every other confirmed code keeps today's rule.
      Update the doc comment that says the field is `4-bit (Q4_0)` so it also
      says a `UD-` code and a ` - ` file-type label return `mixed` and do not
      take the first digit run. Do not change `bitsFromCode`.
- [x] `packages/steward/core/llama-models.test.ts`: add a test titled
      `filename token wins when meta.ftype disagrees`. Inline records only. Do
      not add a tensor-count key. Do not edit
      `packages/steward/core/__fixtures__/llama/models-loaded.json`. This test
      fails on the unfixed tree because `parseModel` stores `meta.ftype`.
      1. id `chat-qwen`, `status.value` `loaded`, `status.args`
      `["--model", "/models/Qwen3-0.6B-Q8_0.gguf"]`, `meta.ftype`
      `"Q4_K - Medium"`. `quant` is `Q8_0`, not `"Q4_K - Medium"`.
      2. id `Qwen3-0.6B-Q8_0`, `status.args` `[]`, `meta.ftype`
      `"Q4_K - Medium"`. `quant` is `Q8_0`.
      3. id `chat-qwen`, `status.args`
      `["--model", "/models/Qwen3-0.6B-Q4_K_M.gguf"]`, `meta.ftype`
      `"Q4_K - Medium"`. `quant` is `Q4_K_M`, not `"Q4_K - Medium"`.
      4. id `chat`, `status.args` `[]`, `meta.ftype` `"Q4_K - Medium"`.
      `quant` is `"Q4_K - Medium"` because both filename tokens are empty.
      5. `parseModels({ object: "list", data: [LOADED] })` still has `quant`
      `Q4_0`.
- [x] `packages/steward/core/llama-models.test.ts`: add a test titled
      `UD quant token keeps the UD- prefix`. id
      `Llama-3.1-8B-UD-Q4_K_XL`, `status.value` `loaded`, `status.args`
      `["--model", "/models/Llama-3.1-8B-UD-Q4_K_XL.gguf"]`, `meta.ftype`
      `"Q4_K - Medium"`. `quant` is `UD-Q4_K_XL`. `short` is `Llama-3.1-8B`.
      `quant` is not `Q4_K_XL` and not `"Q4_K - Medium"`. This test fails on
      the unfixed tree because `QUANT_PATTERN` drops `UD-` and `ftype` wins.
- [x] `packages/steward/core/format.test.ts`: add a test titled
      `formatQuantField does not claim ftype bit depth`.
      `formatQuantField("Q4_K - Medium", true)` is `mixed`.
      `formatQuantField("UD-Q4_K_XL", true)` is `mixed`.
      `formatQuantField("Q4_K_M", true)` is `4-bit (Q4_K_M)`.
      `formatQuantField("Q4_0", true)` is `4-bit (Q4_0)`.
      `formatQuantField("UD-Q4_K_XL", false)` is `n/a`.
      `formatQuantField("Q4_K - Medium", false)` is `n/a`. Neither confirmed
      mixed result equals `4-bit (Q4_K - Medium)`. This test fails on the
      unfixed tree because `bitsFromCode` turns `"Q4_K - Medium"` into
      `4-bit`.
- [x] `packages/steward/core/select.test.ts`: add a test titled
      `dashboard Quant field does not show ftype bit depth`. Use the file's
      `snapshot`, `selectDashboard`, `MODELS`, `NOW`, and `initialUiState`.
      Do not add `fetch`. Do not edit `packages/steward/core/select.ts`.
      Call `selectDashboard(snapshot({ models: [{ ...MODELS[0], quant: "UD-Q4_K_XL" }, MODELS[1], MODELS[2]] }), initialUiState("light"), NOW)`.
      `MODELS[0].status` stays `active`. The Quant field value is `mixed`.
      Repeat with `quant: "Q4_K - Medium"` and assert the Quant field is
      `mixed`, not `4-bit (Q4_K - Medium)`. The unmodified `snapshot()` chat
      card Quant field is still `4-bit (Q4_K_M)`.

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| ftype no longer wins the assignment | `grep -n 'const quant = ftype ??' packages/steward/core/llama-models.ts; test $? -eq 1` | Exit 0. No matching lines. On the current tree, before the fix, the same command exits non-zero because `parseModel` still has that assignment. |
| UD- is part of QUANT_PATTERN | `grep -n 'UD-' packages/steward/core/llama-models.ts` | Exit 0. stdout has a line that contains both `UD-` and `IQ\d+`. |
| Production files do not invent a tensor field | `node -e "const fs=require('fs'); const files=['packages/steward/core/llama-models.ts','packages/steward/core/format.ts','packages/steward/core/types.ts']; const banned=['dtype_counts','tensor_types','general.file_type','meta.tensors']; for (const f of files) { const text=fs.readFileSync(f,'utf8'); for (const b of banned) { if (text.includes(b)) { console.error(f, b); process.exit(1);} } } console.log('no invented tensor field');"` | Exit 0. stdout is `no invented tensor field`. The phase must not read a key `/models` does not send. |
| Filename token wins, including the captured Q4_0 model | `npm run test -- --reporter=verbose packages/steward/core/llama-models.test.ts` | Exit 0. stdout contains `filename token wins when meta.ftype disagrees`, `UD quant token keeps the UD- prefix`, and `parses the real loaded model`. The new tests fail on the unfixed tree. They do not start llama-server and do not add a tensor-count key. |
| Spaced ftype label and UD token are mixed | `npm run test -- --reporter=verbose packages/steward/core/format.test.ts` | Exit 0. stdout contains `formatQuantField does not claim ftype bit depth` and `leads with the bit-depth reading and keeps the code beside it`. `formatQuantField("Q4_K_M", true)` is still `4-bit (Q4_K_M)`. |
| Dashboard Quant field does not show ftype bit depth | `npm run test -- --reporter=verbose packages/steward/core/select.test.ts` | Exit 0. stdout contains `dashboard Quant field does not show ftype bit depth` and `builds the labeled body grid — real values for a loaded model`. The loaded `Q4_K_M` card is still `4-bit (Q4_K_M)`. |
| Phase is shippable | `npm run check` | Exit 0. Phase 3's 1password tests already set `HOME` and `PI_CODING_AGENT_DIR`, so this command does not wrap them. No gate starts llama-server. |

## Appendix A — Asset/source map

| Source | Destination | Phase |
| --- | --- | --- |
| pi `v0.87.1` `TranscriptContext` / `getCurrentSystemPrompt` / `getCurrentTools`; oh-my-pi `v18.4.3` `packages/coding-agent/src/config/model-registry.ts` `Context`; oh-my-pi shim `export *`; `packages/1password/package.json` devDependency `^0.85.1`; `packages/1password/credential-api.ts` `UiContext` | `packages/relay/provider.ts`, `packages/relay/roles/resolver.ts`, `packages/relay/README.md`, `packages/relay/index.test.ts`, `package.json`, `packages/1password/package.json`, `package-lock.json` | 1 |
| pi `v0.86.0` / `v0.87.1` `ToolResultMessage` / `JsonValue` / `loader.ts` `registerTool`; `packages/headroom/pi-format.ts` system-to-user fallback; `packages/headroom/compress.ts` `compress(original)` | `packages/better-toolsy/index.ts`, `packages/better-toolsy/index.test.ts`, `packages/context7/index.ts`, `packages/grok-search/index.ts`, `packages/tavily-search/index.ts`, `packages/headroom/index.ts`, `packages/headroom/pi-format.ts`, `packages/headroom/compress.ts`, `packages/headroom/compress.test.ts`, `packages/_template/index.ts`, `TEMPLATE.md`, `scripts/register-tool-parameters.test.ts`, `scripts/tsconfig.pi-contracts.json` | 2 |
| pi `v0.86.0` / `v0.87.1` `emitUserBash` / `isUserBashEventResult`; pre-existing `bash-executor.ts` exec call with no `env`; public `getAgentDir()` | `packages/1password/op-account.ts`, `packages/1password/op-account.test.ts`, `packages/1password/bash-env.ts`, `packages/1password/bash-env.test.ts`, `packages/1password/index.ts`, `packages/1password/index.test.ts`, `scripts/register-tool-parameters.test.ts` | 3 |
| llama.cpp `b9960` `/models` `meta.ftype`; `packages/steward/core/llama-models.ts` `parseModel`; `packages/steward/core/format.ts` `formatQuantField`; `packages/steward/core/select.ts` Quant field; captured `packages/steward/core/__fixtures__/llama/models-loaded.json` | `packages/steward/core/llama-models.ts`, `packages/steward/core/format.ts`, `packages/steward/core/types.ts`, `packages/steward/core/llama-models.test.ts`, `packages/steward/core/format.test.ts`, `packages/steward/core/select.test.ts` | 4 |

## Appendix C — Master TODO index

Verifier-ticked. One checkbox per phase.

- [x] Phase 1 — Pi 0.87.1 floor, 1password pin, and relay transcript readers
- [x] Phase 2 — Tool result details, parameter schemas, and headroom compress payload
- [x] Phase 3 — 1password JSON details, user_bash, and pre-existing shell env
- [x] Phase 4 — Steward quant label

## Appendix D — Definition of Done

- git-hygiene: branch matches `^(feat|fix|chore|docs|refactor)/[a-z0-9-]+$`,
  commit type matches the branch prefix, PR title is the squash subject in the
  Git table, PR body contains `Closes #<n>`, not on `main`.
- Phase 1's squash subject is `fix(relay): pin pi 0.87.1, including 1password, and read transcript prompts`.
  That subject names both the relay readers and the 1password pin. Phase 1 may
  change `packages/1password/package.json` and must not change any other file
  under `packages/1password`. Release Please may open a 1password release pull
  request after Phase 1 is merged. A Release Please pull request is not
  approval to merge it. Do not merge it. Merging it is out of scope and is not
  required for the phase to pass. An unmerged Release Please pull request is
  not a failed phase.
- `npm run check` exits 0 on the phase's shippable tree, which is pi `0.87.1`
  from Phase 1 onward. No phase is proved on `0.85.1`. Phase 1 and Phase 2 run
  that check with `HOME` and `PI_CODING_AGENT_DIR` set to empty temp
  directories. Phase 3's 1password tests set those variables themselves.
  Phase 4's `npm run check` is not wrapped.
- Phase 4 is assigned work, not optional polish. Its Testing Gates are part of
  done. Release Please may open a steward release pull request. A Release
  Please pull request is not approval to merge it. Do not merge it. An
  unmerged Release Please pull request is not a failed phase.
- Full-repo regression is that same check (lint, typecheck, Vitest,
  version validation, security).
- Every Testing Gate has been re-run with real output, or marked HUMAN-VERIFY.
  This plan has no human gates.
- Every literal TODO path exists.
- A PR is open with green CI (`Quality Gate (Node 22)`,
  `Quality Gate (Node 24)`, `Commit Messages`).
- Merge is human-gated. The builder does not merge. The verifier ticks
  checkboxes only after PASS.

## Appendix E — Deferred-gate ledger

| Gate | Deferred at | Needs | Discharge by | Status |
| --- | --- | --- | --- | --- |
