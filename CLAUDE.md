# CLAUDE.md / Agent Notes

This file is loaded automatically by Claude Code (and respected by the Pi coding agent) as
project context. It is for AI assistants working in this repository.

## Source of Truth

`PLAN.md` is the single source of truth for project structure, standards, and roadmap.
**Always read `PLAN.md` before making non-trivial changes.**

The `PROMPT.md` file at the repo root is the canonical onboarding prompt for AI agents.

## Architecture in One Paragraph

This is an npm workspaces monorepo of Pi coding agent extensions. Each subdirectory of
`packages/` (other than `_template/`) is a publishable npm package tagged with the
`pi-package` keyword so it appears on https://pi.dev/packages. Extensions are TypeScript
modules loaded by Pi via [jiti](https://github.com/unjs/jiti) — there is no compile step
for shipping. Releases are driven by Release Please (`release-type: "node"`,
`separate-pull-requests: true`) with each package versioned independently and published to
npm via OIDC Trusted Publishing.

## Conventions You Must Follow

- Node `>= 20.6.0`. CI tests on Node 20 and Node 22.
- Conventional Commits, scoped to the package directory name when relevant
  (e.g. `feat(tavily-search): add result truncation flag`).
- All work must pass `npm run check` (lint, format, typecheck, test, version validation,
  security audit + secretlint).
- **No mocking external APIs in tests.** Smoke tests that load the extension and verify
  registration are the preferred shape.
- Each package's `package.json` must include: `keywords: ["pi-package"]`, a `pi` manifest
  with `extensions`, `license: "MIT"`, `author: "Jeremy Combs"`, `engines.node: ">=20.6.0"`,
  and `image`/`video` URLs for the gallery card.

## When Adding a New Extension

1. Copy `packages/_template/` to `packages/<new-name>/`.
2. Follow `TEMPLATE.md`.
3. Register the package in `release-please-config.json` and `.release-please-manifest.json`.
4. Add a per-package npm publish job to `.github/workflows/release-please.yml`.
5. Verify `npm run check` passes locally.

## Files You Should Never Edit Without Discussion

- `PLAN.md` — discuss with the maintainer before changing.
- `release-please-config.json` and `.release-please-manifest.json` — only edit when adding
  a new package or fixing a clear bug. Do not retroactively edit version numbers; let
  Release Please own them after the first release.

## Useful Commands

```bash
npm ci                  # install
npm run check           # full quality gate
npm run lint            # ESLint only
npm run format          # Prettier write
npm run test            # Vitest
npm run check:versions  # validate per-package conventions
```
