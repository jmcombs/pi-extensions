# Pi Extensions Monorepo - Approved Plan

**Repository**: `jmcombs/pi-extensions` (public)  
**Local Path**: `~/Projects/pi-extensions`  
**Status**: Plan Approved – Execution Phase

---

## 1. Overview & Goals

We are building a public monorepo to host multiple Pi coding agent extensions (and related resources). The first extension is a Tavily web search tool.

Key principles:

- Follow Pi’s Node support model (`>=20.6.0`)
- Mirror the high-quality release, CI, and testing practices from `dynamix-claude` (minus work-specific author checks)
- Make it easy for both humans and AI agents to add new compliant extensions
- All extensions must pass consistent linting, formatting, testing, and security standards
- Published packages appear automatically on https://pi.dev/packages

---

## 2. Repository Structure

```
pi-extensions/
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── release-please.yml
├── .nvmrc
├── .npmrc
├── package.json                 # "private": false, "type": "module"
├── release-please-config.json
├── .release-please-manifest.json
├── scripts/
│   └── sync-versions.mjs
├── assets/
│   └── <extension-name>/
├── packages/
│   ├── _template/               # Scaffold for new extensions
│   ├── tavily-search/           # First extension (@jmcombs/pi-tavily-search)
│   └── prompt-enhancer/         # Second extension (@jmcombs/pi-prompt-enhancer)
├── README.md
├── CONTRIBUTING.md
├── VERSIONING.md
├── CLAUDE.md
└── config files (eslint, prettier, vitest, husky, commitlint, secretlint)
```

---

## 3. Root Configuration

### package.json (Root)

- `"private": false`
- `"type": "module"`
- `workspaces: ["packages/*"]`
- `engines: { "node": ">=20.6.0" }`
- Full set of shared scripts (lint, format, test, security, check, sync-versions, etc.)
- MIT license

### .nvmrc

`22` (latest LTS compatible with Pi)

### .npmrc (Recommended)

```
engine-strict=true
fund=false
package-lock=true
```

### Tooling (Ported from dynamix-claude, minus check-authors)

- ESLint + Prettier + shellcheck
- Vitest
- Husky + commitlint (conventional commits)
- Secretlint + `npm audit --omit=dev`
- `scripts/sync-versions.mjs` + version checks
- Full `npm run check` quality gate
- CI matrix on PRs (Node 20 + 22)

---

## 4. packages/\_template/ (New Extension Scaffold)

Purpose: Allow an AI agent or human to quickly create a new extension that automatically complies with all standards.

Contents:

- `package.json` template (with TODO comments for name, description, `pi` manifest, etc.)
- `index.ts` – minimal working extension skeleton (example `registerTool` + `registerCommand`, proper TypeBox usage)
- Minimal non-mocking smoke test (Vitest)
- `README.md` template (including auth storage guidance pattern)
- `assets/<placeholder>/` directory
- `TEMPLATE.md` with clear step-by-step instructions

---

## 5. First Extension: @jmcombs/pi-tavily-search

- Location: `packages/tavily-search/`
- Source: Copy contents from `~/.pi/agent/extensions/tavily-extension/`
- `package.json` updates:
  - Name: `@jmcombs/pi-tavily-search`
  - `keywords: ["pi-package"]`
  - `pi: { "extensions": ["./index.ts"] }`
  - Author: "Jeremy Combs"
  - License: MIT
  - `image` / `video` fields using raw GitHub URLs from `assets/tavily-search/`
- `README.md` states that an API key is required and to use Pi’s recommended auth storage methods
- Includes minimal meaningful non-mocking smoke test

---

## 6. Release Process (Release Please)

- `release-type: "node"` for each package (defaults otherwise)
- `separate-pull-requests: true`
- Post-release jobs automatically run `npm publish` using **npm Trusted Publishing (OIDC)**
- `.release-please-manifest.json` tracks versions
- `VERSIONING.md` explains independent semantic versioning per extension

