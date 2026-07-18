# 0007 — Tool error results report via `content`, not a returned `isError`

- Status: Accepted
- Phase: 5 (grok-search → 1Password credential API) — applied to context7 + tavily-search too
- Date: 2026-07-18

> Note: like the other ADRs in this directory, this ADR's number is scoped to the
> `docs/1p-credential-api/` plan's Appendix A decision log (numbered from `0001`);
> the filename slug disambiguates it from any unrelated repo ADR sharing the number.

## Context

pi **silently ignores a `isError` field returned on a tool result**. The
`pi-agent-core` success path hardcodes `isError: false` when it wraps a tool's
returned value into a tool-result entry; a tool is only marked errored when its
`execute()` **throws** (or a `beforeToolCall` / `afterToolCall` hook flags it).
So a tool that `return`s `{ content, details, isError: true }` produces exactly the
same observable result as one that returns `{ content, details }` — the `isError`
is dead, no-op code. This was noted for relay (relay D9) and in
`memory/pi-0808-auth-migration`.

Several consumer tools nonetheless returned `isError: true` on their recoverable
error paths:

- `grok-search` — missing key, non-2xx, and network/catch paths.
- `context7` — missing key, 401, 429, other non-2xx, and network/catch paths
  (both `context7_search` and `context7_get_docs`).
- `tavily-search` — missing key, non-2xx, and network/catch paths.

The field misleads a maintainer into thinking pi will treat these as errors when it
does not, and it is untested (no gate asserts a returned `isError`).

## Decision

The maintainer approved a uniform error contract for consumer search tools:

- **Consumer tool error results report the error via `content[]` (a human/LLM-readable
  message) plus `details` (structured fields such as `status` / `error` / `body`),
  and never via a returned `isError`.** The dead field is removed.
- **Do not `throw` for user-facing recoverable errors.** Missing key (guide the user
  to `/{slug}_setup`), `401`, `429`, other non-2xx, and network/abort failures all
  return `content` so the LLM still receives the message and can guide the user.
  Throwing would strip that guidance and surface only a generic tool failure.
- **Reserve `throw` for genuinely fatal errors** — of which the current search tools
  have none. If a future path is truly unrecoverable, it throws (pi's only real
  error signal), rather than returning a no-op `isError`.

### Scope

- **Now:** `grok-search` (born correct in this migration), `context7`, and
  `tavily-search` (the merged phases have their returned `isError` removed —
  string/shape-only, no other logic change; expected on the integration branch).
- **P6:** `headroom` is born correct under this contract when it migrates.

## Consequences

- **Error UX is unchanged.** The `content[]` message still reaches the model exactly
  as before; only the ignored `isError` field is gone. No gate is weakened.
- **Dead / misleading code is removed** and the error contract is uniform across the
  search consumers, so a future contributor is not led to believe a returned
  `isError` does anything.
- No stored credential, `auth.json` shape, or resolve path changes; this is a
  non-breaking internal correctness change (D13). No test asserted the returned
  `isError`, so no test needed loosening — tests assert `details.error` / `content`.
