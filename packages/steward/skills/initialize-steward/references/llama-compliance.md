# Contract 1 — making llama.cpp Steward-compliant

## The contract

| # | Requirement | Default | Why Steward needs it |
| --- | --- | --- | --- |
| 1 | **Router mode** — no `-m` / `--model` / `-hf`; use `--models-dir` and/or `--models-preset` | n/a | Pi's llama.cpp provider throws outright on a single-model server, and Steward's model catalogue is the router's |
| 2 | **`--metrics`** present | **off** | throughput, tokens/sec, requests in flight and queued |
| 3 | **slots not disabled** — `--no-slots` absent | on | per-slot context fill and the busy count |
| 4 | **stdout AND stderr redirected to one file** | n/a | the log console |
| 5 | **reachable loopback base URL** | `127.0.0.1:8080` | everything |

`--props` is **not** required: `GET /props` works without it. The flag only enables `POST /props`,
and Steward only reads. `--jinja` matters for correct chat templating but is on by default and is
not Steward's business.

## Detect from the argv, never from the endpoints

In router mode with no model loaded, `/metrics?model=`, `/slots?model=` and `/props?model=` all
return HTTP 400, in three different shapes. A 400 means "no model", not "no flag" — a machine with
`--metrics` enabled returns exactly the same 400 as one without it. Every compliance verdict comes
from the launch argv.

Read the argv from the launch mechanism's own record where you can. `ps -ww -o args= -p <pid>` is
the universal fallback but joins the argv on spaces, so a quoted value containing a space (an
`--alias "Fast Model"`) comes back indistinguishable from two arguments.

```
node scripts/steward-setup.mjs check-argv --argv-json '["…","…"]'
node scripts/steward-setup.mjs check-argv --pid 65363
```

## The log redirect — the part that is easy to get wrong

llama.cpp has two sinks and splits its output between them:

- **stderr** carries every levelled line (`I`, `W`, `E`) — which is *all* of the router's own
  output, including every error. Measured on a bare router: 18 levelled lines on stderr, 0 on
  stdout.
- **stdout** carries the no-level output, which is how the router forwards its child servers'
  logs, each prefixed with the child's port: `[54241] …`.

Capture one and you lose the other half of the story. stdout-only is the worse failure — it looks
alive (child chatter flows) while every error is thrown away.

`--log-file` is **not** the answer, however much it looks like it. The router does not strip
`LLAMA_ARG_LOG_FILE` from the arguments it hands its children, so every child inherits the flag,
and the file is opened with truncate-not-append. The router and N children then each truncate the
same file and write at independent offsets. The result is duplicated and corrupted lines, and it
gets worse the more models are loaded. There is no structured or JSON log mode to fall back on —
`--log-format json` was removed upstream — so a plain combined redirect is the whole interface.

You can confirm capture from the file itself, which `verify` does automatically:

- a line matching `^\d+\.\d\d\.\d\d\d\.\d\d\d [A-Z] ` (`0.08.955.549 I srv load: …`) proves
  **stderr** reached the file;
- a line matching `^\[\d+\] ` proves **stdout** reached it — but only appears once a child server
  has been spawned, so its absence on a router that has never loaded a model is inconclusive.

Prefer a durable path. macOS deletes `/tmp` files whose access, modification and change times all
exceed about three days, so a router idle over a long weekend loses its log; `~/Library/Logs/llama/router.log`
survives. Nothing rotates this file — mention that, and let the operator decide.

## macOS / launchd — VERIFIED

This is the only path exercised end to end.

**Detect (read-only)**

```
launchctl list | grep -i llama                    # label + pid
launchctl print gui/$UID/<label>                  # program, arguments, stdout/stderr path, state
ls -l ~/Library/LaunchAgents/<label>.plist        # is it a symlink?
```

`launchctl print` gives the live truth; the plist gives what will be true after the next load.
Read both — a hand-edited plist that has not been reloaded is exactly the drift Steward reports.

**The plist shape that satisfies the contract**

```xml
<key>ProgramArguments</key>
<array>
  <string>/opt/homebrew/bin/llama-server</string>
  <string>--models-dir</string>  <string>…</string>
  <string>--metrics</string>
  <string>--host</string>        <string>127.0.0.1</string>
  <string>--port</string>        <string>8080</string>
</array>

<key>StandardOutPath</key>   <string>/Users/…/Library/Logs/llama/router.log</string>
<key>StandardErrorPath</key> <string>/Users/…/Library/Logs/llama/router.log</string>
```

