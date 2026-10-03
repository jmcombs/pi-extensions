# Pi 1.0.0 host alignment

This plan is the approved implementation sequence for Pi 1.0.0's impact on this monorepo: deprecate and remove `@jmcombs/pi-better-toolsy`, bump the earendil host pins to `^1.0.0`, move notify's completion OSC from `agent_end` to idle `agent_settled`, add search-tool annotations plus output schemas that mirror existing `details`, and declare the Blue PSL theme `appearance` as `light`. Fullscreen smoke on real Pi 1.0.0 is a human gate. Pi Durable and the skipped host features stay out of implementation.

## Authoritative sources

- `AGENTS.md` — quality gate `npm run check`, Conventional Commits, do not edit `.github/workflows/ci.yml` job names, release-please config/manifest only when adding or removing a package.
- `CONTRIBUTING.md` — expected-surface table (better-toolsy row; notify handlers include `agent_end`); the table must stay in sync with `docker/smoke-harness.mts`; no mocked external APIs.
- `VERSIONING.md` — observable event-subscription behavior is public API; a backwards-incompatible behavior change uses a `BREAKING CHANGE:` footer; `chore` does not cut a package release.
- `package.json` — workspaces `packages/*`; scripts `check`, `test`, `security:audit`; devDependencies `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` at `^0.99.1`.
- `packages/1password/package.json` — `peerDependencies` `"*"`; devDependency `@earendil-works/pi-coding-agent` `^0.99.1`; devDependency `@earendil-works/pi-tui` `*`.
- `.github/workflows/ci.yml` — required jobs run `npm ci` then `npm run check` (Quality Gate Node 22 and Node 24) and commitlint (Commit Messages).
- `.github/workflows/extension-load.yml` and `docker/interactive-onboarding.Dockerfile` — `@oh-my-pi/pi-coding-agent@17.0.5` (do not change).
- `docker/run-pi.sh` — real pi launch flags `--no-extensions`, `-e`, `--provider openai --model gpt-4o --api-key placeholder-not-used-for-onboarding`, `--no-session`.
- `docker/smoke-harness.mts` — `EXPECTED` exact-set surface, including `better-toolsy` and notify handlers ending in `agent_end`.
- `scripts/register-tool-parameters.test.ts` — imports `packages/better-toolsy/index.js` and expects tools `ls`, `read`, `grep`, `find`, `edit`, `write`.
- `scripts/sync-versions.mjs` — a manifest key whose package directory is gone fails `npm run check:versions`.
- `release-please-config.json` and `.release-please-manifest.json` — `packages/better-toolsy` at `1.2.2`.
- `README.md` — gallery anchor and Agent tooling row for `@jmcombs/pi-better-toolsy`; notify row says notifications when Pi finishes a turn.
- `packages/notify/index.ts`, `packages/notify/index.test.ts`, `packages/notify/README.md` — completion OSC on `agent_end`; `tool_execution_start` wait hook for `ask_user`.
- `packages/context7/index.ts`, `packages/tavily-search/index.ts`, `packages/grok-search/index.ts` — `registerTool` calls with no `annotations`, `outputSchema`, `structuredContent`, or `namespace`. Details shapes are the object literals in those files. Grok `source` is `CredentialSource` (`oauth` | `api_key`) from `packages/grok-search/auth.ts`.
- `packages/blue-psl-10k/themes/blue-psl-10k.json` — no `appearance` key. `packages/blue-psl-10k/package.json` ships `pi.themes` `./themes`.
- `packages/blue-psl-10k/index.ts` `setFooter`; `packages/prompt-enhancer/index.ts`, `packages/headroom/index.ts`, and `packages/steward/index.ts` `setWidget` `aboveEditor`.
- Installed `@earendil-works/pi-coding-agent@0.99.1` `dist/core/extensions/types.d.ts` (`ToolAnnotations`, `ToolNamespace`, `outputSchema`, `structuredContent`) and `dist/cli/args.js` (`--tui-mode` `regular` | `fullscreen`).
- Published `@earendil-works/pi-coding-agent@1.0.0` tarball: `CHANGELOG.md` default TUI mode fullscreen and `--tui-mode regular`; `package/dist/modes/interactive/theme/theme-schema.json` `appearance` enum `dark` | `light`.
- `npm view @earendil-works/pi-coding-agent version`, `pi-ai`, and `pi-tui` each printed `1.0.0`.
- `npm view @jmcombs/pi-better-toolsy versions --json` printed `0.0.0`, `1.0.0`, `1.0.1`, `1.1.0`, `1.1.1`, `1.1.2`, `1.1.3`, `1.2.0`, `1.2.1`, `1.2.2`.
- npm `lib/commands/deprecate.js`: a package spec with no version uses range `*`, which selects every published version. `npm unpublish` is not this command.

## How to use this document

The builder implements exactly one phase, proves every Testing Gate with real command output, opens a PR, and stops. It never ticks checkboxes and never merges.

