# pi-extensions

A monorepo of high-quality extensions for the [Pi coding agent](https://pi.dev).

Every package here is a Pi extension that can be installed individually from npm. Packages are tagged
with the `pi-package` keyword so they appear in the [pi.dev gallery](https://pi.dev/packages).

## Packages

<!-- Updated as packages land. -->

| Package    | npm | Description |
| ---------- | --- | ----------- |
| _none yet_ | —   | —           |

## Install an Extension

```bash
# Install globally
pi install npm:@jmcombs/pi-tavily-search

# Or try one for a single session
pi -e npm:@jmcombs/pi-tavily-search
```

See the [Pi packages documentation](https://pi.dev/docs/packages) for additional install options
(git, local path, project-scoped, filtering, etc.).

## Repository Layout

```
pi-extensions/
├── packages/
│   ├── _template/          # Scaffold for new extensions (see TEMPLATE.md)
│   └── <extension-name>/   # One directory per published package
├── scripts/
│   └── sync-versions.mjs   # Validates each package conforms to project conventions
├── .github/workflows/      # CI + Release Please
├── release-please-config.json
├── .release-please-manifest.json
└── …shared tooling (eslint, prettier, vitest, husky, commitlint, secretlint)
```

## Requirements

- Node.js `>= 20.6.0` (matches Pi's runtime requirement; CI tests on Node 20 and 22)
- npm 10+

## Quality Gate

Every PR runs the same `npm run check` gate:

```bash
npm run check
```

This runs lint, format check, type check, tests, version validation, and security checks
(`secretlint` + `npm audit --omit=dev`). All packages must pass.

## Branch Protection

The `main` branch is protected by a GitHub Repository Ruleset that requires PR review from
`@jmcombs`, all CI checks green on Node 20 and Node 22, Conventional Commits, and a linear
history. The maintainer can push directly to `main` via the admin bypass; outside contributors
must go through PR review. See [CONTRIBUTING.md → Branch Protection](CONTRIBUTING.md#branch-protection)
for the full rule list and rationale.

## Adding a New Extension

1. Read `CONTRIBUTING.md`.
2. Copy `packages/_template/` and follow `TEMPLATE.md`.
3. Open a PR. Release Please will produce a per-package release PR after merge.

## Versioning & Releases

Each package is versioned independently with semver. See `VERSIONING.md` for the full policy.
Releases are automated via [Release Please](https://github.com/googleapis/release-please) and
published to npm using [npm Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers).

## License

[MIT](./LICENSE) © Jeremy Combs
