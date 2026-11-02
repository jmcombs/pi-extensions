# PLAN: `@jmcombs/pi-omlx`, an omlx provider that behaves like Pi's built-in llama.cpp provider

Add a new external package, `packages/omlx/` (`@jmcombs/pi-omlx`), that registers a native Pi provider `omlx` and a TUI command `/omlx`. On the surface it behaves like Pi 1.4.0's built-in llama.cpp provider (`/login llama.cpp`, `/llama`, `/model`, classifiers). Behind it, every call is adapted to omlx 0.7.3rc1's HTTP API. The package supports MLX models only: omlx has limited GGUF support, but this extension does not work with GGUF and says so. Nine user-visible differences that cannot be hidden on omlx are documented, not papered over.

## Authoritative sources

| Source                                                                                                                                                                                                                                                                              | What it governs                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.pi/context/omlx-provider-design.md` → "Parity table" (rows 1–60) and "GGUF is not supported"                                                                                                                                                                                      | Every user-facing behavior, its omlx adaptation, and the decided differences. Row numbers below cite this table.                                               |
| `.pi/context/llama-cpp-provider-1.4.0.md`                                                                                                                                                                                                                                           | Behavior of Pi 1.4.0's built-in llama.cpp provider being mirrored                                                                                              |
| `~/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/extensions/llama/{index,provider,client,huggingface,ui}.js`                                                                                                                                   | Reference implementation of the mirrored surface                                                                                                               |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` (`registerProvider(provider: Provider)`)                                                                                                                                                             | Native provider registration API                                                                                                                               |
| `node_modules/@earendil-works/pi-ai/package.json` exports `./compat`, `./api/*`                                                                                                                                                                                                     | Allowed imports: `stream`/`streamSimple` from `@earendil-works/pi-ai/compat`, `typesafeSystemOneApi` from `@earendil-works/pi-ai/api/typesafe-system-one.lazy` |
| `/opt/homebrew/Cellar/omlx/0.7.3rc1/libexec/lib/python3.11/site-packages/omlx/` (`server.py`, `engine_pool.py`, `admin/routes.py`, `admin/hf_downloader.py`, `admin/auth.py`, `api/decisions.py`, `api/systemone_models.py`, `api/openai_models.py`, `models/{clef,openjev,d3}.py`) | omlx wire behavior                                                                                                                                             |
| `~/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`                                                                                                                                                                           | Provider contract: `refreshModels` publish, delegation to built-in APIs, test list                                                                             |
| `AGENTS.md`, `CONTRIBUTING.md`, `TEMPLATE.md`, `VERSIONING.md`                                                                                                                                                                                                                      | Package conventions, testing philosophy (no mocks of external APIs), Release Please, extension-load check                                                      |
| `packages/_template/`                                                                                                                                                                                                                                                               | Scaffold to copy                                                                                                                                               |
| `docker/smoke-harness.mts`                                                                                                                                                                                                                                                          | Exact-set expected surface per package                                                                                                                         |

## How to use this document

- The **builder** implements exactly one phase, proves every Testing Gate with **real command output**, opens a PR, and stops. It never ticks checkboxes and never merges.
- A **fresh verifier** re-derives each gate from real output and returns PASS / CONDITIONAL PASS / FAIL / BLOCKED.
- **Max 3 build→verify rounds** per phase; the 3rd FAIL escalates to the human.
- **Checkboxes are ticked by the merger only**, inside the approved phase PR at merge time. Merges are human-gated.
- **TODO file paths are literal specs** — build exactly what they say, where they say.
- **Deviations during BUILD:** stop and escalate to the human. This includes any needed capability with no Pi API (AGENTS.md).
- Tests may inject **fixture** names (for example `OMLX_TEST_MODEL`). Fixture values are not production freezes.

## Environment capabilities

| Capability      | Available here? | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node-npm`      | local           | Node ≥ 22.19.0, `npm ci`, `npm run check`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `docker`        | local           | Docker 29.9.2 present; used by `npm run validate:extension-load`                                                                                                                                                                                                                                                                                                                                                                                            |
| `omlx-server`   | local           | omlx 0.7.3rc1 at `http://127.0.0.1:8000` (`/health` returns 200). Gate shells export `OMLX_BASE_URL=http://127.0.0.1:8000`, `OMLX_API_KEY` = the server's main key, and `OMLX_TEST_MODEL` = one MLX `llm` model id present in `/v1/models/status`, with no `model_alias`, a non-null `/v1/models` `max_model_len`, and tool-calling support in its chat template. The search gate also needs outbound internet, because omlx proxies search to Hugging Face |
| `pi-cli`        | local           | `pi` 1.4.0 on PATH; `--model`, `-p`, `-ne`, `-e`                                                                                                                                                                                                                                                                                                                                                                                                            |
| `jq`            | local           | `/opt/homebrew/bin/jq`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tui-human`     | human           | Interactive `/omlx` flows, Esc prompts, progress view; a person runs `pi -e ./packages/omlx`                                                                                                                                                                                                                                                                                                                                                                |
| `hf-network`    | human           | Real Hugging Face download of a small MLX repo through omlx; network and disk cost                                                                                                                                                                                                                                                                                                                                                                          |
| `gallery-asset` | human           | A person supplies `assets/omlx/preview.png`                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Git & PR conventions

Follow `git-hygiene`: one branch per phase named `feat/omlx-phase-<n>-<slug>`, never commit to `main`, Conventional Commits with scope `omlx` (`feat(omlx): …`; `chore(omlx): …` for non-user-facing work), commit type matches the branch prefix. One PR per phase. PR body has `Closes #<n>` when a tracking issue exists. Required checks `Quality Gate (Node 22)`, `Quality Gate (Node 24)`, `Commit Messages` must be green. Merges are human-gated; checkboxes are ticked by the merger inside the approved phase PR. Do not edit `.github/workflows/*`, `.github/CODEOWNERS`, or the ruleset.