A fresh verifier re-derives each gate from real output and returns PASS / CONDITIONAL PASS / FAIL / BLOCKED.

Max 3 build→verify rounds per phase; the 3rd FAIL escalates to the human.

Checkboxes are ticked by the verifier only. Merges are human-gated.

TODO file paths are literal specs — build exactly what they say, where they say.

Deviations during BUILD: stop and escalate to the human.

Tests may inject fixture names. Fixture values are not production freezes.

Revising only this file is not a phase. Nothing is merged or ticked for a plan-only revision.

## Environment capabilities

| Capability | Available here? | Note |
| --- | --- | --- |
| repo-check | local | `npm run check` and `npx vitest run` from the repo root. Node `>=22.19.0`. `.nvmrc` is `24`. CI runs the same check after `npm ci`. |
| npm-owner | human | `npm deprecate` writes the registry as the package owner and may prompt for OTP. This environment must not run it. |
| pi-fullscreen | human | Interactive TUI. Homebrew `pi` here is `0.99.2`. After Phase 2, use `node_modules/.bin/pi` (the `^1.0.0` pin). Footer, widgets, onboarding, and OSC cannot be proven by a non-interactive command. |
| github-pr | human | `gh auth status` in this environment reports not logged in. Opening the PR, `Closes #<n>`, and the three required checks are confirmed by a person with GitHub access. |

## Git & PR conventions

Follow git-hygiene. One branch per phase, never the default branch `main`. Branch name matches `^(feat|fix|chore|docs|refactor)/[a-z0-9-]+$`. Commit type equals the branch prefix. Subject matches `^(feat|fix|chore|docs|refactor)(\([a-z0-9-]+\))?: .+` and is at most 100 characters (`commitlint.config.js`). No WIP or fixup commits. PR body contains `Closes #<n>` or `Fixes #<n>` against a GitHub issue on `jmcombs/pi-extensions`; open the issue first; do not invent the number. One PR per phase. Required checks before a human merge: `Quality Gate (Node 22)`, `Quality Gate (Node 24)`, and `Commit Messages`. Checkboxes are verifier-ticked. Do not push to `main`. Do not edit `.github/CODEOWNERS` or `.github/workflows/ci.yml`.

## Summary

Phase summary of the approved sequence. Entry is the phase that must already be merged, or `—`.

| Phase | Scope | Entry | Branch type |
| --- | --- | --- | --- |
| 1 | Deprecate and remove `@jmcombs/pi-better-toolsy` | — | `chore/remove-better-toolsy` |
| 2 | Bump earendil host pins to `^1.0.0` | 1 | `chore/bump-pi-host-pins` |
| 3 | Notify completion OSC on `agent_settled` only | 2 | `fix/notify-idle-osc` |
| 4 | Search-tool annotations and mirrored output schemas | 3 | `feat/search-tool-annotations` |
| 5 | Blue PSL theme `appearance: light` | 4 | `feat/blue-psl-appearance` |

## Phase 1 — Deprecate and remove better-toolsy

**Entry:** —  
**Shippable as:** one PR from `chore/remove-better-toolsy`. Commit subject `chore: remove deprecated better-toolsy from the monorepo`.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

Deprecate every published version of `@jmcombs/pi-better-toolsy`, then remove the package from the monorepo and from the release-please registration, gallery, expected-surface table, load harness, and parameter-schema test. Regenerate `package-lock.json` so `npm ci` no longer expects the workspace.

**Out:** npm unpublish; a gh-quoting successor package; retiring or editing 1password, notify, headroom, prompt-enhancer, relay, steward, blue-psl-10k, context7, tavily-search, or grok-search; Pi Durable (`@earendil-works/pi-durable`, a dual ExtensionAPI, or Durable ports) — watch-only; `registerVirtualModel` as a relay replacement; `generateImages`; Pi `classify()`; headroom `context_with_system`; MCP OAuth; changing `@oh-my-pi/pi-coding-agent@17.0.5`; changing published `peerDependencies` from `*`; changing earendil pins (Phase 2); editing `scripts/check-audit.mjs`.

### Architectural Constraints

- Deprecate with `npm deprecate @jmcombs/pi-better-toolsy "Pi 0.99+ built-ins already cover gitignore/literal edit/mkdir and this override drops image read"`. The bare spec is range `*`, so this covers every published version, including `0.0.0`.
- Do not merge the removal PR until that registry write is done. Never `npm unpublish`. Never pass an empty deprecate message (that undeprecates).
- Do not add a replacement package. Do not keep a `gh` body-quoting tool.
- `scripts/sync-versions.mjs` fails if `.release-please-manifest.json` still names a missing directory. Delete the directory and both release-please entries in the same change.
- CI installs with `npm ci` (`.github/workflows/ci.yml`). `package-lock.json` must drop the workspace. Do not hand-edit the lockfile.
- Published `peerDependencies` stay `*`. Do not change oh-my-pi `17.0.5` pins.

### Actionable TODOs

