# 0005 — Onboarding UX redesign (sources, masked entry, upfront overwrite, verify)

- Status: Accepted (maintainer-approved, from a UX research review)
- Phase: 3 (context7 → 1Password credential API), applied in the shared 1p API
- Date: 2026-07-18

> Note: like the `0001`–`0004` ADRs in this directory, this ADR's number is scoped
> to the `docs/1p-credential-api/` plan's Appendix A decision log (numbered from
> `0001`); the filename slug disambiguates it.

## Context

The Phase 3 live-review surfaced UX problems in `onboardSecret`'s first cut:

- **Secret shown in plaintext.** The "paste the key directly" path used
  `inputInBorderedPopup`, which delegated display to pi's `Editor` — the typed API
  key was echoed on screen. A credential prompt must not render the secret.
- **Overwrite handled last.** The old flow only discovered an existing key at
  write time, surfacing `writeProviderAuthEntry`'s developer-facing
  "already exists" message (leaking `auth.json` / the raw logical `name`) after the
  user had already done the work.
- **A single op source.** With `op` available the user could only "look it up" or
  "type an op:// reference" — there was no "paste the key directly" option, and the
  reference entry had no validation and a terse dev voice.
- **No confirmation the key works.** After saving, nothing checked the entry
  actually resolved, so a fat-fingered `op://` path failed silently later.
- **Two latent UI-primitive bugs.** `confirmInBorderedPopup` accepted a `message`
  it never rendered (only the title showed); `inputInBorderedPopup` rendered a
  `prompt` as a single line, truncating any multi-line safety notice.

## Decision

The maintainer approved a full redesign of `onboardSecret`, plus the two enabling
UI-primitive fixes. Copy is drop-in with `{label}` / `{name}` interpolation.

**Enabling primitives (`ui/bordered-popups.ts`):**

- **Masked input.** `inputInBorderedPopup` gains `mask?: boolean`. In masked mode
  the popup renders one `•` per typed code point and **never calls
  `editor.render()`**, so the plaintext is never emitted. The pi-tui `Editor`
  remains the (headless) input model — key decoding, paste, and submit still work;
  we read `editor.getText()` for the bullet count only. Verified empirically that a
  headless `Editor` processes `handleInput`/`getText`/`onSubmit` with a no-op TUI.
- **`confirm` message rendered.** `selectInBorderedPopup` gains an optional
  `message` body (split on `\n`) drawn above the list; `confirmInBorderedPopup`
  now passes its `message` through. `inputInBorderedPopup` also splits `prompt` on
  `\n`, so multi-line notices render in full.

**Redesigned flow (`credential-api.ts` `onboardSecret`):**

1. **Existing-key gate first** — before any source/browse work. If `name` already
   has a value and `overwrite` isn't set, a 2-item **select** (`Replace it` /
   `Keep the current key`; Esc = keep) runs. Keeping returns
   `Kept your existing {label} key. Nothing changed.` without touching anything.
2. **Branch on `is1PasswordAvailable()`:**
   - **Available →** a source menu (`Set up your {label} key`) with three
     description-backed options — **Locate in 1Password** (the browse picker,
     with cleaned titles, a single "type to filter" help line, and **auto-skip of
     the field step** when the item has exactly one credential-type field),
     **Type or paste the key** (masked literal entry), and **Enter a 1Password
     reference** (plaintext, since an `op://` path is a pointer not a secret,
     validated `^op://<vault>/<item>/<field>$`).
   - **Not available →** straight to the same masked literal entry.
3. **Write, then verify.** After a successful write, `verifySecret(name)` confirms
   the entry resolves; the outcome message is friendly and human-only.

**Voice.** One cancel line everywhere (`Onboarding cancelled.`); one warning voice
for browse error/empty states; the old developer-facing failure (emitting
`changeSecret` / `auth.json` / the raw `name`) is gone. User-facing text uses
`{label}` ("Context7"), never the raw `{name}` — except inside `/{name}_onboard`
command tokens, which are legitimate.

**Notification ownership (reconciliation with unchanged context7).** context7 stays
a thin delegator: `notify(result.message, result.ok ? "info" : "warning")`. To keep
a single, non-contradictory toast per terminal outcome, `onboardSecret` returns the
final outcome as `message` (the caller notifies it once) and only calls
`ctx.ui.notify` directly for **interstitial** failures that then end in a clean
cancel — browse error/empty states (owned by `pickOpReferenceSimple`) and the
`op://` validation reject — exactly the "notify the reason, then return cancel"
pattern. Consequently the post-save verify sub-warnings ("Saved, but …") are
returned as the terminal `message` (with `ok: true`, so the consumer still
re-resolves) rather than emitted as a second, separately-styled warning toast; this
avoids a double/contradictory notification while keeping context7 untouched.

## Consequences

- The paste path is now masked — no credential is ever drawn on screen. A new
  regression test drives the real `Editor` through the popup and asserts the render
  contains `•` and **not** the typed value, returning the value only to the caller.
- Overwrite is decided up front in the user's voice; the dev-facing "already
  exists" leak is gone. Onboarding gains a source choice under `op`, a validated
  reference path, field-step auto-skip, and a post-save resolve check.
- The new masked-input primitive and the `confirm`/multi-line `prompt` fixes are
  reusable by any extension using these helpers.
- **Tracked follow-up:** the separate shell-plugin `/1password_setup` command in
  `packages/1password/index.ts` still uses the older inline prompts. It should
  later adopt the same pattern (masked entry, upfront overwrite, source menu,
  post-save verify). Out of scope for this Phase 3 change; filed here so it is not
  lost.
- No Locked Decision is altered (this refines D6's onboarding mechanism, updated in
  the PLAN); no gate is weakened. All changes live in the shared 1p API +
  `bordered-popups.ts` + tests + docs; context7 is unchanged.
