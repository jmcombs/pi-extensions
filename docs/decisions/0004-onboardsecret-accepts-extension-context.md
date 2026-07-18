# 0004 — `onboardSecret` accepts `ExtensionContext`, not `ExtensionCommandContext`

- Status: Proposed (pending orchestrator/maintainer review)
- Phase: 3 (context7 → 1Password credential API), surfacing a Phase 2 defect
- Date: 2026-07-18

> Note: like the `0001`–`0003` ADRs in this directory, this ADR's number is
> scoped to the `docs/1p-credential-api/` plan's Appendix A decision log (which
> numbers from `0001`); the filename slug disambiguates it.

## Context

Phase 3's literal Actionable TODO wires the imported credential API into
**both context7 tools' `execute()`**:

```ts
let apiKey = await resolveSecret("context7");
if (!apiKey) {
  const r = await onboardSecret(ctx, { name: "context7", label: "Context7" });
  if (r.ok) apiKey = await resolveSecret("context7");
}
```

pi types a tool's `execute()` callback context as **`ExtensionContext`**
(`ToolDefinition.execute(..., ctx: ExtensionContext)` in
`@earendil-works/pi-coding-agent`), whereas Phase 2 typed
`onboardSecret`/`changeSecret` (and their transitive helpers
`pickOpReferenceSimple`, `selectInBorderedPopup`, `inputInBorderedPopup`,
`confirmInBorderedPopup`) as **`ExtensionCommandContext`**. Because
`ExtensionCommandContext extends ExtensionContext` (adds `newSession`, `fork`,
`waitForIdle`, `navigateTree`, …), the wider `execute()` context is **not
assignable** to the narrower parameter, so the literal wiring fails
`tsc` (verified empirically):

```
packages/context7/index.ts(140,39): error TS2740: Type 'ExtensionContext' is
  missing the following properties from type 'ExtensionCommandContext':
  getSystemPromptOptions, waitForIdle, newSession, fork, and 3 more.
```

This is a **Phase 2 over-narrowing**, not a context7 problem:

- Every one of these functions uses **only `ctx.ui.*`** (`ui.custom`,
  `ui.setStatus`, `ui.notify`) — all members of `ExtensionUIContext`, which is
  present on the base `ExtensionContext`. None call a command-only method. So the
  wider type is sufficient at runtime; the narrower annotation was incidental.
- Phase 2's own reference doc already documents calling `onboardSecret` **from a
  tool's `execute()`** (`docs/1p-credential-api/API.md` → "Typical consumer
  wiring": `// In a tool's execute():` `await onboardSecret(ctx, …)`). The P2
  signature therefore contradicts the P2 contract.

Phase 3's scope is nominally "add the dependency; import the API; rewrite
context7's onboarding command and both tools' auth paths". Fixing this requires
editing files in the **`@jmcombs/pi-1password` (P2) package**, which is outside
that literal scope — hence this ADR, per the phase-build escalation rule.

Alternatives considered and rejected:

- **Cast in context7** (`onboardSecret(ctx as unknown as ExtensionCommandContext, …)`)
  — an unsafe, dishonest assertion (claims capabilities the value lacks) that
  would rot the moment `onboardSecret` ever touched a command-only method, and
  runs against the TypeScript standards' spirit. Rejected.
- **Leave P2 as-is and skip the auto-onboard in `execute()`** — violates the
  literal Phase 3 TODO and the "prompt on first use" architectural constraint.
  Rejected.

## Decision

Widen the `ctx` parameter of the onboarding surface from
`ExtensionCommandContext` to the base **`ExtensionContext`** — the minimum type
each function actually needs — so the API is callable from both command handlers
(`ExtensionCommandContext` is-a `ExtensionContext`) and tool `execute()`
(`ExtensionContext` directly), matching the API.md contract.

Files changed in `packages/1password/`:

- `credential-api.ts` — `onboardSecret(ctx: ExtensionContext, …)`,
  `changeSecret(ctx: ExtensionContext, …)`, and the type import.
- `index.ts` — `pickOpReferenceSimple(ctx: ExtensionContext)` and the type import.
- `ui/bordered-popups.ts` — `selectInBorderedPopup`, `confirmInBorderedPopup`,
  `inputInBorderedPopup` `ctx` params and the type import.

This is a **pure type-annotation widening**: no runtime behavior changes, and all
existing callers (the `/1password_onboard` command handler, which passes an
`ExtensionCommandContext`) remain valid.

## Consequences

- context7's Phase 3 literal wiring typechecks (`tsc -p packages/context7` exit 0);
  the 1Password package remains green (`tsc`, `biome`, `vitest` all pass, 27 tests).
- The credential API now matches its own documented usage from `execute()`, so the
  later consumer migrations (P4 tavily-search, P5 grok-search, P6 headroom) that
  reuse the same auto-onboard-on-miss pattern inherit the corrected signature and
  need no further change here.
- No Locked Decision is altered; no gate is weakened. The change is additive and
  behavior-preserving.
- **For review:** the fix lands in the P2 package from a P3 branch. If the
  orchestrator/maintainer prefers it split into a separate P2 follow-up commit,
  the type edits are isolated and can be cherry-picked out; the context7 changes
  depend only on the widened signature, not on where the commit lives.
