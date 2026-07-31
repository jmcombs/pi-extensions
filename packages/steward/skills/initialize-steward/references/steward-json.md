# Contract 4 — the `steward.json` artifact

Steward reads `$STEWARD_CONFIG` if it is set and non-empty, otherwise
`~/.config/steward/steward.json`. Honour the same precedence: if the operator has
`STEWARD_CONFIG` set, that is the file they mean.

## Write it with the helper, not by hand

```
node scripts/steward-setup.mjs plan  --input ./proposal.json    # validates, shows the diff, writes nothing
node scripts/steward-setup.mjs apply --input ./proposal.json    # backs up, writes atomically at 0600
```

The **proposal** is a `steward.json` without its `consent` map. `plan` and `apply` derive consent
from the exact commands the proposal declares, so a hash can never disagree with the command it
approves. Both accept `--config <path>` to target a file other than the default; `--input -`
reads the proposal from stdin.

`apply` creates the parent directory at `0700`, copies any existing config to
`steward.json.bak.<timestamp>`, writes through a temp file in the same directory and `rename`s it
into place (so a reader never sees a half-written config), and sets mode `0600`. It refuses to
overwrite a file owned by another user. It prints the exact revert command.

## The proposal

```json
{
  "memoryTopology": "unified",
  "baseUrl": "http://127.0.0.1:8080",
  "hostCollector": {
    "command": ["sh", "-c", "…"],
    "intervalMs": 1000
  },
  "log": { "path": "/Users/you/Library/Logs/llama/router.log" },
  "control": {
    "start":   ["launchctl", "kickstart", "gui/501/com.llama.router"],
    "stop":    ["launchctl", "kill", "SIGTERM", "gui/501/com.llama.router"],
    "restart": ["launchctl", "kickstart", "-k", "gui/501/com.llama.router"]
  },
  "llama": {
    "launchArgv": ["/opt/homebrew/bin/llama-server", "--models-dir", "…", "--metrics", "--host", "127.0.0.1", "--port", "8080"],
    "mechanism": "launchd",
    "label": "com.llama.router"
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `memoryTopology` | **yes** | `"unified"` or `"discrete"`. Chooses which host gauges exist. Anything else and Steward refuses the **whole** file. |
| `hostCollector.command` | **yes** | Argv of the long-lived NDJSON producer. `command[0]` is the program. |
| `hostCollector.intervalMs` | **yes** | The cadence the collector actually keeps. This is the staleness clock. |
| `baseUrl` | no | Where `llama-server` listens, as observed. Recorded for reference and for drift; inside Pi, the provider's own connection still wins at resolution time, and a mismatch is worth surfacing. |
| `log.path` | no | Absolute path of the combined stdout+stderr redirect. Omitting it is honest when there is no log; Steward falls back to `STEWARD_LOG_FILE` and then to the platform convention. |
| `control` | no | All three of `start`, `stop`, `restart`, or nothing. |
| `llama.launchArgv` | no | The argv observed at setup. Steward diffs the live process against it on every poll and raises a drift notice on a mismatch. Omitting it means no drift checking. |
| `llama.mechanism`, `llama.label` | no | Descriptive only (`"launchd"`, `"gui/501/com.llama.router"`), so a notice can point at the right file. |

Unknown keys are ignored, so an artifact may carry fields other tools own.

`hostCollector` is the only block whose absence or malformation rejects the entire file. A
half-written `control`, `log` or `llama` block is dropped with a warning and the rest of the
config still loads — which means a machine can be usefully connected before everything is
configured.

## Consent

`consent` maps `sha256(argv.join(" "))` → `true`, one entry per command Steward may run: the
collector, and each control action.

This is a code-execution surface. The gate exists so the operator knows what runs, and it is
bound to the exact command — editing a command invalidates its hash, and Steward then refuses to
run it. That refusal is **silent by design at the execution layer** (the collector is not spawned,
the button is not offered); the dashboard surfaces it as a consent-drift notice. A hand-written
hash that does not match its command is therefore indistinguishable from a command nobody
approved. Never write this map yourself.

Steward also refuses the file outright if it is **not owned by the current user** or is
**world-writable**, because anyone who can write it can choose what Steward executes.

The join is on single spaces, so a hash stays reproducible by hand:

```
printf '%s' 'launchctl kickstart -k gui/501/com.llama.router' | shasum -a 256
```

## After writing

```
node scripts/steward-setup.mjs verify --pid <listening-pid> --plist <plist>
```

`verify` re-reads the artifact with the same ownership, mode, schema and consent rules Steward
applies, re-checks the recorded launch argv, diffs it against the live process, looks for evidence
of both streams in the log, and runs the collector for real. Use `--skip-collector` when you have
already probed it and only want the artifact re-checked.
