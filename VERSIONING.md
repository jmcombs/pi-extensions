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

## First Release

Each package's first release is **`1.0.0`**. This matches Release Please's default behavior for
`release-type: "node"` when there is no prior release recorded in the manifest, and it commits
us to SemVer discipline from day one. From `1.0.0` onward:

- `feat:` → `1.x → 1.(x+1).0`
- `fix:` → `1.x.y → 1.x.(y+1)`
- `feat!:` / `BREAKING CHANGE:` → `1.y → 2.0.0`

(`bump-minor-pre-major: true` remains set in `release-please-config.json` as a safety net for
any in-development work that lands while a package is still pre-release.)

## What Is "Public API"?

For a Pi extension, the public API is everything a Pi user or another extension can observe:

- Registered tools (names, parameter schemas, return shape)
- Registered commands (names, arguments)
- Registered shortcuts and flags
- Behavior of event subscriptions when present
- Required environment variables and `auth.json` keys
- The `package.json` `pi` manifest shape

Renaming a tool, removing a command, or removing a parameter is a **breaking change**. Adding
new optional parameters, adding new tools, or making error messages more helpful is **not**
breaking.

## Release Flow

1. Merge a Conventional Commits PR to `main`.
2. Release Please opens (or updates) a release PR per package whose history since the last
   release contains release-relevant commits.
3. Each release PR bumps `package.json`, updates `CHANGELOG.md`, and updates
   `.release-please-manifest.json`.
4. Merging the release PR creates a git tag of the form `<name>/v<version>` (e.g.
   `tavily-search/v1.2.0`), publishes a GitHub Release, and triggers the npm publish job for
   that package.
5. The publish job uses npm's Trusted Publishing (OIDC). No long-lived `NPM_TOKEN` is stored.

## Tagging Convention

`<package-dir-name>/v<version>` (matches `tag-separator: "/"`,
`include-component-in-tag: true`, and `include-v-in-tag: true` in `release-please-config.json`).

Examples:

- `tavily-search/v1.0.0`
- `tavily-search/v1.2.0`
- `prompt-enhancer/v1.0.0`

## Manual Release

You shouldn't need this. If you must, the safe path is to push a Conventional Commit (e.g.
`fix(tavily-search): bump version`) so Release Please picks it up.