- [x] `packages/better-toolsy/` must not exist. Delete `index.ts`, `index.test.ts`, `package.json`, `tsconfig.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, and the directory.
- [x] `assets/better-toolsy/` must not exist. Delete `preview.png` and the directory.
- [x] `README.md` must not contain `better-toolsy` or `@jmcombs/pi-better-toolsy`. Remove the gallery anchor for `./packages/better-toolsy` and the Agent tooling row for `@jmcombs/pi-better-toolsy`. Leave every other gallery anchor and package row.
- [x] `CONTRIBUTING.md` expected-surface table must not contain a `better-toolsy` row. Do not edit the `notify` row in this phase.
- [x] `docker/smoke-harness.mts` must not contain `better-toolsy`. Delete the `EXPECTED` entry whose key is `better-toolsy` and the matching comment-table row. Leave `EXPECTED.notify.handlers` unchanged in this phase.
- [x] `scripts/register-tool-parameters.test.ts` must not import `../packages/better-toolsy/index.js` and must not include a cases entry with `dir: "better-toolsy"`. Keep the other cases, including the `1password` test.
- [x] `release-please-config.json` must not contain a `packages/better-toolsy` key. Leave the other package entries.
- [x] `.release-please-manifest.json` must not contain a `packages/better-toolsy` key. Leave the other version keys.
- [x] `package-lock.json` must be the file `npm install` writes from the repo root after the deletions, and it must not contain `better-toolsy`. Do not change the earendil version ranges in `package.json` in this phase.

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| Package directories gone | `test ! -e packages/better-toolsy && test ! -e assets/better-toolsy && echo dirs-gone` | `dirs-gone` |
| Removal strings gone from the listed files | `if grep -n better-toolsy package-lock.json README.md CONTRIBUTING.md docker/smoke-harness.mts scripts/register-tool-parameters.test.ts release-please-config.json .release-please-manifest.json; then exit 1; else echo removed; fi` | `removed` |
| Harness no longer expects the package | `npx tsx -e 'import { EXPECTED } from "./docker/smoke-harness.mts"; if (EXPECTED["better-toolsy"]) { console.error("present"); process.exit(1); } console.log("absent");'` | `absent` |
| Kept packages still present | `test -d packages/1password && test -d packages/notify && test -d packages/headroom && test -d packages/prompt-enhancer && test -d packages/relay && test -d packages/steward && test -d packages/blue-psl-10k && test -d packages/context7 && test -d packages/tavily-search && test -d packages/grok-search && echo kept` | `kept` |
| Quality gate | `npm run check` | exit 0 |
| Branch and commit type | `b=$(git branch --show-current); t=$(git log -1 --pretty=%s); echo "$b"; echo "$t"; test "$b" = chore/remove-better-toolsy && case "$t" in chore:*) ;; *) exit 1;; esac` | stdout contains `chore/remove-better-toolsy` and a `chore:` subject; exit 0 |
| Commitlint | `npx commitlint --from main --to HEAD` | exit 0 |
| All published versions deprecated and still installable (needs: npm-owner) | `for v in 0.0.0 1.0.0 1.0.1 1.1.0 1.1.1 1.1.2 1.1.3 1.2.0 1.2.1 1.2.2; do printf '%s ' "$v"; npm view "@jmcombs/pi-better-toolsy@$v" version; npm view "@jmcombs/pi-better-toolsy@$v" deprecated; done` | Each version still prints itself, then the exact line `Pi 0.99+ built-ins already cover gitignore/literal edit/mkdir and this override drops image read`. No version is missing. |
| PR linked and required checks green (needs: github-pr) | `gh pr view --json body,statusCheckRollup -q .body` and `gh pr checks` | Body matches `Closes #<n> or Fixes #<n>`. `Quality Gate (Node 22)`, `Quality Gate (Node 24)`, and `Commit Messages` pass. |

## Phase 2 — Bump earendil host pins

**Entry:** Phase 1 merged.  
**Shippable as:** one PR from `chore/bump-pi-host-pins`. Commit subject `chore: bump earendil host pins to ^1.0.0`. Use `chore` so Release Please does not cut a package release for a devDependency pin.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

Install Pi 1.0.0 in this repo by moving the root earendil devDependency ranges and the 1password coding-agent devDependency to `^1.0.0`, and refresh the lockfile. After that pin is installed, a person smokes footer, widgets, onboarding, and OSC in default fullscreen and in `--tui-mode regular`. If `npm run check` fails after the bump, stop and escalate to the human. Do not edit `scripts/check-audit.mjs`.

**Out:** editing `scripts/check-audit.mjs` (exceptions allowlist: GHSA ids, reasons, expires dates, EXCEPTIONS_EXPIRE); changing published `peerDependencies` from `*`; changing `packages/1password/package.json` devDependency `@earendil-works/pi-tui` (it stays `*`); changing `@oh-my-pi/pi-coding-agent@17.0.5` in `.github/workflows/extension-load.yml` or `docker/interactive-onboarding.Dockerfile`; Pi Durable; `registerVirtualModel`; `generateImages`; Pi `classify()`; headroom `context_with_system`; MCP OAuth; notify, search-tool, or theme edits (later phases); a gh-quoting successor; npm unpublish.

