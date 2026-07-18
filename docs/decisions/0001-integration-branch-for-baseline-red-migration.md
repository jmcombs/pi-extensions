# 0001 — Integration branch for the baseline-red AuthStorage migration

- Status: Accepted
- Phase: 1 (Baseline reset & unrelated 0.80.8 fixes) — governs P1–P9
- Date: 2026-07-18

> Note: an earlier ADR in this repo also carries the number `0001`
> (`0001-pi-ai-peer-dependency.md`, a relay-project decision). This ADR is
> `0001` within the `docs/1p-credential-api/` plan's Appendix A decision log,
> which numbers its own decisions from `0001`. The filename slug disambiguates.

## Context

Phase 1 of the 1Password credential-API plan aligns the repo's pi runtime
dev-dependencies to `^0.80.9` (`@earendil-works/pi-ai`, `pi-coding-agent`,
`pi-tui`). pi 0.80.8 removed the exported `AuthStorage` class, so on pi 0.80.9
the four consumer extensions that still call `AuthStorage.create()` —
`context7`, `tavily-search`, `grok-search`, `headroom` — fail `tsc`. This is the
**intended, tracked baseline-red** the plan fixes across phases P3–P6
(PLAN Appendix C item 3): the dep alignment is correct hygiene, and the
consumers are migrated onto the new stateless credential API in later phases.

The problem is process, not code: the `main` branch is protected by the
**Protect main** ruleset, whose required checks are `Quality Gate (Node 22)`,
`Quality Gate (Node 24)`, and `Commit Messages`. The Quality Gate runs
`npm run check`, which includes a full-repo `tsc --noEmit`. Because Phase 1
deliberately leaves the four consumers red until P6, a Phase 1 (or P2–P5) PR
targeting `main` cannot show a green Quality Gate — yet `main` itself must never
go red. Merging baseline-red phase branches directly into `main` would either
break `main` or force required-check bypasses on every intermediate phase.

## Decision

Adopt a **long-lived integration branch**, `feat/1password-credential-api`, cut
from `main`'s tip. The maintainer approved this workflow.

- **Phase branches P1–P9 PR into `feat/1password-credential-api`, not `main`.**
  Intermediate phase PRs may carry the tracked baseline-red (the four
  unmigrated `AuthStorage` consumers) while the migration is in flight.
- The three required checks (`Quality Gate (Node 22)`, `Quality Gate (Node 24)`,
  `Commit Messages`) must be **green on the final
  `feat/1password-credential-api` → `main` PR**. By that point P6 has migrated
  the last consumer, so the full repo is green.
- **`main` stays green throughout.** No baseline-red state ever lands on `main`;
  the integration branch absorbs it and is only merged once whole.
- Per-phase gate proof and `no new errors elsewhere` (PLAN Appendix C item 3)
  still apply to every phase PR against the integration branch.

## Consequences

- `main` is never red; branch protection on `main` is never bypassed for this
  migration. The single integration→`main` PR is the one place all three
  required checks must pass, and it will, because the migration is complete
  there.
- Intermediate phase PRs are reviewed against the integration branch, where a
  red full-repo Quality Gate is expected and does not indicate a regression —
  reviewers rely on the per-phase Testing Gates plus the `no new errors
  elsewhere` invariant instead.
- The plan's Git & PR conventions and Appendix C item 7 are updated to state the
  integration-branch target and where required-checks-green is enforced.
- When the integration branch merges to `main`, the phase commits arrive as one
  coherent, green change set; Release Please then sees the migrated packages'
  conventional commits and opens the per-package release PRs as usual.
