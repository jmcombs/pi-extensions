---
name: initialize-steward
description: Connect this machine to Steward, the llama.cpp dashboard. Detects how llama-server is launched, proposes the flag and log-redirect fixes it needs, stands up a host-metrics collector, records service-control commands, and writes Steward's steward.json config. It edits service configuration, so it asks before every change and only runs when a human asks for it.
---

# Connect this machine to Steward

Steward reads one artifact — `$STEWARD_CONFIG` when that variable is set and non-empty, otherwise
`~/.config/steward/steward.json` — and trusts nothing else about this machine. Your job is to
establish the facts that go in it, fix what needs fixing, and prove the result works.

Work in six passes: **detect → propose → consent → apply → record and verify → report**. Detection
is read-only. Nothing is applied without the operator saying yes to that specific change.

References and scripts in this skill are relative to the directory holding this file, **not to your
working directory** — you are almost certainly running somewhere else. Every command below is
written as `<skill-dir>/…`: substitute the real absolute path literally, every time. Each command
runs in a fresh shell, so a variable you set in one does not exist in the next, and neither does a
`cd`.

```bash
node <skill-dir>/scripts/steward-setup.mjs help
```

The helper script owns everything that must not be improvised — the consent hashes, the file mode,
the atomic write, and the measurements that prove a collector really streams. Run its `help` once
before you start.

## Rules you must not break

1. **Never propose `--log-file`.** It is a real, documented llama.cpp flag, which is exactly why
   it looks reasonable. In router mode it is destructive: the router copies it into every child
   server's arguments, and each process opens it with truncate-not-append. Router plus N children
   then truncate the same file and write at independent offsets, producing duplicated and
   corrupted lines. Redirect the process's **stdout and stderr to one file** instead.
2. **Never redirect only one stream.** llama.cpp writes its no-level output to **stdout** and
   every levelled line (`I`/`W`/`E`) to **stderr**. The router's own lines are all levelled, so
   they go to stderr; the child lines it forwards are emitted without a level, so they go to
   stdout. A bare router was measured putting **18 levelled lines on stderr and 0 on stdout** —
   capturing stdout alone loses every error. launchd needs `StandardOutPath` **and**
   `StandardErrorPath` set to the same path; a shell wrapper needs `> file 2>&1`.
3. **Never synthesise VRAM on unified memory.** Apple Silicon has no separate VRAM and no
   readable GPU memory ceiling. Report `memoryTopology: "unified"` with RAM figures and omit the
   VRAM fields; Steward renders a single Unified Memory gauge. Any VRAM number here is invented.
4. **Never apply a change the operator has not seen and approved.** One change, one diff, one
   yes. A blanket "do whatever you need" is not consent for a service restart.
5. **Never detect compliance by calling endpoints.** In router mode with no model loaded,
   `/metrics?model=`, `/slots?model=` and `/props?model=` all return 400 — a missing flag and an
   unloaded model are indistinguishable. Compliance comes from the **launch argv**.
6. **Never treat a platform other than macOS/launchd as verified.** The launchd path has been
   exercised end to end. systemd, Windows (NSSM/`sc`) and Docker are researched but unproven:
   detect and propose there, explain that you are proposing from documentation, and let the
   operator apply the change themselves if they prefer.
7. **Never override `$STEWARD_CONFIG`.** If it is set and non-empty, that is the file the operator
   means, and it is the file you write. Do not second-guess it because the path looks temporary,
   scratch-like, sandboxed, or "left over from another session" — Steward itself reads that exact
   variable, so writing anywhere else produces a config Steward will never load. A path that does
   not exist yet is normal: `apply` creates the parent directory. If you believe the variable is
   wrong, say so and ask; never silently retarget. State the resolved path in your proposal so the
   operator can see which file they are approving.
8. **Never restore or revert as a remediation.** `git checkout`, `git restore`, `git stash pop`,
   `git reset` and their kin undo work the operator may have done deliberately — a deleted or
   modified config is a decision, not damage, and you cannot tell the difference from here. If a
   file you need is missing, propose **creating** it. This is not a ban on the operator's own
   tooling: writing a *new* file into a dotfiles package and `stow`ing it is the right move on a
   machine managed that way. The prohibition is on resurrecting prior state.