Both keys, one path. launchd appends across restarts, so a restart is not a rotation and the
console simply gets a fresh banner.

**Apply**

1. Resolve the symlink: `readlink -f ~/Library/LaunchAgents/<label>.plist`. If it points into a
   dotfiles repository, tell the operator before editing — the change lands in version control and
   may resync onto their other machines.
2. Back up the **resolved** file: `cp <resolved> <resolved>.steward.bak`.
   Revert: `cp <resolved>.steward.bak <resolved>` then reload.
3. Edit the resolved file.
4. Reload — this is a separate consent, because it drops loaded models and in-flight requests:
   `launchctl kickstart -k gui/$UID/<label>`.

`kickstart -k` restarts in place and keeps the job registered. `bootout` + `bootstrap` also works
but unregisters the job in between, so a failure in the middle leaves the service both down and
unregistered. Prefer `kickstart -k`.

**Verify**

```
node scripts/steward-setup.mjs check-argv --pid $(lsof -nP -iTCP:8080 -sTCP:LISTEN -t)
node scripts/steward-setup.mjs verify --plist ~/Library/LaunchAgents/<label>.plist
```

If the agent has `KeepAlive` enabled, a stop can be followed by an automatic relaunch, so a
re-poll showing "running" does not distinguish "stop failed" from "stopped and came back". Read
`KeepAlive` out of the plist during detection and say which case applies.

## Linux / systemd — UNVERIFIED

No Linux hardware was available. Detect and propose; prefer letting the operator apply.

**Detect**

```
systemctl list-units '*llama*'                    # add --user for a user unit
systemctl show -p FragmentPath,ExecStart,StandardOutput,StandardError <unit>
systemctl cat <unit>
```

`--user` versus system scope changes every command below and whether `sudo` is needed. Establish
which before proposing anything.

**Apply** — use a drop-in, never an edit of the vendor unit, because a drop-in is reversible by
deleting one file:

```
systemctl edit <unit>        # creates …/<unit>.d/override.conf
```

```ini
[Service]
ExecStart=
ExecStart=/usr/local/bin/llama-server --models-dir … --metrics --host 127.0.0.1 --port 8080
StandardOutput=append:/var/log/llama/router.log
StandardError=append:/var/log/llama/router.log
```

The empty `ExecStart=` is required: without it the new line is *appended* to the existing one
rather than replacing it. Then `systemctl daemon-reload` and `systemctl restart <unit>`.
Revert: delete `override.conf`, `daemon-reload`, restart.

Journald is the systemd default and is **not** a file Steward can follow. Either redirect both
streams to one file as above, or leave the log unconfigured and tell the operator the console
will be empty. Do not record a `log.path` that journald is not writing.

## Windows — UNVERIFIED

**NSSM.** `nssm get <svc> AppParameters` / `AppStdout` / `AppStderr` / `AppDirectory` to detect.
Capture every prior value before changing anything — that record *is* the revert path, since
`nssm set` has no undo. Then `nssm set <svc> AppParameters "… --metrics"`, `nssm set <svc>
AppStdout <path>`, `nssm set <svc> AppStderr <path>` — the same path for both — and `nssm restart
<svc>`.

**Plain `sc` / Task Scheduler.** `sc qc <svc>` and `schtasks /query /xml` show the command, but
neither redirects output. These usually wrap a `.cmd`; the contract is met by adding `> "<path>"
2>&1` inside that wrapper. Back the wrapper up first.

Service control needs an elevated shell. Say so before proposing, rather than after it fails.

## Docker — UNVERIFIED

`docker inspect <ctr>` gives `.Args`, `.Config.Cmd` and `.LogPath`. A running container's
arguments **cannot** be changed — the flags live in the `docker run` line or the compose file, and
applying a change means recreating the container. Propose the edited `docker run` / compose
service and let the operator recreate it themselves; do not recreate a container on their behalf.

Container logs are the daemon's, not a file the operator owns; `.LogPath` is readable but its
format depends on the logging driver and is not the combined text stream Steward follows. The
honest outcome here is usually a bind-mounted log directory plus a redirect inside the container,
or no log source at all.

## Bare terminal

No persistent configuration to edit, and normally no redirect. Offer to write a launchd agent or a
systemd unit; if the operator declines, they can still get a log with
`llama-server … > ~/Library/Logs/llama/router.log 2>&1` — note the `2>&1` **after** the `>`, which
is what puts both streams in one file.
