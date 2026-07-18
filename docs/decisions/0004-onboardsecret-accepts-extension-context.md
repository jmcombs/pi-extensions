# 0004 — Onboarding surface takes the minimal `UiContext` capability

- Status: Accepted (maintainer-approved amended design)
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

Type the onboarding surface to the **minimal UI capability it actually uses** —
`ctx.ui` — rather than any whole concrete context. A single shared alias is the
source of truth:

```ts
// packages/1password/credential-api.ts (exported)
export type UiContext = Pick<ExtensionContext, "ui">;
```

The `ctx` parameter of every function on the onboarding path becomes `UiContext`.

An earlier revision of this ADR widened these params from
`ExtensionCommandContext` to the whole `ExtensionContext`; the maintainer
reviewed it and **approved an amended, narrower design**. `ExtensionContext`
works, but it demands ~15 unrelated context members these functions never touch
and it forbids a `{ ui }` test double — which is exactly the seam whose absence
let the original over-narrowing ship unnoticed. `Pick<ExtensionContext, "ui">` is
**strictly less coupled**: it is satisfied by a command handler ctx, a tool
`execute()` ctx, an event/shortcut handler ctx, **and** a bare `{ ui }` fake, so
the ctx path is finally unit-testable.

Files changed in `packages/1password/` (all pure type-annotation changes):

- `credential-api.ts` — defines and exports `UiContext`; `onboardSecret` and
  `changeSecret` take `ctx: UiContext`.
- `index.ts` — `pickOpReferenceSimple(ctx: UiContext)`, importing the alias from
  `./credential-api.js` (single source of truth); dropped the now-unused
  `ExtensionContext` import.
- `ui/bordered-popups.ts` — `selectInBorderedPopup`, `confirmInBorderedPopup`,
  `inputInBorderedPopup` take `ctx: UiContext` (imported from
  `../credential-api.js`).
- `docs/1p-credential-api/API.md` — the `onboardSecret` / `changeSecret`
  signatures and the "call from a tool `execute()`" consumer-wiring example now
  show `UiContext`.

No runtime behavior changes, and all existing callers (the `/1password_onboard`
command handler passing an `ExtensionCommandContext`, and context7's tool
`execute()` passing an `ExtensionContext`) remain valid — both structurally
satisfy `UiContext`.

## Consequences

- context7's Phase 3 literal wiring typechecks (`tsc -p packages/context7` exit 0);
  the 1Password package remains green (`tsc`, `biome`, `vitest` all pass).
- The onboarding surface is now **decoupled from any concrete context type** — it
  depends only on the `ui` capability. It is callable, without a cast, from
  command handlers, tool `execute()`, event/shortcut handlers, and plain `{ ui }`
  doubles. The credential API matches its own documented `execute()` usage.
- **The ctx path is now unit-testable**, closing the gap that hid the original
  bug. `credential-api.test.ts` gains: (a) a compile-level regression asserting
  `onboardSecret` is callable from an `ExtensionContext` (tool `execute()`), an
  `ExtensionCommandContext` (command handler), and a bare `{ ui }` double — the
  `tsc` gate fails if any callsite regresses; and (b) a runtime test that drives
  the manual-entry branch (`is1PasswordAvailable()` forced false via an
  `op`-less `PATH`) through a `{ ui }` fake against a temp `auth.json`, asserting
  the D4 provider-shaped literal is written. That runtime test would have caught
  the original defect.
- The later consumer migrations (P4 tavily-search, P5 grok-search, P6 headroom)
  reuse the same auto-onboard-on-miss pattern and inherit the corrected signature
  unchanged.
- No Locked Decision is altered; no gate is weakened. The change is additive and
  behavior-preserving.
- The fix lands in the P2 package from a P3 branch (transparently, via this ADR).
  The type edits are isolated and could be split into a P2 follow-up if desired;
  the context7 changes depend only on the signature, not on where it lives.
