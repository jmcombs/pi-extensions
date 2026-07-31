# Contract 3 — service control

Steward's Start / Stop / Restart buttons run the commands recorded in `steward.json`, and nothing
else. It never guesses a command at runtime and never derives one from a label.

## Shape

Each action is an **argv array**, run directly — there is no shell, so no pipes, no `&&`, no
globbing, no variable expansion. `~` is not expanded either: write absolute paths.

```json
"control": {
  "start":   ["launchctl", "kickstart", "gui/501/com.llama.router"],
  "stop":    ["launchctl", "kill", "SIGTERM", "gui/501/com.llama.router"],
  "restart": ["launchctl", "kickstart", "-k", "gui/501/com.llama.router"]
}
```

All three are required together. Steward drops a half-written block entirely. A machine where only
restart is safe is expressed by consenting to `restart` alone — the argv says what the machine
*can* do, the consent map says what the operator *approved*.

Substitute the real numeric uid (`id -u`); `$UID` is a shell variable and will not expand.

## launchd — use `kill`, not `bootout`, to stop

`launchctl bootout gui/<uid>/<label>` **unregisters** the job. After it, `kickstart` fails with
"no such process" and Start is dead until something bootstraps the plist again — so a Stop from
the dashboard would leave the operator unable to Start from the dashboard.

`launchctl kill SIGTERM gui/<uid>/<label>` signals the running process and leaves the agent
registered, so `kickstart` still works afterwards. That is the pair to record.

`kickstart -k` is restart: it kills the job and starts it again in one step, in place.

If the agent sets `KeepAlive`, launchd relaunches it after a stop. Re-polling then shows
"running", which is indistinguishable from a stop that failed. Read `KeepAlive` from the plist
during detection, and if it is enabled, tell the operator that Stop will not keep the service
down.

## systemd — UNVERIFIED

```json
"start":   ["systemctl", "--user", "start",   "llama-router.service"],
"stop":    ["systemctl", "--user", "stop",    "llama-router.service"],
"restart": ["systemctl", "--user", "restart", "llama-router.service"]
```

Drop `--user` for a system unit — but a system unit needs root or a polkit rule, and Steward runs
as the operator with no way to answer a password prompt. A `sudo` in the argv will hang on the
prompt and time out. If the unit is system-scope and passwordless control is not already
configured, record no control block and say why.

## Windows — UNVERIFIED

NSSM: `["nssm", "start", "<svc>"]`, `["nssm", "stop", "<svc>"]`, `["nssm", "restart", "<svc>"]`.
Plain services: `["sc", "start", "<svc>"]`, `["sc", "stop", "<svc>"]` — `sc` has no restart, so
recording one means recording a wrapper script, which reintroduces a shell. Service control needs
an elevated context; if the dashboard is not running elevated, the buttons will fail with access
denied every time. Prefer no control block over three buttons that cannot work.

## Docker — UNVERIFIED

`["docker", "start", "<ctr>"]`, `["docker", "stop", "<ctr>"]`, `["docker", "restart", "<ctr>"]`.
These are genuinely start/stop/restart of the container, and they work — but a flag change still
requires recreating the container, which none of them do.

## Bare terminal

There is nothing to record. A `kill <pid>` is not a stop command — the pid changes on every
launch, so it would be wrong the first time the server restarts. Leave `control` out; the
dashboard shows a single setup affordance instead of three dead buttons. Offer to write a launchd
agent or systemd unit as the fix.

## What the operator is agreeing to

Stop and Restart drop every resident model and every in-flight request, including any Pi session
talking to this server. Say that out loud when you propose the commands, and name the models that
are loaded right now if you can read them (`curl -s http://127.0.0.1:8080/v1/models`).

Steward re-polls after any control action rather than trusting the exit code, because a
`KeepAlive` job exits 0 from a stop and comes straight back.