## Pass 1 — Detect (read-only)

Establish these facts. Say which ones you could not establish rather than guessing.

- **OS, architecture, GPU vendor, memory topology.** `uname -sm`; on macOS `sysctl -n hw.memsize`
  and `sysctl -n hw.model`. Apple Silicon ⇒ `unified`. A discrete NVIDIA/AMD GPU ⇒ `discrete`.
  Steward v1 does not model multi-GPU or hybrid integrated+discrete machines — if that is what
  this is, say so and pick the one the models actually run on.
- **Is llama-server up, and on what?** The base URL Steward will read, and the listening pid:
  `lsof -nP -iTCP:8080 -sTCP:LISTEN -t` (substitute the real port). `curl -s
  http://127.0.0.1:8080/health` should return `{"status":"ok"}`.
- **The launch argv.** From the launch mechanism's own record where possible, because `ps` loses
  quoting: a launchd plist's `ProgramArguments`, a systemd unit's `ExecStart`, `nssm get <svc>
  AppParameters`. `ps -ww -o args= -p <pid>` is the universal fallback.
- **The launch mechanism and its label.** See `references/llama-compliance.md` for the
  per-mechanism detection commands, all read-only.
- **The launch environment**, from the same record — launchd's `EnvironmentVariables` dict,
  systemd's `Environment=`/`EnvironmentFile=`, NSSM's `AppEnvironmentExtra`. Several contract flags
  have environment spellings (`--metrics` is `LLAMA_ARG_ENDPOINT_METRICS=1`), so a machine
  configured entirely this way is compliant with an argv that looks like it is missing everything.
  Read the environment before you call a flag absent.
- **Where the log goes**, from the same record — `StandardOutPath`/`StandardErrorPath`,
  `StandardOutput=`/`StandardError=`, `AppStdout`/`AppStderr`, or the `>` in a wrapper script.
  Also check whether `STEWARD_LOG_FILE` is set in the environment Steward will run in: it outranks
  the `log.path` you record, so the console would follow it instead.
- **What can measure this host.** macOS: `command -v macmon`. Linux: `nvidia-smi`, `rocm-smi`,
  `sensors`, `/proc/meminfo`. Windows: `nvidia-smi`, performance counters. Also check for `jq`, or
  whatever else your transform will need. See `references/host-collector.md`.

Then run the compliance check on what you found:

```
node <skill-dir>/scripts/steward-setup.mjs check-argv --argv-json '["/opt/homebrew/bin/llama-server", "--models-dir", "…"]'
```

Report the result as a short table: what is already compliant, what is missing, what you could
not determine. **A fully compliant machine is a real and common outcome** — say so plainly and
skip straight to the collector rather than inventing work.

**What counts as evidence.** This machine's current state is the listening process, the launch
mechanism's own record, and the tools `command -v` finds. Resolving a plist symlink into a dotfiles
repository is part of reading that record and is expected — see Pass 2. What is *not* current
state: git history, `.bak` and `.patch` files, scratch directories, and shell history. You may read
them, but whatever they tell you is **inferred** — say so, never present it as what the machine is
doing now, and never let it become the argv you record. If the record is not where the mechanism
keeps it, "not established" is the honest answer and a supported outcome. Stop looking once you
have the facts above; a wider search does not make a missing record appear.

**If nothing is listening and no mechanism describes one, that is the create path, not a failed
detection.** A machine with llama.cpp installed and no service is a normal starting point — say so
rather than hunting for a configuration that was never there or was deliberately removed. Propose
writing a launch record from the template in `references/llama-compliance.md`; ask the operator for
the model directory and the port rather than guessing them. Two things differ on this path:

- `llama.launchArgv` records what you **wrote**, not what you observed. Say that when you propose
  it, and confirm it against the live process once the service is up — that field is what every
  later drift notice is measured against.
- Registering the job (`launchctl bootstrap`) and starting it are service actions, each needing its
  own consent under Rule 4 — separately from consent to create the file.

