# 0006 — Credential-setup command naming: `{brand-slug}_setup`

- Status: Accepted
- Phase: 4 (tavily-search → 1Password credential API) — applied repo-wide
- Date: 2026-07-18

> Note: like the other ADRs in this directory, this ADR's number is scoped to the
> `docs/1p-credential-api/` plan's Appendix A decision log (which numbers from
> `0001`); the filename slug disambiguates it from any unrelated repo ADR sharing
> the number.

## Context

The credential/integration setup commands across the extensions had grown
inconsistent names:

- `context7_onboard` (context7)
- `tavily_authenticate` (tavily-search)
- `grok_authenticate` (grok-search, pre-migration)
- `headroom-authenticate` (headroom, pre-migration)
- `1password_onboard` (the 1Password extension's guided integration setup)

Three different verbs (`onboard` / `authenticate` / no verb) and a mix of
separators (`_` vs `-`) for what is, from the user's point of view, the same
action: **configure this extension's credential.** A user who learns
`/context7_onboard` cannot guess `/tavily_authenticate`. The commands also both
*create* a key on first run and *update* it later, so "authenticate" (sign-in
flavored) and "onboard" (first-run flavored) each undersell what the command does.

## Decision

The maintainer approved a single repo-wide convention:

- The credential/integration **setup command is named `{brand-slug}_setup`** — a
  short brand slug, an underscore separator, and the literal verb `setup` —
  across **every** extension, including the 1Password extension itself.
  - `context7_onboard` → **`context7_setup`**
  - `tavily_authenticate` → **`tavily_setup`**
  - `1password_onboard` → **`1password_setup`**
  - grok-search and headroom are born `grok_setup` / `headroom_setup` when they
    migrate (P5 / P6); they never ship the old names on the integration branch.
- `setup` was chosen over `onboard` / `authenticate` because the command **sets up
  OR updates** a key — it is idempotent configuration, not a one-time onboarding
  or a sign-in.
- **Consumer** setup-command descriptions are unified to the exact string:
  `Set up or update your {label} API key (never shown to the agent).` (literal
  label, e.g. `Context7` / `Tavily`). This standardizes the user-facing copy and
  keeps the "never shown to the agent" guarantee explicit.
- The **1Password extension keeps its existing description.** `1password_setup`
  configures the 1Password *integration* / transparent shell-env injection (it
  writes `!op read` entries for many tools), not a single API key, so the API-key
  description does not apply to it — only its command **name** changes.
- **Out of scope:** diagnostic / execution commands and tools — `1password_diagnose`,
  `1p_run`, `1p_diagnose` — are not setup commands and are **not** renamed.

## Consequences

- All live code, tests, and user-facing docs (package READMEs, `PLAN.md`,
  `API.md`) now use the `{slug}_setup` names; the smoke tests assert the new
  command names.
- The `_template` and `TEMPLATE.md` should teach `{slug}_setup` as the setup-command
  convention when they are updated (P7); the current `_template` registers only a
  non-credential `example-hello` command, so nothing needed renaming there yet.
- grok-search / headroom adopt `{slug}_setup` at migration time (P5 / P6).
- Incidental references to the old command names in **prior ADRs** (0003, 0004,
  0005 — internal, actively cross-referenced design records) were updated to the
  new names for consistency.
- **Historical CHANGELOG entries are intentionally left unchanged.** Three lines
  remain that name the old commands — `packages/tavily-search/CHANGELOG.md`
  (v2.1.0, PR #24, `/tavily_authenticate`) and `packages/1password/CHANGELOG.md`
  (v1.0.0, PR #34, `/1password_onboard`). These are release-please-generated,
  published records of what each shipped version actually contained; rewriting
  them would misstate release history and sits outside the maintainer-approved
  update scope (READMEs / PLAN / API.md). The rename itself surfaces in the next
  release notes via this commit, not by editing past entries.
- This is a **non-breaking UX change** (D13): the command is invoked interactively
  by name; no stored credential, `auth.json` shape, or resolve path changes.
