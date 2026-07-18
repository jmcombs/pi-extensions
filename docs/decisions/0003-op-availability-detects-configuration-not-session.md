# 0003 — `op` availability detects configuration, not live session

- Status: Accepted
- Phase: 2 (1Password credential API + warm-on-load + API reference)
- Date: 2026-07-18

> Note: like the two `0001-*` and two `0002-*` ADRs in this directory, this ADR's
> number is scoped to the `docs/1p-credential-api/` plan's Appendix A decision
> log (which numbers from `0001`); the filename slug disambiguates it from any
> unrelated repo ADR sharing the number.

## Context

`is1PasswordAvailable()` (D6) and the `1p_run` tool both gated on
`getOpStatus().signedIn`, which was derived from `op whoami`. This produces a
**false negative** under the 1Password **desktop-app biometric integration**: the
`op` CLI holds no persisted session between separate invocations, so a cold
`op whoami` reports "not signed in" even though the account is fully usable and
`op read` succeeds.

Verified empirically on this machine (op 2.34.1):

```
$ op whoami --format json
[ERROR] 2026/07/18 … account is not signed in        (exit 1)

$ op account list --format=json
[ { "url": "combsfamily.1password.com", "email": "…", "user_uuid": "…",
    "account_uuid": "…" } ]                            (exit 0, non-empty)
```

So `whoami` says "no", while `account list` (a **passive** query — no unlock, no
Touch ID prompt) says an account is configured, and `op read` would succeed
(prompting biometrics once, at first use). Gating availability on `whoami` is a
category error: the right question for D6 is **"is an auth path configured?"**,
not **"is there a live CLI session right now?"**. The single-prompt-then-cached
behavior (D8) is an OS-level biometric session owned by the 1Password app and is
established lazily by the first `op read`, not by `whoami`.

The **same root cause** afflicted the `1p_run` tool, which hard-blocked on
`!signedIn` before ever attempting `op run` — refusing to run under the exact
app-integration setup that works fine.

## Decision

The maintainer approved correcting availability detection to **configuration**,
not session, and rolling the identical correction into `1p_run` (same root
cause) within Phase 2 rather than deferring it.

- `getOpStatus()` now computes three signals:
  - `available` — `op --version` succeeds.
  - `configured` — **true** if any of: `OP_SERVICE_ACCOUNT_TOKEN` is set; both
    `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN` are set; or
    `op account list --format=json` exits 0 and parses to a non-empty array. All
    `op` probes use a 5s timeout; any non-zero/timeout/unparsable result ⇒
    `configured=false` and never throws. This is the availability gate.
  - `signedIn` — from `op whoami`, retained **for diagnostics only**. A non-zero
    `whoami` is expected under app-integration and is never used to gate access.
- `is1PasswordAvailable()` returns `available && configured` (was
  `available && signedIn`).
- `1p_run` no longer pre-blocks on `!signedIn`. When `configured` is true it
  **attempts** the `op run` and lets `op` unlock the session lazily; sign-in
  guidance is surfaced only if the run itself fails with an auth-shaped error.
  When `configured` is false it returns actionable configuration guidance.
- The interactive account **unlock is deferred to the first `op read`** (warm-on-
  load, D7/D8, still triggers it once at startup). No availability check performs
  an unlock or a Touch ID prompt.
- `1password_onboard`, `1password_diagnose`, and the bash spawn-hook are otherwise
  unchanged; diagnostics may still display `signedIn` as informational.
- Never log secret values (service-account tokens, Connect tokens).

## Consequences

- The primary regression is fixed: on a machine with the desktop-app biometric
  integration and no persisted CLI session, `is1PasswordAvailable()` and `1p_run`
  now correctly treat 1Password as usable.
- `op whoami` is demoted to a diagnostic detail; `op account list` (passive) plus
  service-account / Connect env become the availability signal.
- Availability checks are prompt-free (no Touch ID at check time); the one
  biometric prompt lands at the first real `op read` (startup warm-up, D8).
- Determinism note: the decision logic (env precedence, empty-array handling,
  non-zero/timeout handling) is covered by tests that inject `execAsync` /
  `process.env` outcomes. The real `op` behavior was verified empirically (above)
  and remains covered by the maintainer-only `op-live` gate; the mocks exist
  solely to make the pure gating policy deterministic, not to fake the CLI.
- D6's parenthetical mechanism and the Phase 2 "do not alter existing tools"
  constraint are updated to record the `1p_run` gating carve-out.
