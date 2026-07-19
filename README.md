# pi-extensions

A monorepo of high-quality extensions for the [Pi coding agent](https://pi.dev).

Every package here is a Pi extension that can be installed individually from npm. Packages are tagged
with the `pi-package` keyword so they appear in the [pi.dev gallery](https://pi.dev/packages).

## Packages

| Package | npm | Description |
| --- | --- | --- |
| [`@jmcombs/pi-1password`](./packages/1password) | [![npm](https://img.shields.io/npm/v/@jmcombs/pi-1password.svg)](https://www.npmjs.com/package/@jmcombs/pi-1password) | 1Password secret injection — read secrets and run commands with credentials via the `op` CLI. |
| [`@jmcombs/pi-better-toolsy`](./packages/better-toolsy) | [![npm](https://img.shields.io/npm/v/@jmcombs/pi-better-toolsy.svg)](https://www.npmjs.com/package/@jmcombs/pi-better-toolsy) | Drop-in replacements for the built-in `ls`/`read`/`grep`/`find`/`edit`/`write` tools, with .gitignore awareness, path-traversal protection, and injection-safe edits. |
| [`@jmcombs/pi-blue-psl-10k`](./packages/blue-psl-10k) | [![npm](https://img.shields.io/npm/v/@jmcombs/pi-blue-psl-10k.svg)](https://www.npmjs.com/package/@jmcombs/pi-blue-psl-10k) | Powerline-styled status footer (Blue PSL 10K theme) — git, context usage, token counts, and cost on one line. |
| [`@jmcombs/pi-context7`](./packages/context7) | [![npm](https://img.shields.io/npm/v/@jmcombs/pi-context7.svg)](https://www.npmjs.com/package/@jmcombs/pi-context7) | Real-time, version-accurate library documentation via [Context7](https://context7.com). |
| [`@jmcombs/pi-grok-search`](./packages/grok-search) | [![npm](https://img.shields.io/npm/v/@jmcombs/pi-grok-search.svg)](https://www.npmjs.com/package/@jmcombs/pi-grok-search) | Real-time web search via the [xAI Grok](https://x.ai) API. |
| [`@jmcombs/pi-headroom`](./packages/headroom) | [![npm](https://img.shields.io/npm/v/@jmcombs/pi-headroom.svg)](https://www.npmjs.com/package/@jmcombs/pi-headroom) | Whole-conversation context compression via a local [Headroom](https://www.npmjs.com/package/headroom-ai) proxy, with graceful passthrough when it is unreachable. |
| [`@jmcombs/pi-notify`](./packages/notify) | [![npm](https://img.shields.io/npm/v/@jmcombs/pi-notify.svg)](https://www.npmjs.com/package/@jmcombs/pi-notify) | Terminal notifications (OSC 777/9/99) when Pi finishes a turn — Ghostty, iTerm2, WezTerm, Kitty, and more. No OS binaries. |
| [`@jmcombs/pi-prompt-enhancer`](./packages/prompt-enhancer) | [![npm](https://img.shields.io/npm/v/@jmcombs/pi-prompt-enhancer.svg)](https://www.npmjs.com/package/@jmcombs/pi-prompt-enhancer) | Codebase-aware prompt enhancer that rewrites rough prompts into precise ones with project tree, git context, and referenced file contents. |
| [`@jmcombs/pi-tavily-search`](./packages/tavily-search) | [![npm](https://img.shields.io/npm/v/@jmcombs/pi-tavily-search.svg)](https://www.npmjs.com/package/@jmcombs/pi-tavily-search) | Real-time web search via the [Tavily](https://tavily.com) API. |

## 1Password credential API

Extensions that need a user-provided secret resolve it through the shared
[`@jmcombs/pi-1password`](./packages/1password) credential API. Developer docs:

- [Integration guide](./docs/1p-credential-api/INTEGRATION.md) — add 1Password to your extension, step by step.
- [API reference](./docs/1p-credential-api/API.md) — the full credential-API surface.

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
└── …shared tooling (biome, vitest, husky, commitlint, secretlint)
```

## Requirements

- Node.js `>= 22.0.0` (CI tests on Node 22 and Node 24; the release pipeline runs on Node 24)
- npm 10+ (Node 24 ships npm 11+, required for npm Trusted Publishing)

## Quality Gate

Every PR runs the same `npm run check` gate:

```bash
npm run check
```

This runs lint, format check, type check, tests, version validation, and security checks
(`secretlint` + `npm audit --omit=dev`). All packages must pass.

## Branch Protection

The `main` branch is protected by a GitHub Repository Ruleset that requires PR review from
`@jmcombs`, all CI checks green on Node 22 and Node 24, Conventional Commits, and a linear
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