### Architectural Constraints

- Root `package.json` `devDependencies` `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` are each `^1.0.0`.
- `packages/1password/package.json` devDependency `@earendil-works/pi-coding-agent` is `^1.0.0`. Its `peerDependencies` stay `*`. Its devDependency `@earendil-works/pi-tui` stays `*`.
- Every other package's published `peerDependencies` for `@earendil-works/*` stay `*`.
- Do not change oh-my-pi `17.0.5` pins as part of this bump.
- If `npm run check` fails after the pin bump, stop and escalate to the human. Do not edit `scripts/check-audit.mjs`.
- Fullscreen default is Pi 1.0.0 (`CHANGELOG.md` in the 1.0.0 tarball). The human smoke uses `node_modules/.bin/pi`, not Homebrew `0.99.2`.

### Actionable TODOs

- [x] `package.json` `devDependencies` must set `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` to `^1.0.0`. Do not change `scripts`, `engines`, or other dependency ranges in this file.
- [x] `packages/1password/package.json` `devDependencies["@earendil-works/pi-coding-agent"]` must be `^1.0.0`. `peerDependencies["@earendil-works/pi-coding-agent"]` and `peerDependencies["@earendil-works/pi-tui"]` must remain `*`. `devDependencies["@earendil-works/pi-tui"]` must remain `*`.
- [x] `package-lock.json` must be the file `npm install` writes after those range edits. The lockfile entries `node_modules/@earendil-works/pi-ai`, `node_modules/@earendil-works/pi-coding-agent`, and `node_modules/@earendil-works/pi-tui` must each resolve to a `1.0.x` version. Do not hand-edit versions.

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| Root ranges are `^1.0.0` | `node -e 'const d=require("./package.json").devDependencies; for (const k of ["@earendil-works/pi-ai","@earendil-works/pi-coding-agent","@earendil-works/pi-tui"]) { if (d[k]!=="^1.0.0") { console.error(k,d[k]); process.exit(1);} } console.log("pins-ok");'` | `pins-ok` |
| 1password coding-agent dev pin | `node -e 'const p=require("./packages/1password/package.json"); if (p.devDependencies["@earendil-works/pi-coding-agent"]!=="^1.0.0") process.exit(1); if (p.peerDependencies["@earendil-works/pi-coding-agent"]!=="*") process.exit(1); if (p.devDependencies["@earendil-works/pi-tui"]!=="*") process.exit(1); console.log(p.devDependencies["@earendil-works/pi-coding-agent"]);'` | `^1.0.0` |
| Lockfile resolves 1.0.x | `node -e 'const pkgs=require("./package-lock.json").packages; for (const name of ["node_modules/@earendil-works/pi-ai","node_modules/@earendil-works/pi-coding-agent","node_modules/@earendil-works/pi-tui"]) { const v=pkgs[name].version; if (!/^1\.0\.\d+$/.test(v)) { console.error(name,v); process.exit(1);} console.log(name,v); }'` | Three lines, each version matching `1.0.<digits>`, exit 0 |
| oh-my-pi pin unchanged | `grep -n @oh-my-pi/pi-coding-agent@17.0.5 .github/workflows/extension-load.yml docker/interactive-onboarding.Dockerfile` | One matching line in each file, exit 0 |
| Earendil peers stay `*` | `node -e 'const fs=require("fs"); const path=require("path"); for (const d of fs.readdirSync("packages")) { const pj=path.join("packages",d,"package.json"); if (!fs.existsSync(pj)) continue; const peers=JSON.parse(fs.readFileSync(pj,"utf8")).peerDependencies ?? {}; for (const [k,v] of Object.entries(peers)) { if (k.startsWith("@earendil-works/") && v!=="*") { console.error(d,k,v); process.exit(1);} } } console.log("peers-ok");'` | `peers-ok` |
| Workspace pi binary is 1.0.x | `node_modules/.bin/pi --version` | A version line matching `1.0.`, exit 0. Not `0.99`. |
| Quality gate | `npm run check` | exit 0 |
| Branch and commit type | `b=$(git branch --show-current); t=$(git log -1 --pretty=%s); echo "$b"; echo "$t"; test "$b" = chore/bump-pi-host-pins` | stdout contains `chore/bump-pi-host-pins` and a `chore:` subject; exit 0 |
| Commitlint | `npx commitlint --from main --to HEAD` | exit 0 |
| Fullscreen smoke after the pin bump (needs: pi-fullscreen) | `PI_OFFLINE=1 PI_CODING_AGENT_DIR=/tmp/pi-ext-fullscreen-smoke node_modules/.bin/pi --no-extensions -e ./packages/blue-psl-10k/index.ts -e ./packages/prompt-enhancer/index.ts -e ./packages/headroom/index.ts -e ./packages/steward/index.ts -e ./packages/1password/index.ts -e ./packages/grok-search/index.ts -e ./packages/context7/index.ts -e ./packages/notify/index.ts --provider openai --model gpt-4o --api-key placeholder-not-used-for-onboarding --no-session` and the same command with `--tui-mode regular` added | Human confirms, in default fullscreen (no `--tui-mode`) and again with `--tui-mode regular`: blue-psl footer renders; above-editor widgets from prompt-enhancer, headroom, and steward do not crash; `/context7_setup`, `/headroom_setup`, `/1password_setup`, and `/grok_setup` open; `/notify` either emits OSC or shows the extension's unsupported-terminal TUI message. `node_modules/.bin/pi --version` is 1.0.x. |
| PR linked and required checks green (needs: github-pr) | `gh pr view --json body -q .body` and `gh pr checks` | Body matches `Closes #<n> or Fixes #<n>`. The three required checks pass. |

