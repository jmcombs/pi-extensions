# 0002 — Per-role execution posture: read-only by declaration, tree-hygiene by detection (D12)

- Status: Accepted
- Phase: 5 (Wire into the phase loop — self-hosting)
- Date: 2026-07-05

## Context

A relayed role's tool set is mapped to `claude`'s `--allowedTools` (D10). The
verify role declares read-only tools (`read, bash, grep, find`) — Edit/Write are
withheld. The open question was how strongly relay should enforce that a
read-only role cannot mutate the working tree: is withholding Edit/Write enough,
or must the backend be OS-sandboxed so even `bash` (`echo x > file`, `rm`, `mv`)
cannot write?

### The rejected spike — a backend OS sandbox

A first Phase-5 attempt (commit `563345d`) translated a read-only posture into
`claude`'s native macOS-Seatbelt sandbox:
`--settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"filesystem":{"denyWrite":["<cwd>"]}}}'`
plus `--disallowedTools "Edit Write NotebookEdit"`. In a narrow probe this did
block a `bash` write (`echo … > ./probe` → `operation not permitted`).

**It was rejected by decision, for two independent reasons:**

1. **It breaks the verifier's own mandated gate.** The verifier's job is to run
   the repo's full `npm run check`, which includes `vitest`. `vitest` writes
   scratch to `node_modules/.vite-temp` — a path **inside** `cwd`. `denyWrite:[cwd]`
   turns that write into `EPERM`, so **zero tests are collected** and the gate the
   verifier exists to run cannot run. A read-only guarantee that disables
   verification is worse than useless.
2. **It buys no verdict integrity.** The threat a verifier sandbox would defend
   against is a verifier that tampers with the tree to force a verdict. But a bad
   or compromised verifier simply **returns the wrong verdict** — `VERDICT: PASS`
   on broken code — **without writing a single byte**. Write-blocking is the wrong
   lever: it does not constrain the one thing that matters (the verdict), and the
   verdict is already contained by other means (see below).

## Decision

**Read-only is by declaration; tree-hygiene is by detection, not prevention. No
OS sandbox.**

- **By declaration (relay / `packages/relay`).** A role's read-only posture is
  expressed by its **declared tools**. The driver maps only those to the backend's
  `--allowedTools` and withholds Edit/Write. It emits **no** `--settings` sandbox
  and **no** `--disallowedTools`. The read-only verifier therefore runs in the
  **real git-tracked tree** and can run the full `npm run check` (incl. `vitest`)
  in-tree, unbroken. D2 is preserved: still a scoped allowlist, never
  `--dangerously-skip-permissions`.
- **By detection (orchestrator / dotfiles `phase-orchestrate`).** Enforcement that
  "the verifier didn't tamper with the tree" is by **detection, not prevention**:
  **after** verify, the orchestrator diffs the working tree; if the verifier
  changed anything it **presents the diff to the human and asks discard-or-keep**,
  and does **not** act on the verdict until the human decides.

### Why detection is sufficient — containment already holds

- The verifier **cannot merge or tick** (**D7**): the verify role reports verdict +
  evidence only.
- Any change the verifier makes is **git-visible and uncommitted** — a `git status`
  / `git diff` after the run surfaces it deterministically.
- **Merge is human-gated**: PASS halts at the human merge-gate; a human opens the
  PR and merges. Nothing the verifier writes can reach `main` without a human
  looking at the tree.

So the residual risk a sandbox would have addressed (an unnoticed tree mutation
riding a verdict to merge) is already closed by D7 + git visibility + the
human merge-gate. Detection then makes the mutation **explicit** and hands the
keep/discard choice to the human before the verdict is acted on.

## Consequences

- The read-only verifier runs the repo's **full `npm run check` in-tree** with no
  `EPERM` and all tests collected (Gate 5.1). The revert directly unbroke
  verification.
- `packages/relay/drivers/claude.ts` returns to Phase-4 behavior: map declared
  tools → `--allowedTools`, no posture machinery
  (`isReadOnlyPosture`/`readOnlySandboxSettings`/`--settings`/`--disallowedTools`
  removed). `provider.ts` no longer plumbs a sandbox-only `cwd`.
- The change is **portable**: no dependency on macOS Seatbelt (or Linux
  bubblewrap+socat), which the sandbox approach required.
- Tree-hygiene moves to the **caller's contract** in the `phase-orchestrate`
  skill (diff-after-verify + present-to-human), consistent with dispatch
  cardinality (Part 2) and PASS/FAIL routing (Part 3) also living there.
- No new runtime dependency; `npm ci` lockfile parity holds.

_Supersedes the Phase-5 Seatbelt-sandbox spike (`563345d`), reverted._