---

## 7. CI

- PR-triggered quality gate (`npm run check`)
- Commit message validation
- Matrix testing on Node 20 and 22

---

## 8. Assets & pi.dev Gallery

- Root `assets/` directory with per-extension subfolders
- Use raw GitHub URLs in `package.json` for `image` and `video` fields
- This enables nice preview cards on https://pi.dev/packages

---

## 9. Testing Philosophy

- Only meaningful tests
- No mocking of external APIs
- No tests written purely for coverage
- Smoke tests that verify the extension loads and registers correctly are acceptable

---

## 10. Documentation

- Root `README.md`, `CONTRIBUTING.md`, `VERSIONING.md`
- Generic but professional tone

---

## 11. Next Steps (Execution Order)

1. Create folder and initialize git (done)
2. Create `PLAN.md` and `PROMPT.md`
3. Set up root configuration files and tooling
4. Create `packages/_template/`
5. Create `packages/tavily-search/` by copying the existing extension
6. Implement CI and Release Please workflows
7. Add initial commit and push to GitHub
8. Test local installation with `pi -e`
9. Publish first version (@jmcombs/pi-tavily-search)
10. Create `packages/prompt-enhancer/` using `packages/_template/` scaffold
11. Implement prompt-enhancer extension (see Section 12)
12. Test locally with `pi -e`
13. Publish second version (@jmcombs/pi-prompt-enhancer)

---

## 12. Second Extension: @jmcombs/pi-prompt-enhancer

- Location: `packages/prompt-enhancer/`
- Gathers live codebase context and rewrites rough prompts into precise,
  codebase-aware ones, loading the result back into the editor for review
  before submission

### Triggers

- `/enhance [text]` — enhance provided text, or current editor contents if no arg
- `Ctrl+Shift+E` — enhance current editor contents in place
- `/enhance-model` — interactive model picker to select the enhancer model for the session

### Model selection

- Default: `ctx.model` (currently active pi model in the session)
- `/enhance-model` opens a `ctx.ui.select()` list of all models with configured API
  keys; choice is stored in-memory for the session lifetime

### Context gathered (in parallel)

1. **Project directory tree** — up to 3 levels deep, max 100 entries, skipping
   `node_modules`, `.git`, `dist`, `build`, `coverage`, and similar artifact directories
2. **Git context** — current branch, `git status --short`, last 8 commits via
   `git log --oneline`; 3-second timeout per call; failures silently ignored
3. **Mentioned file contents** — filenames/paths referenced in the prompt are resolved
   relative to `cwd`, verified to exist, and read up to 100 lines each; capped at
   3 files maximum; unreadable files silently skipped

### Enhancement flow

1. Capture current editor text as `originalPrompt`
2. Validate: empty prompt, no model, or no API key → notify and return early
3. Show `BorderedLoader` — Esc cancels at any time
4. Context gathering and LLM call run inside the loader
5. On success: load enhanced prompt into editor → notify user to review before submitting
6. On cancel or error: restore `originalPrompt` → notify

### "Go back" / undo

- User presses **Ctrl+Z** in the editor to revert to `originalPrompt` (standard undo)
- **Implementation risk**: `setEditorText()` may not preserve the editor's undo stack.
  If Ctrl+Z does not reliably revert after `setEditorText()`, a `/enhance-revert`
  command will be added that stores `originalPrompt` in memory and restores it on demand.
  This will be confirmed during implementation before finalizing.

### package.json

- Name: `@jmcombs/pi-prompt-enhancer`
- `keywords: ["pi-package"]`
- `pi: { "extensions": ["./index.ts"] }`
- Author: "Jeremy Combs"
- License: MIT
- No external npm dependencies (pi runtime packages + Node.js built-ins only)
- `image` / `video` fields using raw GitHub URLs from `assets/prompt-enhancer/`

---

_This document is the single source of truth for the project._
