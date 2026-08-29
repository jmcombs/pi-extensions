# Contributing

Thanks for your interest in contributing! This file is the source of truth for project
conventions; `VERSIONING.md` covers the semver + release-automation policy. Please skim
both before opening a PR.

## Quick Start

```bash
# Use the repo's pinned Node version
nvm use   # reads .nvmrc → Node 24

# Install
npm ci

# Run the full quality gate
npm run check
```

> **Node version policy.** This project requires **Node ≥ 22.19.0**. CI runs the
> quality gate on **Node 22 and Node 24**. The release pipeline (and `.nvmrc`) is
> pinned to **Node 24**, which ships npm 11+ — required for npm Trusted Publishing
> with provenance. Node 20 is no longer supported.

## Branching & Commits

- Default branch: `main`
- Use [Conventional Commits](https://www.conventionalcommits.org/). Husky's `commit-msg` hook
  enforces this locally, and the `commitlint` job enforces it in CI.
- Use the package directory as the scope when relevant, e.g.
  `feat(tavily-search): add result truncation flag`.
- Breaking changes use the `!` suffix or a `BREAKING CHANGE:` footer; Release Please uses
  these to bump the major version.

## The Quality Gate (`npm run check`)

| Step     | Command                  | Purpose                                                                                  |
| -------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| Lint     | `npm run lint`           | Biome `check` — linter (recommended rules, incl. security) + formatter + import sorting  |
| Format   | `npm run format:check`   | Biome formatter check (fix with `npm run format`)                                        |
| Types    | `npm run typecheck`      | `tsc --noEmit` against the root `tsconfig.json`                                          |
| Tests    | `npm run test`           | Vitest (only meaningful tests; see "Testing" below)                                      |
| Versions | `npm run check:versions` | Validates each package follows project conventions                                       |
| Security | `npm run security`       | `secretlint` + `npm audit --omit=dev`                                                    |

All steps must pass on Node 22 and Node 24 in CI.

## Continuous Integration

See [docs/ci.md](docs/ci.md) for what each CI check exercises and what a green does and
does not prove — the Quality Gate, the advisory Extension Load Check, and Release Please.

## Branch Protection

The `main` branch is protected by a GitHub **Repository Ruleset** named
**Protect main**. The ruleset is configured in the GitHub UI
(Settings → Rules → Rulesets) rather than in a checked-in file. This section
is the source of truth for what that ruleset enforces and why.

### Rules

| Rule                                                               | Setting | Purpose                                                                                                                |
| ------------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| Restrict deletions                                                 | ✅      | Prevent accidental deletion of `main`.                                                                                 |
| Block force pushes                                                 | ✅      | Preserve linear history that Release Please relies on for changelog generation and tag stability.                      |
| Require linear history                                             | ✅      | Keeps `git log --oneline` aligned with Conventional Commits and tag boundaries.                                        |
| Require a pull request before merging                              | ✅      | Forces non-maintainer changes through review.                                                                          |
| ↳ Required approvals                                               | `1`     | At least one human approval per PR (see Code Owners below).                                                            |
| ↳ Dismiss stale pull request approvals when new commits are pushed | ✅      | Approvals re-validate after any new push.                                                                              |
| ↳ Require review from Code Owners                                  | ✅      | The approval must come from an owner listed in `.github/CODEOWNERS` (currently `@jmcombs`), not just any collaborator. |
| Require status checks to pass                                      | ✅      | All required checks must be green before merge.                                                                        |
| ↳ Require branches to be up to date before merging                 | ✅      | Avoids "green at merge, red on `main`" surprises with the Release Please manifest.                                     |
| ↳ Required check: `Quality Gate (Node 22)`                         | ✅      | Same `npm run check` gate as local development, on Node 22.                                                            |
| ↳ Required check: `Quality Gate (Node 24)`                         | ✅      | Same gate on Node 24 (matches the release pipeline runtime).                                                           |
| ↳ Required check: `Commit Messages`                                | ✅      | Conventional Commits enforcement (commitlint).                                                                         |

> **Why "Require approval of the most recent reviewable push" is intentionally
> off.** With a sole maintainer who is also the only Code Owner, that rule turns
> every routine rebase of a bot-authored PR (e.g. a Release Please PR that
> conflicts after another release lands) into an admin-bypass merge, because the
> maintainer becomes "the last pusher" and cannot satisfy the rule themselves.
> Code Owner review is still required for outside contributions, so the
> protection that matters — only an owner can land changes — remains.

### Bypass: maintainer direct push

`Repository admin` is in the ruleset's bypass list with mode **Always**. In
practice this means `@jmcombs` (the sole maintainer) can:

- `git push origin main` directly without opening a PR, and
- self-merge their own PRs without a second human approval.

This is intentional for a sole-maintainer repo. Note that **CI only runs on
pull requests** (`ci.yml` triggers on `pull_request: [main]`), so a direct
push to `main` skips the quality gate. Always run `npm run check` locally
before pushing directly.

### Release Please PRs

Release Please opens per-package release PRs authored by `github-actions[bot]`.
The maintainer **approves and merges these manually** — the bot is _not_ in the
ruleset's bypass list. This is deliberate: every npm publish is gated by an
explicit human approval.

### Outside contributors

For anyone other than the maintainer, the resulting flow is:

1. Fork → feature branch → PR against `main`.
2. CI must be green on both Node 22 and Node 24, and `Commit Messages` must pass.
3. `@jmcombs` (Code Owner) must approve the PR.
4. Merge (squash or rebase) — must keep linear history.

### Changing the ruleset

Do not weaken the ruleset, add bypass actors, or alter `.github/CODEOWNERS`
without maintainer discussion. Update this section in the same PR as any
intentional change so the doc and the ruleset stay in sync.

## Testing Philosophy

- Only meaningful tests. No tests written purely to inflate coverage.
- **Do not mock external APIs.** If a test would require mocking a real network service, prefer
  a smoke test that verifies the extension loads and registers its tools/commands instead.
- Each package should have at least one smoke test that imports the extension's default factory
  and verifies it registers the expected resources against a minimal `ExtensionAPI` stub built
  from real types.

## Extension Load Check

These extensions must load on **two** hosts: [pi](https://github.com/earendil-works/pi-coding-agent)
(`@earendil-works/pi-coding-agent`) and **oh-my-pi** (`@oh-my-pi/pi-coding-agent`, a
Bun-targeted fork). A single command checks that every shipped extension still **loads
and registers** its declared surface on both:

```bash
npm run validate:extension-load
```

It builds an isolated container with **no `op` binary** and no access to your real
`~/.pi`, then drives each host's **own** real extension loader over every non-private
`packages/*` extension and asserts that each one **loads without error** and
**registers exactly its expected surface** on pi and stock oh-my-pi. Running through
Docker is deliberate: your machine may have the 1Password CLI (`op`) installed, and this
check must prove the extensions load when `op` is absent — the container guarantees that
regardless of your host. An **advisory** (informational, non-blocking) GitHub Actions job
runs the same two loaders runner-native on every pull request.

A package marked `private: true` (e.g. the extension template) is **excluded and logged**
— it is never silently skipped. Any unexpected failure to load, or a missing/extra part of
a package's surface, fails the check loudly (non-zero exit).

**What a green run does and does not prove.** A pass here means every extension **loads
and registers** its declared surface with `op` absent — it does **not** exercise
`op`-backed credential resolution (fetching a real secret from 1Password and using it).
That remains a separate, manual check run against a live `op` session.

### Expected surface per extension

This is the **complete** registered surface of each extension — the validation is
exact-set, so anything **missing or extra** fails. The only per-host difference is
`1password`'s `user_bash` handler (pi-only; see gotcha 2).

| Extension         | Tools                                     | Commands                                                              | Handlers                                                       | Shortcuts / Providers                              |
| ----------------- | ----------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| `1password`       | `bash`, `1p_diagnose`                     | `1password_diagnose`, `1password_setup`                              | `session_start`; `user_bash` **on pi only**                    | —                                                  |
| `better-toolsy`   | `ls`, `read`, `grep`, `find`, `edit`, `write` | —                                                                | `tool_call`                                                    | —                                                  |
| `blue-psl-10k`    | —                                         | `blue-psl-restore-footer`                                            | `session_start`, `model_select`, `turn_end`, `thinking_level_select` | —                                          |
| `context7`        | `context7_search`, `context7_get_docs`    | `context7_setup`                                                     | —                                                              | —                                                  |
| `grok-search`     | `grok_search`                             | `grok_setup`                                                         | —                                                              | —                                                  |
| `headroom`        | `headroom_retrieve`                       | `headroom-status`, `headroom_setup`, `headroom-stats`, `headroom-simulate` | `context`, `session_start`                               | —                                                  |
| `notify`          | —                                         | `notify`                                                             | `agent_start`, `turn_end`, `tool_execution_end`, `agent_end`   | —                                                  |
| `prompt-enhancer` | —                                         | `prompt_enhance`, `prompt_enhance_model`, `prompt_enhance_revert`, `prompt_enhance_auto` | `session_start`, `session_shutdown`, `model_select`, `input`   | shortcuts `ctrl+shift+e`, `ctrl+shift+z`           |
| `relay`           | —                                         | —                                                                   | —                                                              | providers `relay-claude`, `relay-grok` (via a stub host API — providers are not exposed by the loader result) |
| `steward`         | —                                         | `steward`, `steward-stop`                                           | `session_shutdown`                                             | —                                                  |
| `tavily-search`   | `tavily_search`                           | `tavily_setup`                                                      | —                                                              | —                                                  |

The table lives in the harness (`docker/smoke-harness.mts`) as the data it validates
against; keep it in sync when you add or change a package's surface — because the check
is exact-set, an incomplete entry fails rather than silently passing on a subset.

### Two cross-host gotchas the harness guards

1. **oh-my-pi's `--no-extensions` discards explicit `-e` paths; pi keeps them.** On pi,
   disabling discovery (`--no-extensions`) still loads any extension you name explicitly
   with `-e`. On oh-my-pi the same flag throws the `-e` paths away, so nothing loads and a
   slash command silently falls through to the model as chat. To load specific extensions
   on oh-my-pi, pass `-e` **without** `--no-extensions` and rely on an empty throwaway
   agent dir so discovery finds nothing else.

2. **Extensions must feature-detect optional host APIs.** oh-my-pi remaps every
   `@earendil-works/pi-coding-agent` import to its own compatibility shim, which exports
   only a subset of pi's runtime — and there is no override. A **static named import** of a
   symbol the shim lacks fails the module link and takes down the *entire* extension (and
   every extension that imports it) on oh-my-pi. So reach optional host APIs through a
   **namespace import plus a runtime check**, never a static named import. For example,
   `@jmcombs/pi-1password` accesses `createLocalBashOperations` this way and registers its
   `user_bash` hook (transparent 1Password injection for user `!` commands) **only when the
   host provides that API** — present on pi, absent on oh-my-pi's shim. The module still
   loads on both; the hook is simply pi-only, and the agent-facing bash tool and diagnostics
   work everywhere. This is why the table above marks `user_bash` as pi-only, and the
   harness asserts it **present on pi and absent on oh-my-pi**.

## Changing `prompt-enhancer`: Acceptance Evidence

`npm run check` cannot tell you whether a prompt change made rewrites better or worse. Only
real model calls can. So some changes to `packages/prompt-enhancer` need an acceptance run
attached to the PR. The harness that produces it is documented in
[`packages/prompt-enhancer/acceptance/README.md`](packages/prompt-enhancer/acceptance/README.md).

### When evidence is required

Required when you change what the model sees or how the rewrite is produced:

- `SYSTEM_PROMPT` or any other prompt text in `index.ts`
- context assembly (`gatherEnhancerContext`, `buildEnhancerUserMessage`, the caps and limits
  they use)
- the enhance path itself: the `prompt_enhance` command, the auto-enhance path, model
  selection, retry or failure handling

Not required for docs, README edits, tests, type-only changes, another package, or a change
to the acceptance harness that does not touch the extension.

If you are unsure, run it. A run that shows nothing changed is still useful.

### Running it

```bash
npx tsx packages/prompt-enhancer/acceptance/run-matrix.ts --n 6 \
  --model anthropic/claude-haiku-4-5 \
  --model xai/grok-4.6 \
  --out docs/prompt-enhancer/acceptance-<your-branch>.json
```

Pass `--model` once per model, or comma-separate them. A value is `provider/id` as
`pi -ne --list-models` prints it, with an optional `#api` label for readability. **Five
models is the cap.** Each one multiplies the whole fixture set by `n` paid calls, and a
table wider than five columns stops being read. Models are checked against your local `pi`
catalog before the first call, so a typo costs a second and not a whole run.

With no `--model` you get the maintainer's default five, which is almost certainly not what
you want to pay for.

### The baseline model

**Every run should include `anthropic/claude-haiku-4-5`.** It is the one column that makes
your artifact comparable with anyone else's, and it is the cheapest hosted model in the
default set. Without a shared column, two contributors' results are two unrelated claims.

If you have no Anthropic access, say so and the run still counts:

```bash
npx tsx packages/prompt-enhancer/acceptance/run-matrix.ts --n 6 \
  --model xai/grok-4.6 \
  --baseline-exempt "no Anthropic account; xAI credits only" \
  --out docs/prompt-enhancer/acceptance-<your-branch>.json
```

The reason is written into the artifact. `PROMPT_ENHANCER_BASELINE_EXEMPTION` works as an
environment variable if a flag is awkward. Skipping the baseline with no reason at all is
the one thing that fails verification.

### Attaching the artifact

Commit the JSON file to `docs/prompt-enhancer/` in the same PR, named for your branch. Say
in the PR description which models you ran, what `n` you used, and what changed compared
with the numbers in the file already there. Do not commit the `.partial.jsonl` progress
file; a successful run deletes it.

### What the maintainer runs

```bash
npm run check:acceptance-artifact -- docs/prompt-enhancer/acceptance-<your-branch>.json
```

This re-scores every recorded rewrite with the committed classifier and checks that the
stored verdicts match. It also checks the record counts, that no cell is missing, that the
fixtures you ran were the committed ones, and that the baseline was present or exempted with
a reason. It exits non-zero and prints why on any mismatch. Run it yourself before opening
the PR.

### Cost

Be honest with yourself about this before you start. A full pass at `--n 6` over 5 models and
8 fixtures is **240 real model calls at roughly 8,000 input tokens each**, so about 1.9M
input tokens plus output. You pay for that. A smaller `n` is fine and is often enough:
`--n 3` halves it, and a local model through `llama.cpp` costs nothing. Say what you ran in
the PR and the numbers can be read for what they are.

## Adding a New Extension

1. Skim this file and `VERSIONING.md` if you haven't.
2. Copy `packages/_template/` to `packages/<your-extension-name>/`.
3. Follow `TEMPLATE.md` (at the repo root) to fill in `package.json`, `index.ts`,
   `README.md`, and the LICENSE copy.
4. Drop a `preview.png` (and optional `preview.mp4`) into `assets/<your-extension-name>/`
   at the repo root.
5. Register the package in `release-please-config.json` and `.release-please-manifest.json`.
   Set the manifest value to `0.0.0` and the package's `package.json` `version`
   to `0.0.0`. The first releasable commit will then trigger a `1.0.0` release
   (Release Please's default for the first release of a `release-type: node`
   package; see `VERSIONING.md`).
6. Do the one-time bootstrap publish and configure npm Trusted Publishing for the
   new npm package (see below) — OIDC cannot create the package on its own.
7. Run `npm run check`. It must pass.
8. Open a PR using a Conventional Commits title scoped to the new package, e.g.
   `feat(my-extension): initial release`.

### One-time: bootstrap publish + configure npm Trusted Publishing

Releases publish to npm via [Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers).
No `NPM_TOKEN` is stored in GitHub. **OIDC cannot create a brand-new package**,
and npm will not let you attach a Trusted Publisher to a package name that does
not exist yet — so a new package needs a one-time **manual bootstrap publish**
before OIDC can take over:

1. **Bootstrap publish (manual, once).** With the package at `version: 0.0.0` and
   `private` removed, publish the placeholder from `main` using your own npm
   auth (interactive `npm login` or an automation token) to create the package
   and claim the name under the `@jmcombs` scope:

   ```bash
   npm publish --workspace=packages/<name> --access public
   ```

   This `0.0.0` is throwaway — Release Please's first managed release (`1.0.0`)
   supersedes it.

2. **Configure the Trusted Publisher (now that the package exists).** Sign in to
   npmjs.com as the package owner, open the package's **Settings → Publishing
   access → Trusted Publishers**, and add a GitHub Actions publisher with:
   - **Organization or user**: `jmcombs`
   - **Repository**: `pi-extensions`
   - **Workflow filename**: `release-please.yml`
   - **Environment**: _(leave blank)_

From that point on, the `publish` job in `release-please.yml` publishes that
package using OIDC. The job uses `--provenance --access public`, so each
released version gets a verifiable build attestation linking it to this
repository and the exact workflow run — and no `NPM_TOKEN` is ever needed again.

### Required `package.json` Fields

Each package must have:

- `name`: scoped under `@jmcombs/`, prefixed with `pi-` (e.g. `@jmcombs/pi-foo`)
- `version`: semver (Release Please manages bumps after the first release)
- `description`, `license: "MIT"`, `author: "Jeremy Combs"`
- `engines.node: ">=22.19.0"`
- `keywords` containing `"pi-package"`
- `pi.extensions`: array of paths to extension entry points
- `image` and/or `video`: raw GitHub URLs from `packages/<name>/assets/` (or root `assets/<name>/`)
  for the pi.dev gallery preview card
- `peerDependencies` for `@earendil-works/pi-coding-agent`, `typebox`, etc. (do not bundle
  Pi-provided runtime packages)

`scripts/sync-versions.mjs` validates these conventions; it runs as part of `npm run check`.

## Releases

Releases are automated.

1. Merge a PR with Conventional Commits to `main`.
2. The Release Please workflow opens (or updates) a per-package release PR.
3. Merging that release PR triggers a tag, a GitHub Release, and an npm publish via OIDC.

See `VERSIONING.md` for the full policy.

## Dependency Updates

[Dependabot](https://docs.github.com/en/code-security/dependabot) is enabled for the npm
workspace and for GitHub Actions (see `.github/dependabot.yml`).

- **Version updates** run weekly. Routine minor/patch bumps are **grouped** into a single PR
  per ecosystem (one npm PR, one Actions PR) to keep review load low; **major bumps arrive as
  individual PRs** so breaking changes get isolated scrutiny.
- **Security updates** are opened as needed from the GitHub Advisory Database (see the
  [Security](#security) section for the repo-level toggles).
- Every Dependabot PR is gated by the same `npm run check` quality gate as any other PR and
  requires maintainer (CODEOWNERS) approval before merge, per the "Protect main" ruleset —
  **nothing auto-merges.**
- Commit subjects use conventional prefixes (`chore(deps)`, `chore(deps-dev)`, `ci(actions)`)
  so they pass the `commitlint` job. These prefixes are configured in `.github/dependabot.yml`;
  do not remove them.

## Security

Never commit secrets. `secretlint` runs in `npm run check` to catch obvious mistakes, but you
are still responsible for what you commit. Use `~/.pi/agent/auth.json` or environment variables
for runtime secrets; see each package's README for guidance.

Dependabot **alerts** and **security updates** are enabled for the repository — the proactive
half of the supply-chain story (see [Dependency Updates](#dependency-updates)). They surface
vulnerable dependencies in the Security tab and open pre-patched fix PRs automatically.
