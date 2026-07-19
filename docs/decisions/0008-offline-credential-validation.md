# 0008 — Offline (no-`op`) credential validation

- Status: Accepted
- Phase: 6 (headroom → 1Password credential API; full-repo green) — gates the merge
- Date: 2026-07-19

> Note: like the other ADRs in this directory, this ADR's number is scoped to the
> `docs/1p-credential-api/` plan's Appendix A decision log (which numbers from
> `0001`); the filename slug disambiguates it from any unrelated repo ADR sharing
> the number.

## Context

The 1Password credential API (`@jmcombs/pi-1password`) and its consumers are
designed to degrade gracefully when the 1Password CLI (`op`) is **not installed**:

- `is1PasswordAvailable()` returns `false` (op is not on PATH), so onboarding takes
  the **manual / masked literal-entry** branch instead of the vault picker (D6).
- `resolveSecret` returns a stored **literal** key directly (no `op` needed) and
  **fails closed to `undefined`** for an `!op read 'op://…'` reference it cannot
  resolve — never throwing, never leaking the raw reference (D5).
- Consumers that front a **keyless** local service (e.g. `headroom`'s local proxy)
  keep working with `apiKey: undefined`.

These behaviors were covered by unit tests that steer availability by manipulating
`PATH`, but there was no end-to-end proof in a **genuinely op-less environment** —
a machine where the `op` binary truly does not exist and there is no host `~/.pi`
to accidentally read. The maintainer requested a real offline validation —
"add an API key without `op`" — as a **must-pass gate on the Phase 6 merge**.

## Decision

The maintainer approved a **Docker-based offline validation** (must-pass, gates the
Phase 6 merge). It runs in a container built from `node:22` with:

- **No `op` binary** — the image build fails if the base ever ships one
  (`command -v op` must be empty), so the check exercises the real op-absent path.
- **No access to the host `~/.pi`** — no volumes are mounted; the check writes to a
  throwaway `PI_CODING_AGENT_DIR` (a fresh `mkdtemp` dir) chosen per scenario, which
  `getAgentDir()` honors. The maintainer's real agent directory is never read or
  written.

The check (`docker/offline-creds-check.mts`), run inside the container, asserts:

1. `command -v op` → empty (op is genuinely absent).
2. `is1PasswordAvailable()` → **false**.
3. **Add a key without `op`:** `onboardSecret(ctx, { name: "headroom", label:
   "Headroom" })`, driven by a `{ ui }` double that takes the manual/literal-entry
   branch, writes `{"headroom":{"type":"api_key","key":"<literal>"}}` to `auth.json`.
4. `resolveSecret("headroom")` → returns the literal (no `op` needed).
5. An entry whose key is `!op read op://Vault/Item/field` → `resolveSecret` →
   **`undefined`** (graceful fail-closed, no throw with `op` absent).
6. **Extension loads without `op`:** importing `packages/headroom/index.ts` and
   invoking its factory against a stub `ExtensionAPI` registers `headroom_setup`
   and `headroom_retrieve` (and the `session_start` handler) without throwing.
7. **headroom keyless:** `resolveConfig()` → `apiKey: undefined`, and `getClient()`
   constructs a `fallback: true` client — no crash.

It prints a single machine-checkable line and exits non-zero on any failed
assertion:

```
OFFLINE-CREDS: op-absent=ok available=false add-key=ok resolve-literal=ok resolve-opref=undefined loads=ok keyless=ok
```

Artifacts:

- `docker/offline-creds.Dockerfile` (+ `docker/offline-creds.Dockerfile.dockerignore`)
- `docker/offline-creds-check.mts`
- `scripts/test-offline-credentials.sh` (build + run + assert)
- `docker/README.md` — how to run it, and how to drive `headroom_setup`
  **interactively** in the same op-less container to eyeball the real TUI.

## Consequences

- Phase 6 gains a **must-pass** Testing Gate (`bash scripts/test-offline-credentials.sh`,
  capability `docker-offline`) that must be green before the migration merges.
- The offline/degraded path is now proven end-to-end in a real op-less, isolated
  environment — not just via `PATH` manipulation in unit tests.
- No product code changed: this ADR adds validation only. The container never
  touches the host `~/.pi` (throwaway `PI_CODING_AGENT_DIR`, no volume mounts),
  consistent with the isolation posture of D14.
