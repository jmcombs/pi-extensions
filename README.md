<div align="center">
  <p>
    <a href="./packages/1password"><img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/1password/preview.png" width="72" height="72" alt="1password"></a>
    <a href="./packages/better-toolsy"><img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/better-toolsy/preview.png" width="72" height="72" alt="better-toolsy"></a>
    <a href="./packages/blue-psl-10k"><img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/blue-psl-10k/preview.png" width="72" height="72" alt="blue-psl-10k"></a>
    <a href="./packages/context7"><img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/context7/preview.png" width="72" height="72" alt="context7"></a>
    <a href="./packages/grok-search"><img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/grok-search/preview.png" width="72" height="72" alt="grok-search"></a>
    <a href="./packages/headroom"><img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/headroom/preview.png" width="72" height="72" alt="headroom"></a>
    <a href="./packages/notify"><img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/notify/preview.png" width="72" height="72" alt="notify"></a>
    <a href="./packages/prompt-enhancer"><img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/prompt-enhancer/preview.png" width="72" height="72" alt="prompt-enhancer"></a>
    <a href="./packages/relay"><img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/relay/preview.png" width="72" height="72" alt="relay"></a>
    <a href="./packages/steward"><img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/steward/preview.png" width="72" height="72" alt="steward"></a>
    <a href="./packages/tavily-search"><img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/tavily-search/preview.png" width="72" height="72" alt="tavily-search"></a>
  </p>

  <h1>pi-extensions</h1>

  <p><strong>High-quality extensions for the <a href="https://pi.dev">Pi coding agent</a></strong></p>

  <p>
    <a href="https://github.com/jmcombs/pi-extensions/stargazers"><img src="https://img.shields.io/github/stars/jmcombs/pi-extensions?style=social" alt="GitHub stars"></a>
    <a href="https://github.com/jmcombs/pi-extensions/issues"><img src="https://img.shields.io/github/issues/jmcombs/pi-extensions" alt="Open issues"></a>
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
    <a href="https://pi.dev/packages"><img src="https://img.shields.io/badge/pi.dev-packages-0A7EA4" alt="pi.dev packages"></a>
    <a href="https://github.com/sponsors/jmcombs"><img src="https://img.shields.io/badge/Sponsor-30363D?style=flat&logo=GitHub-Sponsors&logoColor=EA4AAA" alt="Sponsor"></a>
    <a href="https://ko-fi.com/jmcombs"><img src="https://img.shields.io/badge/Ko--fi-FF5E5B?style=flat&logo=ko-fi&logoColor=white" alt="Ko-fi"></a>
  </p>
</div>

