# Versioning

Every package in `packages/` is versioned independently using [Semantic Versioning](https://semver.org/).
Releases are fully automated via [Release Please](https://github.com/googleapis/release-please) and
published to npm via [Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers).

## Semver Policy

- **Major (X.y.z)** — backwards-incompatible API or behavior change. Use `feat!:` or a
  `BREAKING CHANGE:` footer in the commit.
- **Minor (x.Y.z)** — a backwards-compatible new feature. Use `feat:`.
- **Patch (x.y.Z)** — a backwards-compatible bug fix or internal change visible to users. Use
  `fix:` (or `perf:`, `refactor:` when user-visible).

While a package is at `0.x`, the policy is conservative:

- `feat:` bumps the **minor** version (`bump-minor-pre-major: true`)
- `fix:` bumps the **patch** version
- `feat!:` / `BREAKING CHANGE:` bumps to the next minor as well; we wait for the package to
  reach `1.0.0` before honoring breaking changes as major bumps. Until then, treat the README
  as the contract and document breaking changes in CHANGELOG entries.

A package goes to `1.0.0` when it has been exercised by real users, has a stable API, and is
ready to commit to semver discipline.

## What Is "Public API"?

For a Pi extension, the public API is everything a Pi user or another extension can observe:

- Registered tools (names, parameter schemas, return shape)
- Registered commands (names, arguments)
- Registered shortcuts and flags
- Behavior of event subscriptions when present
- Required environment variables and `auth.json` keys
- The `package.json` `pi` manifest shape

Renaming a tool or removing a command is a **breaking change**. Adding new optional parameters
or new tools is **not** breaking.

## Release Flow

1. Merge a Conventional Commits PR to `main`.
2. Release Please opens (or updates) a release PR per package whose history since the last
   release contains release-relevant commits.
3. Each release PR bumps `package.json`, updates `CHANGELOG.md`, and updates
   `.release-please-manifest.json`.
4. Merging the release PR creates a git tag of the form `<name>/<version>` (e.g.
   `tavily-search/1.2.0`), publishes a GitHub Release, and triggers the npm publish job for that
   package.
5. The publish job uses npm's Trusted Publishing (OIDC). No long-lived `NPM_TOKEN` is stored.

## Tagging Convention

`<package-dir-name>/<version>` (matches `tag-separator: "/"` and `include-component-in-tag: true`
in `release-please-config.json`).

Examples:

- `tavily-search/1.0.0`
- `prompt-enhancer/0.2.1`

## Manual Release

You shouldn't need this. If you must, the safe path is to push a Conventional Commit (e.g.
`fix(tavily-search): bump version`) so Release Please picks it up.
