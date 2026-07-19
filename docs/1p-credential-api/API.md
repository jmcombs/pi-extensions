# `@jmcombs/pi-1password` — Credential API reference

The 1Password extension is the **credential authority** for this monorepo's pi
extensions. Other extensions declare
`@jmcombs/pi-1password` as a hard dependency and **import** the six
functions below instead of touching pi internals — `AuthStorage`, `ModelRuntime`,
and `readStoredCredential` were all removed in pi 0.80.8.

```ts
import {
  resolveSecret,
  onboardSecret,
  changeSecret,
  verifySecret,
  deleteSecret,
  is1PasswordAvailable,
} from "@jmcombs/pi-1password";
```

All six are re-exported from the package entry point (`index.ts`) and implemented
in `credential-api.ts`.

## Design guarantees

- **Stateless.** Every function reads `~/.pi/agent/auth.json` and/or runs the
  `op` CLI **fresh** on each call. Nothing relies on module-level session state, so
  a consumer that imports its own fresh module instance behaves identically to the
  host extension. (The agent directory is resolved via pi's `getAgentDir()`, which
  honors `PI_CODING_AGENT_DIR`.)
- **Fail-closed.** A missing entry or a failed `op read` yields `undefined` /
  `ok: false` — never the unresolved raw value and never a thrown error across the
  public read path.
- **Never leaks secrets.** No function returns or logs a user-entered value or a
  resolved secret except `resolveSecret`, whose entire job is to hand the secret to
  its caller. `verifySecret` reports only whether a value resolved.
- **Additive.** The `1password_setup` / `1password_diagnose` tools and the
  transparent bash spawn-hook env injection are unchanged. (The `1p_run` tool was
  later retired; the transparent `createBashTool` injection and the
  feature-detected `user_bash` hook remain.)

## Storage shape

Entries are **provider-shaped** and keyed by a **logical name**:

```jsonc
{
  // 1Password vault reference (resolves via `op read` on each use):
  "context7": { "type": "api_key", "key": "!op read 'op://Vault/Item/field'" },

  // Manually entered literal key (when `op` is unavailable):
  "tavily":   { "type": "api_key", "key": "tvly-xxxxxxxxxxxxxxxx" }
}
```

Legacy **bare-string** entries (`{"context7": "!op read '…'"}` or a plain literal)
continue to resolve on read — `resolveSecret` handles both shapes. The
provider-shaped writer serializes writes with a file lock (an `O_EXCL` lockfile
plus atomic temp-write + rename), so concurrent onboards never corrupt
`auth.json`; the older top-level `!op read` writer used by `/1password_setup`
remains for that command.

Values that begin with `!op read '…'` are also swept at startup by the
conditional **warm-on-load**: if any top-level string **or** nested `.key`
holds an `!op read` reference, the extension runs one best-effort `op read` on
load so the OS-level 1Password biometric prompt lands once, at startup.

---

## `resolveSecret(name)`

```ts
function resolveSecret(name: string): Promise<string | undefined>
```

Reads `auth.json` fresh, takes `parsed[name]`, and resolves it. Handles **both** a
provider-shaped object (uses `.key`) and a bare literal string. A `!op read '<ref>'`
value runs the 1Password CLI; any other `!<cmd>` runs in a minimal shell; a bare
literal is returned as-is.

- **Returns** the resolved secret string, or `undefined` when the entry is missing
  or resolution fails (fail-closed — never the unresolved raw value).
- **Never throws** for a missing/failed entry.

```ts
const apiKey = await resolveSecret("context7");
if (!apiKey) {
  /* prompt onboarding, then re-resolve */
}
```

## `onboardSecret(ctx, opts)`

```ts
// The minimal context capability the onboarding surface needs — just `ui`.
// Satisfied by a command handler ctx, a tool `execute()` ctx, an event/shortcut
// handler ctx, or a bare `{ ui }` test double.
type UiContext = Pick<ExtensionContext, "ui">;

interface OnboardOptions { name: string; label: string; overwrite?: boolean }
interface OnboardResult  { ok: boolean; message: string }

function onboardSecret(ctx: UiContext, opts: OnboardOptions): Promise<OnboardResult>
```

Interactively onboards a secret:

1. **Existing-key gate first.** If `name` already has a value and `overwrite` isn't
   set, the user is asked to *Replace it* or *Keep the current key*; keeping (or
   Esc) returns `{ ok: false, message: "Kept your existing {label} key. Nothing
   changed." }` without touching anything.
