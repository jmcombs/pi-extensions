# 0002 — Per-role execution posture enforced by the backend sandbox (D12)

- Status: Accepted
- Phase: 5 (Wire into the phase loop — self-hosting)
- Date: 2026-07-05

## Context

A relayed role's tool set is mapped to `claude`'s `--allowedTools` (D10). The
verify role declares read-only tools (`read, bash, grep, find`) — Edit/Write are
withheld. But **withholding Edit/Write is not a read-only guarantee**: the `bash`
tool can still mutate the working tree (`echo x > file`, `rm`, `mv`). D12 requires
the driver to translate a role's *posture* into the backend's **native**
enforcement so a read-only role genuinely cannot mutate the working tree, while
still being able to **execute** (build/test) and **see** the real, uncommitted
working-tree state.

### Spike — `claude` v2.1.201 real capabilities (empirical, not assumed)

| mechanism | blocks `bash` tree writes? | notes |
| --- | --- | --- |
| Withhold Edit/Write from `--allowedTools` | **No** | Baseline reproduced the bug: with `--allowedTools "Bash Read Grep Glob"` and no sandbox, `echo LEAK > ./file` **succeeded** (`LEAK` written). |
| `--permission-mode plan` | **No** | Gates Edit/Write + interactive approval only; `bash` still executes and mutates. |
| **`sandbox` settings (macOS Seatbelt)** | **Yes** | `--settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"filesystem":{"denyWrite":["<cwd>"]}}}'` — `echo … > ./probe` returned `operation not permitted`; **no file created**. `git status --short` still showed the uncommitted change; `node -e 'console.log(2+2)'` still ran. |

The sandbox runs the agent **in place** in the real working directory — it sees
uncommitted state — and denies writes to that tree at the OS level, while reads
everywhere and command execution stay allowed. This is design-tension option (i)
from the plan (backend-native in-place read-only), which is preferred over a
working-tree **copy** (ii) or a **worktree-at-ref** (iii) because it needs neither
and preserves full uncommitted-state fidelity with zero copy cost.

## Decision

Extend D10: the driver maps **posture → backend flags** exactly as it maps
tools → backend tool names. The resolver stays posture-neutral.

In `packages/relay/drivers/claude.ts`:

- `isReadOnlyPosture(tools)` — a role is read-only iff it declares a **non-empty**
  tool set that omits every mutation tool (`edit`/`write`). An empty/undefined set
  is **not** read-only: with no `--allowedTools` allowlist the backend runs its
  full default (write-capable) tool set, so the driver must not claim read-only.
- `readOnlySandboxSettings(cwd)` — emits `{ sandbox: { enabled: true,
  failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: {
  denyWrite: [cwd] } } }`. `failIfUnavailable` makes an unavailable OS sandbox a
  **hard failure** rather than a silent unsandboxed run — a read-only guarantee
  that cannot be enforced must not ship.
- `buildArgs` — for a read-only role, adds
  `--disallowedTools "Edit Write MultiEdit NotebookEdit"` (closes the tool path)
  **and** `--settings <readOnlySandboxSettings(cwd)>` (closes the `bash` path).
  Write-capable roles get neither. D2 is preserved: still a scoped allowlist,
  never `--dangerously-skip-permissions`.

`provider.ts` computes `cwd = process.cwd()` once and passes it to **both**
`buildArgs` (the deny path) and `spawn` (the child's cwd), so the denied path and
the working directory are guaranteed identical.

## Consequences

- A read-only relayed role (the verifier is the first consumer) cannot mutate the
  working tree even via `bash`; build/test execution and reads still work; the
  agent still observes uncommitted changes. Gate 5.1 is met by real backend
  enforcement, not by tool omission.
- The mechanism is OS-level (macOS Seatbelt; Linux/WSL2 needs bubblewrap+socat).
  `failIfUnavailable: true` means a host without a working sandbox fails the run
  rather than silently leaking write access — the safe default for a read-only
  guarantee.
- `denyWrite: [cwd]` denies writes to the working tree only; `$TMPDIR` and other
  default-writable scratch stay writable, so tooling that writes to temp still
  runs. A build that writes *into the source tree* (e.g. `dist/`) would be blocked
  under read-only posture — intended: that is a mutation of the tree a verifier
  must not perform.
- No new runtime dependency; the change is argv-only. `npm ci` lockfile parity
  holds.