## Pass 2 — Propose

Write out, in one message, every change you intend to make, grouped per file. For each one:

- the **exact file** it lands in, with the symlink resolved. If the path is a symlink into a
  dotfiles repository (`~/Library/LaunchAgents/*.plist` → `~/.dotfiles/…` is a common setup), say
  so explicitly: the edit lands in version control the operator will want to review and may
  resync onto other machines.
- a **before/after or diff** of the change itself, not a description of it.
- the **backup** you will take first, and the **exact command that reverts it**.
- whether applying it **requires restarting the service**. A restart unloads every resident model
  and drops in-flight requests, including any Pi session currently talking to this server. Name
  the loaded models if you can (`curl -s http://127.0.0.1:8080/v1/models`).

Prefer the smallest change that satisfies the contract. In particular, prefer moving a log out of
`/tmp` (macOS deletes `/tmp` files untouched for about three days, so a router stopped over a long
weekend loses its log) — but propose it, do not assume it, and mention rotation while you are
there since nothing rotates this file.

## Pass 3 — Consent

Ask per mutation, not once for the set. Applying two of three approved edits and skipping the
third is fine; applying an unapproved one is not. A restart is its own consent, separate from the
edit that motivates it.

If the operator declines a change, record the machine as it is: an unmet contract line becomes a
notice in the dashboard pointing at the fix, which is a perfectly good outcome. Do not write a
`steward.json` that claims something you did not do.

## Pass 4 — Apply

Back up first, then edit, then reload. `references/llama-compliance.md` carries the per-mechanism
edit and reload commands.

If a step fails partway through, **stop and say exactly what state the machine is in** — which
edits landed, whether the service is currently up or down, and the command that restores the
backup. Never leave the service down without saying so. If a reload fails, restoring the backup
and reloading again is usually the right first move; propose it.

## Pass 5 — Collector, control, artifact, verify

**Collector.** Author a wrapper that emits the fixed stream contract — one
`steward.hostmetrics/1` JSON object per line, forever, on stdout. Get consent before installing
anything. The recipes and the two traps that silently produce zero readings are in
`references/host-collector.md`. Prove it before you record it:

```
node <skill-dir>/scripts/steward-setup.mjs probe-collector \
  --command-json ./collector.json --seconds 6 --topology unified --interval-ms 1000
```

**Control.** Record `start`/`stop`/`restart` as argv arrays — no shell string, no `&&`. See
`references/service-control.md`, which also explains why launchd's stop must be `kill SIGTERM`
and not `bootout`.

**Artifact.** Build a proposal document (the schema is in `references/steward-json.md`), show the
operator the diff, and only then write it:

```
node <skill-dir>/scripts/steward-setup.mjs plan  --input /tmp/steward-proposal.json   # writes nothing
node <skill-dir>/scripts/steward-setup.mjs apply --input /tmp/steward-proposal.json
```

`plan` derives the consent hashes and prints the diff against whatever is there today. `apply`
backs the old file up, writes the new one atomically at mode `600`, and prints the revert
command. Never hand-write the `consent` map: a hash that does not match its command reads to
Steward as a command nobody approved, and it fails silently — dark gauges, missing buttons.

**Verify.** Finish by measuring, not asserting:

```
node <skill-dir>/scripts/steward-setup.mjs verify --pid <listening-pid> --plist ~/Library/LaunchAgents/<label>.plist
```

This re-reads the artifact exactly as Steward does (ownership, mode, schema, consent), re-checks
the recorded argv, diffs it against the live process, looks for evidence of **both** streams in
the log file, and runs the collector for real.

## Pass 6 — Report

Close with a short, honest summary:

- what is **live** now — each contract line, each panel it feeds;
- what is **still missing**, and why (declined, unsupported on this platform, no tool available);
- every file you changed, with its backup path and revert command;
- anything you could not determine.

If the operator later edits the plist or unit by hand, Steward notices: it diffs the live process
argv against the recorded one on every poll and raises a drift notice pointing back here. Tell
them that — it is why re-running this skill is cheap and expected.