## Phase 3 — Notify on idle

**Entry:** Phase 2 merged.  
**Shippable as:** one PR from `fix/notify-idle-osc`. Subject `fix(notify): send completion OSC on agent_settled`. Footer must contain `BREAKING CHANGE: completion notifications fire on agent_settled, not on each agent_end.`

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

Move the completion OSC from `agent_end` to `agent_settled`. Keep the `tool_execution_start` wait-tool hook for `ask_user`. Update the exact event set in the notify tests and the load harness, and the docs that describe that set.

**Out:** per-run `agent_end` pings; removing `agent_start`, `turn_end`, or `tool_execution_end`; removing the `agent_start` stats reset; feature-detecting `agent_settled` for oh-my-pi; changing oh-my-pi `17.0.5`; Pi Durable; `registerVirtualModel`; `generateImages`; Pi `classify()`; headroom `context_with_system`; MCP OAuth; search-tool annotations; theme `appearance`; a gh-quoting successor; npm unpublish; retiring notify or any other kept package; editing `scripts/check-audit.mjs`.

### Architectural Constraints

- Completion notification is one `pi.on("agent_settled", ...)` listener that calls the existing `sendNotification` / `formatAgentEndMessage` path. There is no `pi.on("agent_end"` listener.
- Keep `tool_execution_start` for the wait-tool set (`ask_user` by default, `PI_NOTIFY_WAIT_TOOLS` override). That hook still notifies while the agent is blocked, because neither `agent_end` nor `agent_settled` fires while `ask_user` is open.
- Do not also ping on `agent_end`. Do not remove the `agent_start` reset of run stats.
- `docker/smoke-harness.mts` notify handlers are an exact set. `CONTRIBUTING.md` must match that set.
- `VERSIONING.md` treats event-subscription behavior as public API. This drop of per-run pings is backwards-incompatible, so the commit footer includes `BREAKING CHANGE:`.
- Do not mock a terminal or an external API. Tests keep the existing stdout spy for OSC bytes.

### Actionable TODOs

- [x] `packages/notify/index.ts` must subscribe to `agent_settled` for the completion OSC and must not call `pi.on("agent_end"`. The header comment must say the completion notification is idle `agent_settled`, not each `agent_end`. Keep `agent_start`, `turn_end`, `tool_execution_start`, `tool_execution_end`, the wait-tool hook, and `formatAgentEndMessage`.
- [x] `packages/notify/index.test.ts` must expect the subscribed events to equal `agent_start`, `turn_end`, `tool_execution_start`, `tool_execution_end`, `agent_settled`, and must not expect or invoke `agent_end`. The completed-run test must call `handlers.get("agent_settled")` and still expect the OSC payload to contain `Done —`, `1 turn`, and `1 tool call`. The `ask_user` `tool_execution_start` test must still expect `Waiting for your input`.
- [x] `packages/notify/README.md` must document the completion hook as `agent_settled` (one notification when Pi is idle), not a ping each time `agent_end` fires. The wait-tool section must still document `tool_execution_start` and `ask_user`. The `PI_NOTIFY_WAIT_TOOLS=` comment must not say `agent_end only`.
- [x] `docker/smoke-harness.mts` `EXPECTED.notify.handlers` must equal `["agent_start", "turn_end", "tool_execution_start", "tool_execution_end", "agent_settled"]`. The notify comment-table row must list that same set and must not list `agent_end`.
- [x] `CONTRIBUTING.md` notify expected-surface row must list handlers `agent_start`, `turn_end`, `tool_execution_start`, `tool_execution_end`, `agent_settled` and must not list `agent_end`.
- [x] `README.md` notify package-row description must say the OSC notification is when Pi is idle, not when Pi finishes a turn.

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| No `agent_end` listener | `if grep -n 'pi.on("agent_end"' packages/notify/index.ts; then exit 1; else echo no-agent-end-listener; fi` | `no-agent-end-listener` |
| Idle listener present | `grep -n 'pi.on("agent_settled"' packages/notify/index.ts` | One matching line, exit 0 |
| Harness exact event set | `npx tsx -e 'import { EXPECTED } from "./docker/smoke-harness.mts"; const h = EXPECTED.notify.handlers; const want = ["agent_start","turn_end","tool_execution_start","tool_execution_end","agent_settled"]; if (Array.isArray(h) && JSON.stringify(h) === JSON.stringify(want)) { console.log(h.join(",")); } else { console.error(JSON.stringify(h)); process.exit(1); }'` | `agent_start,turn_end,tool_execution_start,tool_execution_end,agent_settled` |
| Notify tests | `npx vitest run packages/notify/index.test.ts` | exit 0 |
| Quality gate | `npm run check` | exit 0 |
| Branch and breaking footer | `b=$(git branch --show-current); echo "$b"; git log -1 --pretty=%B` | `fix/notify-idle-osc`, a `fix(notify):` subject, and a footer line `BREAKING CHANGE: completion notifications fire on agent_settled, not on each agent_end.` |
| Commitlint | `npx commitlint --from main --to HEAD` | exit 0 |
| PR linked and required checks green (needs: github-pr) | `gh pr view --json body -q .body` and `gh pr checks` | Body matches `Closes #<n> or Fixes #<n>`. The three required checks pass. |

