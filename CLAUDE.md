# CLAUDE.md / Agent Notes

This file is loaded automatically by Claude Code (and respected by the Pi coding agent) as
project context. It is for AI assistants working in this repository.

## Sources of Truth

The project's conventions live in the public docs at the repo root:

| Doc                                                                        | Covers                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `README.md`                                                                | Project overview, install, package list                                               |
| `CONTRIBUTING.md`                                                          | Quality gate, commit format, testing philosophy, **adding a new extension**           |
| `CONTRIBUTING.md` → [Branch Protection](CONTRIBUTING.md#branch-protection) | The `main` branch ruleset, required checks, Code Owners, and the maintainer bypass    |
| `VERSIONING.md`                                                            | Semver policy, first-release-is-1.0.0 rationale, release flow, npm Trusted Publishing |
| `TEMPLATE.md`                                                              | Step-by-step guide for creating a new package from `packages/_template/`              |

Read those (especially `CONTRIBUTING.md` + `TEMPLATE.md`) before making non-trivial changes.

## Architecture in One Paragraph

This is an npm workspaces monorepo of Pi coding agent extensions. Each subdirectory of
`packages/` (other than `_template/`) is a publishable npm package tagged with the
`pi-package` keyword so it appears on https://pi.dev/packages. Extensions are TypeScript
modules loaded by Pi via [jiti](https://github.com/unjs/jiti) — there is no compile step
for shipping. Releases are driven by Release Please (`release-type: "node"`,
`separate-pull-requests: true`) with each package versioned independently and published to
npm via OIDC Trusted Publishing.

## Conventions You Must Follow

- Node `>= 22.0.0`. CI tests on Node 22 and Node 24; the release pipeline (and `.nvmrc`)
  is pinned to Node 24, which ships npm 11+ — required for npm Trusted Publishing.
  Node 20 is no longer supported.
- Conventional Commits, scoped to the package directory name when relevant
  (e.g. `feat(tavily-search): add result truncation flag`). Use `chore(<scope>):` for
  changes that should _not_ appear in the package's CHANGELOG (e.g. scaffolding,
  internal refactors that don't affect users).
- All work must pass `npm run check` (lint, format, typecheck, test, version validation,
  security audit + secretlint).
- **No mocking external APIs in tests.** Smoke tests that load the extension and verify
  registration are the preferred shape.
- Each package's `package.json` must include: `keywords: ["pi-package"]`, a `pi` manifest
  with `extensions`, `license: "MIT"`, `author: "Jeremy Combs"`, `engines.node: ">=22.0.0"`,
  and an `image` URL for the gallery card.

## When Adding a New Extension

Follow `TEMPLATE.md`. The full flow (including the one-time npm Trusted Publisher setup
that must happen before the first release) is in `CONTRIBUTING.md` → "Adding a New Extension".

## Branch Protection (operational rules for agents)

The `main` branch is protected by a GitHub Repository Ruleset named **Protect main**.
The full rule list lives in `CONTRIBUTING.md` → Branch Protection; agents working in
this repo must follow these operational rules:

- **Always work on a feature branch and open a PR**, even though the maintainer has
  admin bypass. CI only runs on pull requests, so direct pushes to `main` skip the
  quality gate — agents must not rely on that bypass.
- **All three required checks must be green** before handing back: `Quality Gate (Node 22)`,
  `Quality Gate (Node 24)`, and `Commit Messages`. If a change you make would fail any of
  them, fix it before declaring the task done.
- **Conventional Commits are enforced** by the `Commit Messages` check (commitlint). Use
  `chore(<scope>):` for changes that should not appear in a package CHANGELOG.
- **Code Owner review is required.** `.github/CODEOWNERS` lists `@jmcombs` as the sole
  owner. Do not add or remove entries without explicit maintainer instruction.
- **Do not propose disabling, weakening, or adding bypass actors to the ruleset.** Route
  any such suggestion to the maintainer instead of editing files to work around it.
- **Release Please PRs** (authored by `github-actions[bot]`) are merged manually by the
  maintainer; do not attempt to merge or auto-approve them.

## Files You Should Not Edit Without Discussion

- `release-please-config.json` and `.release-please-manifest.json` — only edit when adding
  a new package or fixing a clear bug. Do not retroactively edit version numbers; let
  Release Please own them after the first release.
- `.github/workflows/release-please.yml` — is now fully automated via a dynamic matrix; only the configuration files (`release-please-config.json` and `.release-please-manifest.json`) require updates.
- `.github/workflows/ci.yml` — the job names (`Quality Gate (Node 22)`, `Quality Gate
(Node 24)`, `Commit Messages`) are referenced by the **Protect main** ruleset as required
  status checks. Renaming or removing a job (or changing the matrix versions) will silently
  break branch protection.
- `.github/CODEOWNERS` — backs the ruleset's "Require review from Code Owners" rule.
  Editing it changes who can approve outside-contributor PRs.

## Useful Commands

```bash
npm ci                  # install
npm run check           # full quality gate
npm run lint            # ESLint only
npm run format          # Prettier write
npm run test            # Vitest
npm run check:versions  # validate per-package conventions
```