Every package here is a Pi extension you can install individually from npm. Packages are tagged with the `pi-package` keyword so they appear in the [pi.dev gallery](https://pi.dev/packages).

They share the same bar: TypeScript, real smoke tests (no mocked external APIs), Conventional Commits, and a full quality gate on every PR. Secrets never reach the model — extensions that need credentials go through the shared [`@jmcombs/pi-1password`](./packages/1password) credential API.

## Quick start

```bash
# Install any package globally
pi install npm:@jmcombs/pi-tavily-search

# Or try one for a single session
pi -e npm:@jmcombs/pi-tavily-search
```

See the [Pi packages documentation](https://pi.dev/docs/packages) for git, local path, project-scoped install, and filtering options.

## Packages

### Credentials

| Package | Description |
| --- | --- |
| [`@jmcombs/pi-1password`](./packages/1password) [![npm](https://img.shields.io/npm/v/@jmcombs/pi-1password.svg)](https://www.npmjs.com/package/@jmcombs/pi-1password) | Transparent 1Password credential injection so bare `gh`, `aws`, and friends work inside Pi — tokens never reach the LLM. Shared credential API for other extensions. |

### Search & documentation

| Package | Description |
| --- | --- |
| [`@jmcombs/pi-context7`](./packages/context7) [![npm](https://img.shields.io/npm/v/@jmcombs/pi-context7.svg)](https://www.npmjs.com/package/@jmcombs/pi-context7) | Real-time, version-accurate library docs via [Context7](https://context7.com). |
| [`@jmcombs/pi-tavily-search`](./packages/tavily-search) [![npm](https://img.shields.io/npm/v/@jmcombs/pi-tavily-search.svg)](https://www.npmjs.com/package/@jmcombs/pi-tavily-search) | Real-time web search via the [Tavily](https://tavily.com) API. |
| [`@jmcombs/pi-grok-search`](./packages/grok-search) [![npm](https://img.shields.io/npm/v/@jmcombs/pi-grok-search.svg)](https://www.npmjs.com/package/@jmcombs/pi-grok-search) | Real-time web search via the [xAI Grok](https://x.ai) API. |

### Agent tooling

| Package | Description |
| --- | --- |
| [`@jmcombs/pi-better-toolsy`](./packages/better-toolsy) [![npm](https://img.shields.io/npm/v/@jmcombs/pi-better-toolsy.svg)](https://www.npmjs.com/package/@jmcombs/pi-better-toolsy) | Drop-in replacements for `ls` / `read` / `grep` / `find` / `edit` / `write` — `.gitignore` awareness, path-traversal protection, injection-safe edits. |
| [`@jmcombs/pi-prompt-enhancer`](./packages/prompt-enhancer) [![npm](https://img.shields.io/npm/v/@jmcombs/pi-prompt-enhancer.svg)](https://www.npmjs.com/package/@jmcombs/pi-prompt-enhancer) | Codebase-aware prompt rewriter — project tree, git context, and referenced files before the model sees your prompt. |
| [`@jmcombs/pi-notify`](./packages/notify) [![npm](https://img.shields.io/npm/v/@jmcombs/pi-notify.svg)](https://www.npmjs.com/package/@jmcombs/pi-notify) | Terminal notifications (OSC 777/9/99) when Pi finishes a turn. Ghostty, iTerm2, WezTerm, Kitty, and more — no OS binaries. |

### Context, models & UI

| Package | Description |
| --- | --- |
| [`@jmcombs/pi-headroom`](./packages/headroom) [![npm](https://img.shields.io/npm/v/@jmcombs/pi-headroom.svg)](https://www.npmjs.com/package/@jmcombs/pi-headroom) | Whole-conversation context compression via a local [Headroom](https://www.npmjs.com/package/headroom-ai) proxy, with graceful passthrough when unreachable. |
| [`@jmcombs/pi-relay`](./packages/relay) [![npm](https://img.shields.io/npm/v/@jmcombs/pi-relay.svg)](https://www.npmjs.com/package/@jmcombs/pi-relay) | Run any Pi subagent on an external coding agent (headless Claude / Grok) by setting its `model` — provider seam, no local model required. |
| [`@jmcombs/pi-steward`](./packages/steward) [![npm](https://img.shields.io/npm/v/@jmcombs/pi-steward.svg)](https://www.npmjs.com/package/@jmcombs/pi-steward) | The llama.cpp control panel for Pi — local browser dashboard for service control, resident models, host health, and streamed logs. |
| [`@jmcombs/pi-blue-psl-10k`](./packages/blue-psl-10k) [![npm](https://img.shields.io/npm/v/@jmcombs/pi-blue-psl-10k.svg)](https://www.npmjs.com/package/@jmcombs/pi-blue-psl-10k) | Powerline-styled status footer (Blue PSL 10K theme) — git, context usage, token counts, and cost. |

## 1Password credential API

Extensions that need a user-provided secret resolve it through the shared
[`@jmcombs/pi-1password`](./packages/1password) credential API. Developer docs:

- [Integration guide](./docs/1p-credential-api/INTEGRATION.md) — add 1Password to your extension, step by step
- [API reference](./docs/1p-credential-api/API.md) — the full credential-API surface

## Sponsor

If these extensions save you time, tokens, or friction — a sponsorship is the single best way to keep them maintained and expanding. Every dollar goes to maintenance, new extensions, and keeping the quality bar high.

<p>
  <a href="https://github.com/sponsors/jmcombs"><img src="https://img.shields.io/badge/Sponsor_on_GitHub-EA4AAA?style=for-the-badge&logo=GitHub-Sponsors&logoColor=white" alt="Sponsor on GitHub"></a>
  <a href="https://ko-fi.com/jmcombs"><img src="https://img.shields.io/badge/Tip_on_Ko--fi-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Tip on Ko-fi"></a>
</p>

- **[GitHub Sponsors](https://github.com/sponsors/jmcombs)** — one-time *and* monthly; **0%** platform fee on personal sponsorships; shows up natively on the repo
- **[Ko-fi](https://ko-fi.com/jmcombs)** — simple one-time tips if you prefer a tip jar outside GitHub

## Requirements

- **Node.js** `>= 22.19.0` (CI on Node 22 and Node 24; release pipeline on Node 24)
- **npm** 10+ (Node 24 ships npm 11+, required for npm Trusted Publishing)
- **Pi** — see each package README for the minimum Pi version it needs

## Repository layout

```
pi-extensions/
├── packages/
│   ├── _template/          # Scaffold for new extensions (see TEMPLATE.md)
│   └── <extension-name>/   # One directory per published package
├── assets/                 # Per-package preview art used in READMEs + the gallery
├── docs/                   # Shared developer docs (credential API, CI, …)
├── scripts/                # Version validation, typecheck, audits, …
├── .github/workflows/      # CI + Release Please
├── release-please-config.json
├── .release-please-manifest.json
└── …shared tooling (biome, vitest, husky, commitlint, secretlint)
```

## Quality gate

Every PR runs the same `npm run check` gate:

```bash
npm ci
npm run check
```

Lint + format, typecheck, tests, version validation, Dependabot-ignore hygiene, and security (`secretlint` + `npm audit --omit=dev`). All packages must pass.

See [docs/ci.md](./docs/ci.md) for every CI check and what a green does — and does not — prove.

## Branch protection

The `main` branch is protected by a GitHub Repository Ruleset that requires PR review from `@jmcombs`, all CI checks green on Node 22 and Node 24, Conventional Commits, and a linear history. The maintainer can push directly to `main` via the admin bypass; outside contributors must go through PR review. See [CONTRIBUTING.md → Branch Protection](CONTRIBUTING.md#branch-protection) for the full rule list and rationale.

## Contributing

1. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md).
2. To add a package: copy `packages/_template/` and follow [`TEMPLATE.md`](./TEMPLATE.md).
3. Open a PR. Release Please opens a per-package release PR after merge.

## Versioning & releases

Each package is versioned independently with semver. See [`VERSIONING.md`](./VERSIONING.md) for the full policy. Releases are automated via [Release Please](https://github.com/googleapis/release-please) and published to npm using [npm Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers).

## License

[MIT](./LICENSE) © [Jeremy Combs](https://github.com/jmcombs)