## Phase 4 — Search-tool annotations and mirrored output

**Entry:** Phase 3 merged.  
**Shippable as:** one PR from `feat/search-tool-annotations`. One commit, subject `feat: add search-tool annotations and mirrored output schemas`, touching `packages/context7`, `packages/tavily-search`, and `packages/grok-search`.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

On `context7_search`, `context7_get_docs`, `tavily_search`, and `grok_search`, set annotations and an `outputSchema` that is a per-tool union of the details objects those tools already return. Beside each existing `details: {` write a matching `structuredContent: {` object literal with the same keys. Do not hoist that object into a helper or a shared binding. context7 tools share a namespace.

**Out:** hoisting `structuredContent` into a helper or shared binding; a new public payload (no added or dropped details keys); `isError` on these returns; `idempotentHint`; changing `exposure`; namespace `description` or `instructions`; annotations on `headroom_retrieve` or `1p_diagnose`; live calls to Context7, Tavily, or xAI in tests; Pi Durable; `registerVirtualModel`; `generateImages`; Pi `classify()`; headroom `context_with_system`; MCP OAuth; oh-my-pi pin changes; a gh-quoting successor; npm unpublish; retiring any kept package; editing `scripts/check-audit.mjs`.

### Architectural Constraints

- Each of the four tools sets `annotations` to exactly `{ readOnlyHint: true, destructiveHint: false, openWorldHint: true }`.
- `outputSchema` is a TypeBox `Type.Union` of the key-sets below. `raw` is `Type.Unknown()` because the existing field is the `JsonValue` already assigned after `isJsonValue`. Do not use TypeScript `any` or `Type.Any()`. Do not add keys that are not already returned.
- Beside each existing `details: {`, including both returns inside `missingCredentialResult` and that function's return type in `packages/grok-search/index.ts`, write a matching `structuredContent: {` with the same keys. Do not hoist those objects into a helper or a shared binding. Do not reshape the keys.
- context7: both `pi.registerTool` calls set `namespace` to `{ name: "context7" }` and omit `description` and `instructions`. tavily and grok do not set `namespace`.
- Tests stay registration-surface tests. Do not mock `fetch` or the credential APIs.

Union members, one `Type.Object` per key-set:

- `context7_search`: `{ error: string }`, `{ status: number }`, `{ status: number, body: string }`, `{ libraryName: string, raw: JsonValue }`.
- `context7_get_docs`: `{ error: string }`, `{ status: number }`, `{ status: number, body: string }`, `{ libraryId: string, query: string, raw: JsonValue }`.
- `tavily_search`: `{ error: string }`, `{ status: number, body: string }`, `{ raw: JsonValue }`.
- `grok_search`: `{ error: string }`, `{ status: number, source: "oauth" or "api_key" }`, `{ status: number, body: string, source: "oauth" or "api_key" }`, `{ error: string, source: "oauth" or "api_key" }`, `{ raw: JsonValue, source: "oauth" or "api_key" }`. `source` uses `Type.Union([Type.Literal("oauth"), Type.Literal("api_key")])`.

### Actionable TODOs