## Summary of phases

| Phase | Scope                                                                           | Entry | Branch type |
| ----- | ------------------------------------------------------------------------------- | ----- | ----------- |
| 1     | Package scaffold, client, provider registration, auth (`/login omlx`, env vars) | —     | feat        |
| 2     | Catalog refresh, chat models, context, thinking, GGUF exclusion                 | 1     | feat        |
| 3     | Classifiers over `/v1/systemone` with llama-equivalent answers                  | 2     | feat        |
| 4     | `/omlx` manager: list, load, unload, progress, restore                          | 2     | feat        |
| 5     | `/omlx` downloads (MLX only)                                                    | 4     | feat        |
| 6     | Docs, extension-load harness, Release Please registration                       | 3, 5  | feat        |

## Phase 1 — Package scaffold, client, provider registration, auth

**Entry:** — **Shippable as:** a loadable package that registers provider `omlx`, supports `/login omlx` and env configuration, with an empty model list.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

Parity rows 1–8 and 10. Copy the template, implement URL handling, the omlx HTTP client core, and the provider auth contract.

**Out:** model catalog (Phase 2), classifiers (Phase 3), `/omlx` (Phases 4–5), README content beyond a stub (Phase 6), Release Please registration (Phase 6), the post-login guidance message (row 9, decided: Pi's generic message; documented in Phase 6), `-builtin:` disabling (row 10, not reproducible).

### Architectural Constraints

- Provider id and display name are both `omlx` (row 1). Never register `llama.cpp`.
- Register with `pi.registerProvider(provider)` using a complete `Provider` object, same form as `createLlamaProvider`.
- Default server URL `http://127.0.0.1:8000`; inference base URL is `<server>/v1` (row 2).
- URL normalization matches llama's `normalizeLlamaServerUrl`: http/https only, strip hash, search, trailing slashes, and a trailing `/v1`.
- Env vars `OMLX_BASE_URL`, `OMLX_API_KEY` (row 5). Stored credential URL wins over `OMLX_BASE_URL` (row 6).
- `login`: prompt `"omlx server URL"` (placeholder env or default), then secret `"API key (required)"`. The API key is required, a blank key is rejected at login and is not stored, and the prompt says the key is required. Probe `GET /v1/models` with the key. Store `{ type: "api_key", key, env: { OMLX_BASE_URL } }` only when the probe accepts the key.
- `check` performs no HTTP (row 8).
- `resolve`: `apiKey = credential?.key ?? ctx.env("OMLX_API_KEY") ?? "local"` (row 7); `auth.baseUrl` is the `/v1` URL; `env.OMLX_BASE_URL` is the normalized server URL.
- Management calls strip `/v1` and use the server root. Every request sends `Authorization: Bearer <key>` when the key is truthy, with a 15 s timeout combined with the caller signal.
- Pi-runtime packages are peers (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`). No 1Password dependency: the API key goes through Pi's own `/login` credential store.
- If oh-my-pi cannot load the package (object-form `registerProvider` or `@earendil-works/pi-ai/*` resolution), that is a deviation: stop and escalate; it surfaces at the Phase 6 two-host gate.
- Reach `@earendil-works/pi-coding-agent` runtime symbols that oh-my-pi may lack through a namespace import plus a runtime check (CONTRIBUTING.md gotcha 2).

### Actionable TODOs

- [x] `packages/omlx/` — created by `cp -R packages/_template packages/omlx`; every `EXTENSION_NAME` replaced with `omlx`; `ui/bordered-popups.ts` removed.
- [x] `packages/omlx/package.json` — `name` `@jmcombs/pi-omlx`, `version` `0.0.0`, `private: true` kept until Phase 6, description "omlx provider for Pi: run local MLX models through omlx with the same experience as Pi's llama.cpp provider. GGUF models are not supported.", keywords `pi-package`, `pi-extension`, `omlx`, `mlx`, `local-models`, `provider`; `files` `["*.ts", "!*.test.ts", "README.md", "LICENSE"]`; `dependencies` removed; `peerDependencies` `@earendil-works/pi-coding-agent` `^1.4.0`, `@earendil-works/pi-ai` `^1.4.0`, `@earendil-works/pi-tui` `*`, `typebox` `^1.4.3`.
- [x] `package-lock.json` — regenerated by `npm install` so it contains the `packages/omlx` workspace and the `node_modules/@jmcombs/pi-omlx` link.
- [x] `packages/omlx/url.ts` — exports `DEFAULT_OMLX_SERVER_URL = "http://127.0.0.1:8000"`, `normalizeOmlxServerUrl(value)`, `omlxInferenceUrl(serverUrl)`.
- [x] `packages/omlx/client.ts` — exports `OmlxClient` with constructor `(serverUrl, apiKey?)`, a private `request(path, init)` (JSON, bearer, 15 s timeout, error text from `detail` or `error.message`, else `omlx returned HTTP <status>`), and `listModels(signal?)` for `GET /v1/models` that throws `"omlx returned an invalid model list"` unless `data` is an array of objects with string `id`.
- [x] `packages/omlx/provider.ts` — exports `OMLX_PROVIDER_ID = "omlx"` and `createOmlxProvider()` returning `{ provider, setCatalog }`. `provider` has `id`, `name`, `baseUrl` (`omlxInferenceUrl(DEFAULT_OMLX_SERVER_URL)`), `auth.apiKey` with `login`, `check`, `resolve` per the constraints, `getModels`/`getAllModels` returning empty arrays in this phase, and `stream`/`streamSimple` delegating to `@earendil-works/pi-ai/compat`.
- [x] `packages/omlx/index.ts` — default factory calls `pi.registerProvider(createOmlxProvider().provider)`.
- [x] `packages/omlx/url.test.ts` — table tests for `normalizeOmlxServerUrl` (trailing slash, `/v1`, query, hash, non-http rejection) and `omlxInferenceUrl`.
- [x] `packages/omlx/provider.test.ts` — calls `check` and `resolve` with a real `ctx.env` function over a plain env object (no network): stored URL beats `OMLX_BASE_URL`; key precedence `credential.key` → `OMLX_API_KEY` → `"local"`; `baseUrl` ends in `/v1`; `check` returns `undefined` with no URL.
- [x] `packages/omlx/index.test.ts` — template smoke test adapted: stub records `registerProvider` calls; asserts exactly one provider with id `omlx`.

### Testing Gates

| Criterion                                             | Command                                                                                                      | Expected                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Package unit and smoke tests pass                     | `npx vitest run packages/omlx`                                                                               | exit 0; `url.test.ts`, `provider.test.ts`, `index.test.ts` all pass                                                          |
| Full quality gate                                     | `npm run check`                                                                                              | exit 0                                                                                                                       |
| No template placeholders                              | `grep -rn "EXTENSION_NAME\|TODO" packages/omlx --include=*.ts --include=*.json`                              | no output                                                                                                                    |
| Lockfile in sync                                      | `npm ci`                                                                                                     | exit 0                                                                                                                       |
| Provider loads in real pi `needs: pi-cli`             | `pi -ne -e ./packages/omlx --model omlx-load-probe -p x 2>&1 \| grep -c "Failed to load extension"`          | `0` (the unresolvable `--model` makes pi report runtime diagnostics and exit before any LLM call; a load failure prints ≥ 1) |
| Login probe accepts the real key `needs: omlx-server` | `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $OMLX_API_KEY" "$OMLX_BASE_URL/v1/models"` | `200` (the URL and auth shape `login` uses)                                                                                  |
| Interactive login `needs: tui-human`                  | In `pi -ne -e ./packages/omlx`, run `/login omlx`, accept the default URL, enter the key                     | prompts appear in order (URL, then API key); login succeeds; a wrong key shows an error and stores nothing                   |

## Phase 2 — Catalog refresh, chat models, context, thinking, GGUF exclusion

**Entry:** 1 **Shippable as:** loaded omlx MLX chat models appear in `/model` and chat works, with llama-equivalent context and thinking.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

Parity rows 11–30 and the GGUF catalog rule. Implement `refreshModels`, the status-row → Pi model mapping, and chat compat.

**Out:** classifier models (Phase 3), `/omlx` (Phase 4), sleeping models (row 14, not reproducible), preventing omlx from evicting a model during chat (row 30, not reproducible), live image input (row 21: the `vlm` → `["text","image"]` mapping is unit-tested; no VLM is guaranteed on the test server), and context overflow, malformed/partial streams, Unicode boundaries, cross-provider handoff, and auth refresh (chat delegates unchanged to `@earendil-works/pi-ai/compat` `openai-completions`, which owns those behaviors).

### Architectural Constraints

- Catalog source is `GET /v1/models/status` (management key). `/v1/models` supplies `max_model_len` and the alias id.
- `/model` lists only rows with `loaded === true` (row 15, mirrors `--no-models-autoload`), `model_type` `llm` or `vlm` (rows 18–19), not `is_hidden`, and `model_format !== "gguf"` (GGUF unsupported). `is_loading` rows are excluded (row 16).
- Model id is the `/v1/models` id (the alias when `model_alias` is set); the physical status id is kept only for management (row 20).
- `input` is `["text","image"]` for `vlm`, else `["text"]` (row 21). Cost all zeros (row 22).
- Context window chain (row 23): `max_model_len`, then status `model_context_length`, then the cached context window from the stored catalog, else `128000`. `maxTokens` equals the context window (row 24).
- Thinking (rows 25–27): `reasoning` is true only for a loaded row whose `thinking_default` is a boolean or whose `reasoning_efforts` is non-empty. When true: `thinkingLevelMap { off: "off", minimal: null, low: null, medium: "medium", high: null, xhigh: null }`, `compat.thinkingFormat: "qwen-chat-template"`.
- Compat (row 28): `supportsStore: false`, `supportsDeveloperRole: false`, `supportsReasoningEffort: false`, `supportsUsageInStreaming: true`, `supportsStrictMode: false`, `maxTokensField: "max_tokens"`.
- `api: "openai-completions"`; chat delegates to `@earendil-works/pi-ai/compat` (row 29). No custom stream.
- `refreshModels` follows the llama two-phase contract: restore `context.stored` models with `provider === "omlx"` via `publish({ update })` and return on a false publish; skip the network phase unless `allowNetwork`, not aborted, and `credential.type === "api_key"` with an `OMLX_BASE_URL`; then fetch, map, and `publish({ persist: { models, checkedAt }, update })`.

### Actionable TODOs

- [x] `packages/omlx/client.ts` — add `listStatus(signal?)` for `GET /v1/models/status` returning the typed `models` rows (`id`, `loaded`, `is_loading`, `model_type`, `engine_type`, `model_format`, `model_context_length`, `thinking_default`, `reasoning_efforts`, `is_hidden`, `model_alias`, `estimated_size`, `loading_started_at`) plus `load_seconds_per_gb_estimate` and `load_time_observations`, and throws `"omlx returned an invalid model status"` on a bad shape; add `load(id, signal?)` (`POST /v1/models/{id}/load`), `unload(id, signal?)` (`POST /v1/models/{id}/unload`, 202 accepted), `unloadAndWait(id, signal?)` (poll `/v1/models/status` every 100 ms until `loaded` is false).
- [x] `packages/omlx/catalog.ts` — pure functions: `isChatRow`, `isDecisionRow`, `isGgufRow`, `isSelectableChatRow`, `contextWindowOf(row, maxModelLen, cached)`, `toPiChatModel(row, displayId, serverUrl, maxModelLen, cached)` per the constraints.
- [x] `packages/omlx/provider.ts` — implement `refreshModels` and `setCatalog` per the constraints; `getModels` returns chat models.
- [x] `packages/omlx/fixtures/status.json` — a captured `GET /v1/models/status` body with secrets removed, containing at least: loaded `llm`, unloaded `llm`, loaded `vlm`, loaded `decision`, loaded `embedding`, a `gguf` row, a hidden row, an aliased row, a thinking row with `reasoning_efforts`.
- [x] `packages/omlx/fixtures/models.json` — the matching captured `GET /v1/models` body.
- [x] `packages/omlx/live.test.ts` — `describe.skipIf(!process.env.OMLX_LIVE)`, real server only, no mocks: (1) ensure `OMLX_TEST_MODEL` is loaded through `OmlxClient.load` (idempotent: omlx answers "Already loaded"); (2) run `provider.refreshModels` with a real `publish` that applies `update` and an `api_key` credential from `OMLX_API_KEY`/`OMLX_BASE_URL`; assert the published chat ids equal the set computed from a direct `GET /v1/models/status` with the Phase 2 filter, and that `OMLX_TEST_MODEL`'s `contextWindow` equals its `/v1/models` `max_model_len`; (3) unload `OMLX_TEST_MODEL`, refresh again, assert it is absent; (4) reload it, call `provider.streamSimple` with `apiKey` and the `/v1` base URL and prompt "Reply with exactly: OK"; assert the final message has `stopReason` `stop` and text containing `OK`; (5) call `provider.streamSimple` on `OMLX_TEST_MODEL` with one tool `get_time` (no parameters) and prompt "Call get_time."; assert `stopReason` `toolUse` and one tool call named `get_time`; (6) assert the step-(4) message has `usage.input > 0` and `usage.cost.total === 0`; (7) start a `streamSimple` with an `AbortSignal` aborted after the first event and assert `stopReason` `aborted`.
- [x] `packages/omlx/catalog.test.ts` — over the fixtures: only loaded, non-hidden, non-GGUF `llm`/`vlm` rows map to chat models; alias becomes the id; `vlm` gets image input; context chain incl. `128000` fallback; `maxTokens === contextWindow`; thinking map and `qwen-chat-template` only on qualifying loaded rows; compat flags exact.

### Testing Gates

| Criterion                                  | Command                                                                                                                                                                                                                              | Expected                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog unit tests pass                    | `npx vitest run packages/omlx`                                                                                                                                                                                                       | exit 0; `catalog.test.ts` passes                                                                                                                                |
| Full quality gate                          | `npm run check`                                                                                                                                                                                                                      | exit 0                                                                                                                                                          |
| Live catalog and chat `needs: omlx-server` | `OMLX_LIVE=1 npx vitest run packages/omlx/live.test.ts`                                                                                                                                                                              | exit 0; all live tests pass, none skipped                                                                                                                       |
| `/model` in real pi `needs: tui-human`     | In `pi -e ./packages/omlx` with `/login omlx` done: open `/model`, then load `OMLX_TEST_MODEL` with `curl -X POST -H "Authorization: Bearer $OMLX_API_KEY" "$OMLX_BASE_URL/v1/models/$OMLX_TEST_MODEL/load"` and open `/model` again | first view lacks the unloaded model; second view lists `omlx/<id>` after the background refresh; selecting it and sending "Reply with exactly: OK" returns `OK` |

## Phase 3 — Classifiers

**Entry:** 2 **Shippable as:** omlx chat and decision models usable as classifiers with llama-equivalent answers.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

Parity rows 55–60. List classifiers and answer `choice`/`bool`/`score` through omlx `POST /v1/systemone`.

**Out:** image classification (row 57: text only, as llama), porting `llama-cpp-classify` (`/tokenize`, `/apply-template`, `/completion` do not exist on omlx), GGUF decision models.

### Architectural Constraints

- Classifier models: every selectable chat model plus loaded `model_type === "decision"` rows, excluding GGUF; same id; `type: "classifier"`; `api: "typesafe-system-one"`; `baseUrl` is the `/v1` URL; `input: ["text"]`; cost zeros; `contextWindow` from the Phase 2 chain. Decision-only rows never appear in `getModels()` (row 56).
- `provider.classify` validates Pi's limits before any request: choice 2–62 options, score 2–10 levels, else the same error text llama uses (row 60).
- Delegate the request to `typesafeSystemOneApi().classify`, loaded with a dynamic `import("@earendil-works/pi-ai/api/typesafe-system-one.lazy")` inside `classify` so module linking cannot fail extension load on oh-my-pi. Pass `options.fetch` as a wrapper around the caller's `fetch ?? globalThis.fetch` that clones the `/v1/systemone` response and keeps its raw `answers`. Pi's parser drops score `probabilities` (`system-one-shared.js`), so score temperature and score/confidence recomputation read `probabilities` from the retained raw answer.
- After a successful answer, apply temperature client-side when `options.temperature` is set: must be a positive finite number (llama's error text otherwise); scale each question's probabilities by `p^(1/T)` and renormalize; bool uses `[p, 1-p]` (row 59).
- Recompute choice and score confidence with Pi's `(n * peak - 1) / (n - 1)` clamped to [0, 1], and recompute score as the expected level from the scaled probabilities (row 58).
- Errors return a classifier result with empty `answers`, `stopReason` `error` or `aborted`, never a rejection.

### Actionable TODOs

- [ ] `packages/omlx/catalog.ts` — add `toPiClassifierModel(row, displayId, serverUrl, maxModelLen, cached)`.
- [ ] `packages/omlx/classify.ts` — exports `validateClassifierLimits(context)`, `applyTemperature(answers, context, temperature)`, `peakConfidence(probabilities)`, and `createOmlxClassify()` that composes limits, delegation, and post-processing per the constraints.
- [ ] `packages/omlx/provider.ts` — publish classifiers alongside chat models in `refreshModels`/`setCatalog`; `getAllModels` returns both; `classify` uses `createOmlxClassify()`.
- [ ] `packages/omlx/catalog.test.ts` — add: after `setCatalog` with `fixtures/status.json` + `fixtures/models.json`, the loaded `decision` row's id is in `provider.getAllModels()` (type `classifier`, api `typesafe-system-one`) and not in `provider.getModels()`; GGUF rows are in neither.
- [ ] `packages/omlx/classify.test.ts` — pure tests: limit errors at 1 and 63 choices, 1 and 11 levels; temperature 1 is identity; temperature > 1 flattens without changing argmax; bool scaling; confidence formula; non-positive temperature error; score temperature and expected-level recomputation over a raw omlx score answer with `"probabilities" {"0":…, "1":…}`.
- [ ] `packages/omlx/live.test.ts` — add a classifier case: calls `provider.classify` against the real server with one `bool`, one `choice`, one `score` question on `OMLX_TEST_MODEL`; asserts `stopReason === "stop"` and answer types; for the `choice` answer, `probabilities` sum to 1 ± 0.01; the `bool` answer's `probability` and the `score` answer's `score` and `confidence` are finite numbers in range.

### Testing Gates

| Criterion                                | Command                                                 | Expected                                                                                          |
| ---------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Classifier unit tests pass               | `npx vitest run packages/omlx`                          | exit 0; `classify.test.ts` passes; `live.test.ts` skipped without `OMLX_LIVE`                     |
| Full quality gate                        | `npm run check`                                         | exit 0                                                                                            |
| Live classification `needs: omlx-server` | `OMLX_LIVE=1 npx vitest run packages/omlx/live.test.ts` | exit 0; all live tests pass, none skipped                                                         |
| Decision rows are classifier-only        | `npx vitest run packages/omlx/catalog.test.ts`          | exit 0; a test asserts the fixture `decision` row is in `getAllModels()` and not in `getModels()` |

## Phase 4 — `/omlx` manager: list, load, unload, progress, restore

**Entry:** 2 **Shippable as:** `/omlx` lists models and loads or unloads them like `/llama`.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

Parity rows 31–45 (download row is Phase 5) and rows 16–17 in the manager.

**Out:** downloads (Phase 5), server-side load cancellation (row 40: not reproducible; Esc stops waiting only), guaranteeing "Keep loaded" when memory is short (row 38: omlx may evict).

### Architectural Constraints

- Command `omlx`, description `"Manage omlx models"`; TUI only, otherwise warn `"/omlx is available in interactive mode"` (rows 31–32). Not configured: `"Configure omlx with /login omlx"` (row 33).
- UI built only from Pi exports: `ctx.ui.custom`, `@earendil-works/pi-tui` (`Container`, `SelectList`, `Text`, `Spacer`, `Input`, `fuzzyFilter`, `truncateToWidth`, `visibleWidth`), and `DynamicBorder`/`keyHint` from `@earendil-works/pi-coding-agent` via namespace import with a runtime check. Same titles, item text, and key hints as llama's `ui.js` with `llama.cpp` replaced by `omlx`, except the `:quant` hints: the "Download model…" description is `"Hugging Face owner/repository (MLX only)"` and the search hint is `"Model name or owner/repository (MLX only)"`.
- List rows: physical non-GGUF `llm`, `vlm`, `decision` status rows; sorted loaded-first then by id; description `loaded` plus context label (`Nk`) for loaded rows, `loading` for `is_loading`, nothing for unloaded; last item `"Download model…"` (row 35–36).
- Catalog read failure opens Retry/Close; connection errors show `"Could not connect to the server."`; Retry does not replay an action (row 34).
- Unload: confirm `"Unload model?"`, `POST /v1/models/{id}/unload`, then poll status every 100 ms until `loaded` is false; 202 is accepted; then refresh and notify `Unloaded <id>` as llama does (row 37).
- Load: if other models are loaded, select `"Unload all and load"`, `"Keep loaded and load"`, `"Cancel"` (row 38). Load with `POST /v1/models/{id}/load` inside a progress view titled `"Loading model"`, message `"Loading model"`. Ratio only when status `load_time_observations >= 2`: `elapsed / max(3, 1 + estimated_size/1024^3 * load_seconds_per_gb_estimate)`, capped at 0.99 (row 39). Esc asks `"Stop loading?"`; confirming stops waiting and notifies that omlx finishes the load in the background (row 40). Cancel or failure after "Unload all" restores the previously loaded models (row 41). Success: `Loaded <id>` (row 42). `is_loading` row: warn `"<id> is loading"` (row 43). 409/507 `detail` shown as error notify (row 44).
- After any action, refresh the catalog through `ctx.modelRegistry.refresh({ providers: ["omlx"], allowNetwork: true, signal })` with a 15 s timeout.
- Never call `DELETE /admin/api/hf/models/*` (row 45).

### Actionable TODOs

- [ ] `packages/omlx/client.ts` — reuse `load`/`unload`/`unloadAndWait` from Phase 2; no new methods unless a constraint needs one.
- [ ] `packages/omlx/progress.ts` — pure `loadRatio(row, status, now)` per the constraint; returns `undefined` when under two observations.
- [ ] `packages/omlx/ui.ts` — `showOmlxUi(ctx, run)`, `runWithProgress(ui, options)` and the list/select/confirm/connection-error/progress views per the constraints.
- [ ] `packages/omlx/index.ts` — register command `omlx` with the handler wiring list, load, unload, restore, and catalog refresh.
- [ ] `packages/omlx/progress.test.ts` — ratio undefined under two observations, capped below 1, 3 s floor.
- [ ] `packages/omlx/manager.test.ts` — pure list-building tests over `fixtures/status.json`: GGUF and non-chat/non-decision rows excluded, sort order, descriptions; the last item is `Download model…` with description `Hugging Face owner/repository (MLX only)`.
- [ ] `packages/omlx/index.test.ts` — assert command `omlx` is registered alongside provider `omlx`; run its handler with a recording ctx (`mode: "print"`) and assert the interactive-mode warning.

### Testing Gates

| Criterion                              | Command                                                                                                                                        | Expected                                                                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manager unit tests pass                | `npx vitest run packages/omlx`                                                                                                                 | exit 0                                                                                                                                                |
| Full quality gate                      | `npm run check`                                                                                                                                | exit 0                                                                                                                                                |
| Non-TUI mode warns                     | `npx vitest run packages/omlx/index.test.ts`                                                                                                   | exit 0; a test runs the `omlx` handler with a ctx whose `mode` is `"print"` and records `notify("/omlx is available in interactive mode", "warning")` |
| Load and unload `needs: tui-human`     | In `pi -e ./packages/omlx`: `/omlx`, select unloaded `OMLX_TEST_MODEL`, choose "Keep loaded and load"; then select it again and confirm unload | progress view appears; `Loaded <id>`; model then appears in `/model`; after unload it is gone from `/model` and status shows `loaded: false`          |
| Replace and restore `needs: tui-human` | With model A loaded, load model B with "Unload all and load" and press Esc → confirm stop                                                      | stop-waiting notice shown; model A is reloaded                                                                                                        |
| Server down `needs: tui-human`         | Stop omlx, run `/omlx`                                                                                                                         | "omlx unavailable" with Retry and Close; Retry after restart shows the list                                                                           |

## Phase 5 — `/omlx` downloads (MLX only)

**Entry:** 4 **Shippable as:** `/omlx` → "Download model…" downloads MLX repos through omlx like `/llama` downloads.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

Parity rows 46–54 and the GGUF download rule.

**Out:** GGUF repos and `:quant` selection (rows 47, 49: decided unsupported), ModelScope (`/admin/api/ms/*`), deleting downloaded files, downloads with an omlx sub key (row 54: omlx requires the main key).

### Architectural Constraints

- Admin routes are served under the `/admin` prefix (`omlx/admin/routes.py` `APIRouter(prefix="/admin")`); management calls strip `/v1` and prefix `/admin`.
- Search: same view as llama (2+ chars, 500 ms debounce, lowercased cache, fuzzy filter, `<n> downloads`), backed by `GET /admin/api/hf/search?q=<q>&sort=downloads&limit=20&model_format=mlx` (row 46).
- Exact entry `owner/repo` bypasses the list. `owner/repo:<anything>` is rejected with `"This extension supports MLX models only. GGUF quantizations are not supported."` (row 47).
- Order matches llama: the gated check runs first — `GET https://huggingface.co/api/models/<id>` with the Hugging Face token; `gated` `auto`/`manual` shows llama's Continue/Back select with the access link (row 48). Then `GET /admin/api/hf/model-info?repo_id=<id>` with header `X-HF-Token: <token>` when a token exists; if `layout === "gguf"`, reject with the same MLX-only message. No quantization picker (row 49).
- Token lookup same as llama's `findHuggingFaceToken` (row 50): trimmed `HF_TOKEN`, then `HF_TOKEN_PATH`, `$HF_HOME/token`, `$XDG_CACHE_HOME/huggingface/token`, `~/.cache/huggingface/token`; passed as `hf_token`.
- Download `POST /admin/api/hf/download { repo_id, hf_token }`; poll `GET /admin/api/hf/tasks` every 500 ms; progress `"Downloading model"`, ratio `downloaded_size/total_size`, detail `<done> / <total>` in llama's `formatBytes` (row 51). Esc asks `"Stop download?"` and calls `POST /admin/api/hf/cancel/{task_id}` (row 52). `completed` → refresh catalog and notify `Downloaded <repo>`; `failed` → error notify with task `error` (row 53). 401 shows that downloads need omlx's main API key (row 54).

### Actionable TODOs

- [ ] `packages/omlx/client.ts` — add `hfSearch(q, signal)`, `hfModelInfo(repoId, hfToken, signal)` (sends `X-HF-Token` when `hfToken` is set), `hfDownload(repoId, hfToken, signal)` (sends `hf_token` as a string, `""` when absent, never `null`), `hfTasks(signal)`, `hfCancel(taskId, signal)`.
- [ ] `packages/omlx/huggingface.ts` — `findHuggingFaceToken(env)`, `fetchGated(repoId, token, signal)`, `formatBytes(bytes)`, `parseDownloadInput(value)` returning `{ repoId }` or the MLX-only error for `:quant`.
- [ ] `packages/omlx/ui.ts` — add the search view and download progress view.
- [ ] `packages/omlx/index.ts` — wire "Download model…".
- [ ] `packages/omlx/huggingface.test.ts` — token order with temp files (real filesystem), whitespace skipping, `formatBytes` cases, `parseDownloadInput` accepts `owner/repo`, rejects `owner/repo:Q4_K_M`.

### Testing Gates

| Criterion                                                                 | Command                                                                                                                                                          | Expected                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Download unit tests pass                                                  | `npx vitest run packages/omlx`                                                                                                                                   | exit 0                                                                         |
| Full quality gate                                                         | `npm run check`                                                                                                                                                  | exit 0                                                                         |
| MLX search route works with the main key `needs: omlx-server` `needs: jq` | `curl -s -H "Authorization: Bearer $OMLX_API_KEY" "$OMLX_BASE_URL/admin/api/hf/search?q=qwen&sort=downloads&limit=5&model_format=mlx" \| jq '.models \| length'` | a number ≥ 1                                                                   |
| GGUF rejected `needs: tui-human`                                          | `/omlx` → Download → type `unsloth/Qwen3-8B-GGUF:Q4_K_M`                                                                                                         | MLX-only error; no new task in `GET /admin/api/hf/tasks`                       |
| Real MLX download `needs: hf-network`                                     | `/omlx` → Download → a small `mlx-community` repo                                                                                                                | progress bar with bytes; `Downloaded <repo>`; repo appears in the `/omlx` list |

## Phase 6 — Docs, extension-load harness, Release Please registration

**Entry:** 3, 5 **Shippable as:** a releasable `@jmcombs/pi-omlx` package.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

Document the package, register it for the two-host load check and Release Please.

**Out:** publishing to npm (human, `CONTRIBUTING.md` → bootstrap publish), editing workflows or CODEOWNERS.

### Architectural Constraints

- README states: MLX models only; omlx has limited GGUF support but this extension does not work with GGUF; GGUF users use Pi's built-in llama.cpp provider.
- README lists every decided difference from the llama.cpp provider: rows 9 (generic post-login message; run `/omlx`, then `/model`), 10, 14, 30, 38, 40, 47, 49, 54.
- README documents `/login omlx`, `OMLX_BASE_URL`, `OMLX_API_KEY`, default URL `http://127.0.0.1:8000`, `/omlx`, `/model`, classifiers.
- Harness expected surface for `omlx` is exact: command `omlx`, provider `omlx`.

### Actionable TODOs

- [ ] `packages/omlx/README.md` — content per the constraints.
- [ ] `packages/omlx/package.json` — remove `private: true`; `pi.image` `https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/omlx/preview.png`.
- [ ] `assets/omlx/preview.png` — gallery image supplied by the human.
- [ ] `release-please-config.json` — add `packages/omlx` entry (`release-type` `node`, `component` `omlx`, `package-name` `@jmcombs/pi-omlx`, `changelog-path` `CHANGELOG.md`).
- [ ] `.release-please-manifest.json` — add `"packages/omlx": "0.0.0"`.
- [ ] `docker/smoke-harness.mts` — add `omlx` to `EXPECTED` with command `omlx` and provider `omlx`.
- [ ] `docker/smoke-harness.mts` — `captureProviders` records `typeof arg === "string" ? arg : arg.id` for `registerProvider` (Pi 1.4.0 `registerProvider(provider: Provider)` overload, `core/extensions/types.d.ts:1358`) and records, rather than throws on, `registerCommand`; the relay entry and every other stub guard stay unchanged; update the doc comment and the `CONTRIBUTING.md` "Expected surface per extension" text that calls provider capture provider-only.
- [ ] `CONTRIBUTING.md` — add the `omlx` row to "Expected surface per extension".
- [ ] `README.md` — add `@jmcombs/pi-omlx` to the package list.

### Testing Gates

| Criterion                            | Command                                                                                                                   | Expected                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Version conventions                  | `npm run check:versions`                                                                                                  | exit 0                                                                          |
| Full quality gate                    | `npm run check`                                                                                                           | exit 0                                                                          |
| Two-host load check `needs: docker`  | `npm run validate:extension-load`                                                                                         | exit 0; `omlx` line shows command `omlx` and provider `omlx` on pi and oh-my-pi |
| GGUF statement present               | `grep -n "GGUF" packages/omlx/README.md`                                                                                  | lines stating MLX only and that GGUF is not supported                           |
| Differences documented               | `grep -cE "post-login\|-builtin\|sleeping\|evict\|Keep loaded\|Stop loading\|GGUF\|main API key" packages/omlx/README.md` | ≥ 8                                                                             |
| Gallery asset `needs: gallery-asset` | `ls assets/omlx/preview.png`                                                                                              | file exists                                                                     |

## Appendix A — Asset/source map

| Phase | Source                                                                                                    | Repo destination                                                             |
| ----- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1     | `packages/_template/*`                                                                                    | `packages/omlx/*`                                                            |
| 1     | Pi llama `client.js` `normalizeLlamaServerUrl`, `provider.js` auth                                        | `packages/omlx/url.ts`, `packages/omlx/provider.ts`                          |
| 2     | Pi llama `provider.js` `refreshModels`, `toPiModel`; omlx `server.py` `list_models`, `list_models_status` | `packages/omlx/catalog.ts`, `packages/omlx/provider.ts`                      |
| 2     | Live omlx responses                                                                                       | `packages/omlx/fixtures/status.json`, `packages/omlx/fixtures/models.json`   |
| 3     | Pi `llama-cpp-classify.js` formulas, `typesafe-system-one.js`; omlx `api/decisions.py`, `models/*.py`     | `packages/omlx/classify.ts`                                                  |
| 4     | Pi llama `ui.js`, `index.js`; omlx `admin/routes.py` load estimate                                        | `packages/omlx/ui.ts`, `packages/omlx/progress.ts`, `packages/omlx/index.ts` |
| 5     | Pi llama `huggingface.js`; omlx `admin/routes.py`, `admin/hf_downloader.py`                               | `packages/omlx/huggingface.ts`, `packages/omlx/client.ts`                    |
| 6     | `.pi/context/omlx-provider-design.md` differences                                                         | `packages/omlx/README.md`; `docker/smoke-harness.mts`; release files         |

## Appendix C — Master TODO index

- [x] Phase 1 — Package scaffold, client, provider registration, auth
- [x] Phase 2 — Catalog refresh, chat models, context, thinking, GGUF exclusion
- [ ] Phase 3 — Classifiers
- [ ] Phase 4 — `/omlx` manager: list, load, unload, progress, restore
- [ ] Phase 5 — `/omlx` downloads (MLX only)
- [ ] Phase 6 — Docs, extension-load harness, Release Please registration

## Appendix D — Definition of Done

- `git-hygiene` followed: phase branch, Conventional Commits scoped `omlx`, never `main`.
- `npm run check` exits 0.
- Full-repo regression green: `npm run test` exits 0.
- Every Testing Gate re-run with **real** output, or marked HUMAN-VERIFY with an Appendix E row.
- Every literal TODO path exists (`ls` each).
- PR opened with green `Quality Gate (Node 22)`, `Quality Gate (Node 24)`, `Commit Messages`.
- Merge is human-gated; the merger ticks checkboxes inside the approved phase PR.

## Appendix E — Deferred-gate ledger

| Gate              | Deferred at | Needs     | Discharge by | Status     |
| ----------------- | ----------- | --------- | ------------ | ---------- |
| Interactive login | Phase 1     | tui-human | human        | DISCHARGED |
| /model in real pi | Phase 2     | tui-human | human        | DISCHARGED |

Human out-of-band discharge of Interactive login (Phase 1): prompt `API key (required)`; blank key `Error: Failed to save API key for omlx: API key required` (stores nothing); wrong key `Error: Failed to save API key for omlx: Invalid API key` (stores nothing); real key `Saved API key for omlx. Credentials saved to /Users/jmcombs/.pi/agent/auth.json`.

Human out-of-band discharge of /model in real pi (Phase 2), at commit 5ae6b50ef047a168134963740553bdc2ef113010, model Qwen3.8-27B-oQ8e-mtp: unload before the first view `unload:200`; first `/model` view did not list `Qwen3.8-27B-oQ8e-mtp`; load between the two views, without restarting pi, `load:200`; second `/model` view listed `Qwen3.8-27B-oQ8e-mtp [omlx]`; reply to "Reply with exactly: OK" contained `OK`.