2. **Branches on 1Password availability** (`is1PasswordAvailable()`):
   - **`op` available →** a source menu with three options: **Locate in
     1Password** (the live vault → item → field picker, auto-skipping the field
     step for single-credential items), or **Enter a 1Password reference** (a
     validated `op://vault/item/field` path) — both stored as `!op read '<ref>'`;
     or **Type or paste the key** — a **masked** literal entry (the value is never
     drawn on screen), stored as a literal provider-shaped entry.
   - **`op` not available →** the same masked literal entry, plus a nudge to
     install the 1Password CLI to keep keys in the vault.
3. **Post-save verify.** After a successful write, the entry is resolved once
   (`verifySecret`) to confirm it works; the returned `message` reflects the
   outcome.

- **Returns** `{ ok, message }`. `message` is safe to surface to the user (context7
  and the other consumers simply `notify` it); it never contains the entered value,
  a resolved secret, `auth.json`, `changeSecret`, or the raw `name` (outside a
  `/{name}_onboard` token). Post-save verify sub-warnings ("Saved, but …") are
  returned with `ok: true` so the caller still re-resolves. Interstitial failures
  (browse errors, an incomplete `op://` path) are notified directly, then the flow
  returns the verbatim `Onboarding cancelled.`
- Refuses to overwrite an existing entry unless `opts.overwrite` is set (use
  `changeSecret`), which pre-selects Replace.

## `changeSecret(ctx, opts)`

```ts
function changeSecret(ctx: UiContext, opts: OnboardOptions): Promise<OnboardResult>
```

Same as `onboardSecret` with `overwrite: true` — runs the identical
availability-branched flow and **replaces** any existing entry for `opts.name`.
Returns `{ ok, message }`.

## `verifySecret(name)`

```ts
interface VerifyResult { ok: boolean; resolved: boolean; error?: string }

function verifySecret(name: string): Promise<VerifyResult>
```

Resolves `name` and reports **whether** it yields a non-empty value **without ever
returning the value**.

- **Returns** `{ ok: true, resolved: true }` when a non-empty value resolves;
  otherwise `{ ok: false, resolved: false, error }` where `error` explains the
  failure (missing entry, or `op read` failed / returned empty).
- **Never throws** — an unexpected error is captured into `error`.

## `deleteSecret(name)`

```ts
interface DeleteResult { ok: boolean }

function deleteSecret(name: string): Promise<DeleteResult>
```

Removes `parsed[name]` from `auth.json` under the file lock.

- **Returns** `{ ok: true }` when an entry was present and removed, `{ ok: false }`
  when there was nothing to remove.

## `is1PasswordAvailable()`

```ts
function is1PasswordAvailable(): Promise<boolean>
```

Whether 1Password vault integration is usable: the `op` CLI is installed **and**
an auth path is **configured** (via `getOpStatus()` → `available && configured`).
`configured` is true when any of: `OP_SERVICE_ACCOUNT_TOKEN` is set; both
`OP_CONNECT_HOST` and `OP_CONNECT_TOKEN` are set; or `op account list` returns a
non-empty account list.

It deliberately does **not** gate on `op whoami`/`signedIn`. Under the 1Password
desktop-app biometric integration, `op whoami` reports a false "not signed in" for
a cold CLI invocation even though `op read` works — so `signedIn` is retained for
diagnostics only and never gates access. The check is **passive**: no unlock and
**no Touch ID prompt at check time**; the account session unlocks lazily on the
first `op read` (the startup warm-on-load triggers it once). Used to branch
onboarding between the vault picker and manual key entry.

- **Returns** `true` when `op` is available and configured, otherwise `false`.

---

## Error & fail-closed semantics summary

| Function               | Missing / failure result                              | Throws? |
| ---------------------- | ----------------------------------------------------- | ------- |
| `resolveSecret`        | `undefined`                                           | No      |
| `onboardSecret`        | `{ ok: false, message }` (cancel / exists / no input) | No      |
| `changeSecret`         | `{ ok: false, message }`                              | No      |
| `verifySecret`         | `{ ok: false, resolved: false, error }`               | No      |
| `deleteSecret`         | `{ ok: false }` (nothing to remove)                   | No      |
| `is1PasswordAvailable` | `false`                                               | No      |

## Typical consumer wiring

```ts
import { resolveSecret, onboardSecret } from "@jmcombs/pi-1password";

// In a tool's execute():
let apiKey = await resolveSecret("context7");
if (!apiKey) {
  const r = await onboardSecret(ctx, { name: "context7", label: "Context7" });
  if (r.ok) apiKey = await resolveSecret("context7");
}
if (!apiKey) return { /* isError: missing_api_key */ };
```

The `ctx` passed here is the tool's `execute()` context. Because `onboardSecret`
takes `UiContext` (`Pick<ExtensionContext, "ui">`), the same call works verbatim
from a command handler, an event/shortcut handler, or a `{ ui }` test double — no
casting required.

See the step-by-step integration guide ([`INTEGRATION.md`](./INTEGRATION.md))
for a full worked example.