- [x] `packages/context7/index.ts` must set the annotations above and `namespace: { name: "context7" }` on both `context7_search` and `context7_get_docs`, set each tool's `outputSchema` to the union listed for that tool, and write a matching `structuredContent: {` object literal beside each of the 15 `details: {` sites. Do not hoist.
- [x] `packages/tavily-search/index.ts` must set the annotations above on `tavily_search`, set `outputSchema` to that tool's union, write a matching `structuredContent: {` object literal beside each of the 5 `details: {` sites, do not hoist, and must not set `namespace`.
- [x] `packages/grok-search/index.ts` must set the annotations above on `grok_search`, set `outputSchema` to that tool's union, and write a matching `structuredContent: {` beside every `details: {`, including the `missingCredentialResult` return type and both of its returned objects (9 `details: {` sites today, including that type). Do not hoist. It must not set `namespace` and must not set `isError`.
- [x] `packages/context7/index.test.ts` must record the registered tool objects and assert both tools have the exact annotations, `namespace.name === "context7"`, and an `outputSchema`. The test title must be `context7 tools are read-only open-world and share namespace context7`. Do not call the Context7 API.
- [x] `packages/tavily-search/index.test.ts` must record `annotations` and `outputSchema` for `tavily_search` and assert the exact annotations and that `namespace` is absent. The test title must be `tavily_search is read-only open-world and mirrors details in outputSchema`. Do not call the Tavily API.
- [x] `packages/grok-search/index.test.ts` must record the registered tool and assert the exact annotations, an `outputSchema`, and that `namespace` is absent. The test title must be `grok_search is read-only open-world and mirrors details in outputSchema`. Do not call the xAI API.

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| `structuredContent` count matches existing `details` sites | `python3 -c 'import re,pathlib,sys; pairs=[("packages/context7/index.ts",15),("packages/tavily-search/index.ts",5),("packages/grok-search/index.ts",9)]; results=[(f,len(re.findall(r"\bdetails:\s*\{",pathlib.Path(f).read_text())),len(re.findall(r"\bstructuredContent:\s*\{",pathlib.Path(f).read_text())),n) for f,n in pairs]; [print("%s details=%d structuredContent=%d"%(f,d,s)) for f,d,s,n in results]; sys.exit(0 if all(d==n and s==d for f,d,s,n in results) else 1)'` | `packages/context7/index.ts details=15 structuredContent=15`, `packages/tavily-search/index.ts details=5 structuredContent=5`, `packages/grok-search/index.ts details=9 structuredContent=9`, exit 0 |
| No hoisted structuredContent binding | `if grep -nE 'structuredContent:\s*[A-Za-z_]' packages/context7/index.ts packages/tavily-search/index.ts packages/grok-search/index.ts; then exit 1; else echo no-hoist; fi` | `no-hoist` |
| Registration tests | `npx vitest run packages/context7/index.test.ts packages/tavily-search/index.test.ts packages/grok-search/index.test.ts --reporter=verbose` | exit 0, and stdout contains `context7 tools are read-only open-world and share namespace context7`, `tavily_search is read-only open-world and mirrors details in outputSchema`, and `grok_search is read-only open-world and mirrors details in outputSchema` |
| Quality gate | `npm run check` | exit 0 |
| Branch and commit type | `b=$(git branch --show-current); echo "$b"; git log -1 --pretty=%s` | `feat/search-tool-annotations` and a `feat:` subject, exit 0 |
| Commitlint | `npx commitlint --from main --to HEAD` | exit 0 |
| PR linked and required checks green (needs: github-pr) | `gh pr view --json body -q .body` and `gh pr checks` | Body matches `Closes #<n> or Fixes #<n>`. The three required checks pass. |

## Phase 5 — Declare Blue PSL appearance light

**Entry:** Phase 4 merged.  
**Shippable as:** one PR from `feat/blue-psl-appearance`. Commit subject `feat(blue-psl-10k): declare theme appearance light`.

**Skills:** phase-build, testing-standards, git-hygiene, repo-layout, typescript-standards

### Objectives & Scope

Add `"appearance": "light"` to the Blue PSL theme file and assert it in the existing package test. Re-run the fullscreen smoke so footer, widgets, onboarding, and the idle OSC path are seen together on Pi 1.0.0.

**Out:** changing any other theme key (`$schema`, `name`, `vars`, `colors`, `export`); Pi Durable; `registerVirtualModel`; `generateImages`; Pi `classify()`; headroom `context_with_system`; MCP OAuth; oh-my-pi pin changes; search-tool payload changes; a gh-quoting successor; npm unpublish; retiring any kept package; editing `scripts/check-audit.mjs`.

### Architectural Constraints

- The only theme edit is `"appearance": "light"` next to `"name": "blue-psl-10k"`. The 1.0.0 theme schema enum is `dark` | `light`.
- Do not change footer rendering code in `packages/blue-psl-10k/index.ts` unless `npm run check` fails for a reason that is this JSON field. If it fails for another reason, stop and escalate.
- The human smoke uses `node_modules/.bin/pi` at 1.0.x, default fullscreen, then `--tui-mode regular`.

### Actionable TODOs

- [ ] `packages/blue-psl-10k/themes/blue-psl-10k.json` must contain `"appearance": "light"` as a sibling of `"name"`. Every other key must be unchanged.
- [ ] `packages/blue-psl-10k/index.test.ts` must read `themes/blue-psl-10k.json` and expect `appearance` to be `light`. Keep the existing `setFooter` smoke test.

