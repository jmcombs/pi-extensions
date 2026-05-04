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

> **Node version policy.** This project requires **Node ≥ 22.0.0**. CI runs the
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
| Lint     | `npm run lint`           | ESLint with type-aware `typescript-eslint` strict + stylistic + `eslint-plugin-security` |
| Format   | `npm run format:check`   | Prettier check across `**/*.{ts,json,md,yml,yaml}`                                       |
| Types    | `npm run typecheck`      | `tsc --noEmit` against the root `tsconfig.json`                                          |
| Tests    | `npm run test`           | Vitest (only meaningful tests; see "Testing" below)                                      |
| Versions | `npm run check:versions` | Validates each package follows project conventions                                       |
| Security | `npm run security`       | `secretlint` + `npm audit --omit=dev`                                                    |

All steps must pass on Node 22 and Node 24 in CI.

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
| ↳ Require approval of the most recent reviewable push              | ✅      | Mitigates approve-then-sneak-in-changes attacks.                                                                       |
| Require status checks to pass                                      | ✅      | All required checks must be green before merge.                                                                        |
| ↳ Require branches to be up to date before merging                 | ✅      | Avoids "green at merge, red on `main`" surprises with the Release Please manifest.                                     |
| ↳ Required check: `Quality Gate (Node 22)`                         | ✅      | Same `npm run check` gate as local development, on Node 22.                                                            |
| ↳ Required check: `Quality Gate (Node 24)`                         | ✅      | Same gate on Node 24 (matches the release pipeline runtime).                                                           |
| ↳ Required check: `Commit Messages`                                | ✅      | Conventional Commits enforcement (commitlint).                                                                         |

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
6. Add a per-package npm publish job to `.github/workflows/release-please.yml`
   (mirror the `publish-tavily-search` job; rename outputs and the workspace path).
7. **Configure npm Trusted Publishing** for the new npm package (see below).
   This is a one-time per-package step on npmjs.com.
8. Run `npm run check`. It must pass.
9. Open a PR using a Conventional Commits title scoped to the new package, e.g.
   `feat(my-extension): initial release`.

### One-time: configure npm Trusted Publishing

Releases publish to npm via [Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers).
No `NPM_TOKEN` is stored in GitHub. Each new npm package needs a one-time
configuration on npmjs.com:

1. Sign in to npmjs.com as the package owner.
2. Visit the package settings page (or, for a brand-new package, the
   organization's package-creation flow).
3. Under **Publishing access → Trusted Publishers**, add a GitHub Actions
   trusted publisher with:
   - **Organization or user**: `jmcombs`
   - **Repository**: `pi-extensions`
   - **Workflow filename**: `release-please.yml`
   - **Environment**: _(leave blank)_
4. Save.

From that point on, the `publish-<package>` job in `release-please.yml` can
publish that package using OIDC. The job uses `--provenance --access public`,
so the published version gets a verifiable build attestation linking it to
this repository and the exact workflow run.

For the very first publish of a brand-new scoped package, the npm account or
organization must already exist and own the scope (`@jmcombs`). Trusted
Publishing creates the package on first push as long as `--access public` is
passed.

### Required `package.json` Fields

Each package must have:

- `name`: scoped under `@jmcombs/`, prefixed with `pi-` (e.g. `@jmcombs/pi-foo`)
- `version`: semver (Release Please manages bumps after the first release)
- `description`, `license: "MIT"`, `author: "Jeremy Combs"`
- `engines.node: ">=22.0.0"`
- `keywords` containing `"pi-package"`
- `pi.extensions`: array of paths to extension entry points
- `image` and/or `video`: raw GitHub URLs from `packages/<name>/assets/` (or root `assets/<name>/`)
  for the pi.dev gallery preview card
- `peerDependencies` for `@mariozechner/pi-coding-agent`, `typebox`, etc. (do not bundle
  Pi-provided runtime packages)

`scripts/sync-versions.mjs` validates these conventions; it runs as part of `npm run check`.

## Releases

Releases are automated.

1. Merge a PR with Conventional Commits to `main`.
2. The Release Please workflow opens (or updates) a per-package release PR.
3. Merging that release PR triggers a tag, a GitHub Release, and an npm publish via OIDC.

See `VERSIONING.md` for the full policy.

## Security

Never commit secrets. `secretlint` runs in `npm run check` to catch obvious mistakes, but you
are still responsible for what you commit. Use `~/.pi/agent/auth.json` or environment variables
for runtime secrets; see each package's README for guidance.