### Testing Gates

| Criterion | Command | Expected |
| --- | --- | --- |
| Theme appearance | `node -e 'const t=require("./packages/blue-psl-10k/themes/blue-psl-10k.json"); if (t.appearance!=="light") process.exit(1); console.log(t.appearance);'` | `light` |
| Package tests | `npx vitest run packages/blue-psl-10k/index.test.ts` | exit 0 |
| Quality gate | `npm run check` | exit 0 |
| Branch and commit type | `b=$(git branch --show-current); echo "$b"; git log -1 --pretty=%s` | `feat/blue-psl-appearance` and a `feat(blue-psl-10k):` subject, exit 0 |
| Commitlint | `npx commitlint --from main --to HEAD` | exit 0 |
| Fullscreen smoke after notify and theme (needs: pi-fullscreen) | Same two `node_modules/.bin/pi` commands as Phase 2 (default fullscreen, then `--tui-mode regular`), loading the same `-e` paths | Human confirms the Phase 2 checklist again, and that `/notify` still reaches a terminal (OSC or the unsupported-terminal TUI message) without a per-run `agent_end` requirement. `node_modules/.bin/pi --version` is 1.0.x. |
| PR linked and required checks green (needs: github-pr) | `gh pr view --json body -q .body` and `gh pr checks` | Body matches `Closes #<n> or Fixes #<n>`. The three required checks pass. |

## Appendix A — Asset/source map

| Phase | Source | Repo destination |
| --- | --- | --- |
| 1 | Published `@jmcombs/pi-better-toolsy` versions `0.0.0` through `1.2.2` | Registry deprecation message only. No successor package. |
| 1 | `packages/better-toolsy/` and `assets/better-toolsy/` | Deleted |
| 1 | Gallery and expected-surface mentions | Removed from `README.md`, `CONTRIBUTING.md`, `docker/smoke-harness.mts`, `scripts/register-tool-parameters.test.ts` |
| 1 | Release Please registration | `packages/better-toolsy` key removed from `release-please-config.json` and `.release-please-manifest.json` |
| 1 | Workspace lock | `package-lock.json` regenerated without `better-toolsy` |
| 2 | Root and 1password host pins `^0.99.1` | `package.json` and `packages/1password/package.json` devDependency ranges `^1.0.0`; `package-lock.json` resolved `1.0.x` |
| 2 | Pi 1.0.0 fullscreen default and `--tui-mode regular` | Human smoke only. No new repo file. |
| 3 | `packages/notify/index.ts` `agent_end` listener | `agent_settled` listener in the same file |
| 3 | Exact event set | `packages/notify/index.test.ts`, `docker/smoke-harness.mts` `EXPECTED.notify.handlers`, `CONTRIBUTING.md` notify row, `packages/notify/README.md`, `README.md` notify row |
| 4 | Details object literals in `packages/context7/index.ts`, `packages/tavily-search/index.ts`, `packages/grok-search/index.ts` | `annotations`, `outputSchema`, and a matching `structuredContent: {` object literal beside each existing `details: {` (not hoisted) in those files; context7 `namespace.name` `context7`; assertions in each package's `index.test.ts` |
| 5 | Missing `appearance` on the Catppuccin Latte palette | `"appearance": "light"` in `packages/blue-psl-10k/themes/blue-psl-10k.json`; assertion in `packages/blue-psl-10k/index.test.ts` |

## Appendix C — Master TODO index

Verifier-ticked. One line per phase.

- [x] Phase 1 — Deprecate and remove better-toolsy
- [x] Phase 2 — Bump earendil host pins
- [x] Phase 3 — Notify on idle
- [x] Phase 4 — Search-tool annotations and mirrored output
- [ ] Phase 5 — Declare Blue PSL appearance light

## Appendix D — Definition of Done

- git-hygiene: branch prefix matches commit type, not `main`, no WIP or fixup commits, PR body contains `Closes #<n>` or `Fixes #<n>`.
- `npm run check` exits 0 on the phase branch.
- Full-repo regression is that same `npm run check` (lint, typecheck, vitest, version validation, biome config, dependabot ignore check, secretlint, audit).
- Every Testing Gate is re-run with real output, or marked HUMAN-VERIFY when the criterion says `needs:` a `human` capability.
- Every literal TODO path exists or, where the TODO says it must not exist, is absent.
- A PR is opened and the three required checks are green. Merge is human-gated.
- Checkboxes are ticked by the verifier only.

## Appendix E — Deferred-gate ledger

| Gate | Deferred at | Needs | Discharge by | Status |
| --- | --- | --- | --- | --- |
| All published versions deprecated and still installable | Phase 1 | npm-owner | human | OPEN |
| PR linked and required checks green | Phase 1 | github-pr | human | OPEN |
| Fullscreen smoke after the pin bump | Phase 2 | pi-fullscreen | human | OPEN |
| PR linked and required checks green | Phase 2 | github-pr | human | OPEN |
