/**
 * The `/initialize-steward` instructions.
 *
 * This used to be a skill — a `SKILL.md` with four reference files, ~770 lines
 * of procedure and mechanism. It was replaced because the procedure turned out
 * to be scaffolding a capable model supplies on its own: across live runs the
 * model consistently detected, proposed and gated consent correctly without
 * being told the shape of those steps, and the per-mechanism launchd/systemd
 * recipes were describing a domain it already knows better than the prose did.
 *
 * What survives is the part a model cannot derive: the failures that leave a
 * machine looking healthy. Each item under "What will lie to you" is a case
 * where trying the obvious thing produces no error — an empty log on a running
 * server, a 400 that means two different things, a consent hash mismatch that
 * silently blanks the dashboard. A model self-corrects from a stack trace; it
 * cannot self-correct from silence, so those are written down and the rest is
 * not.
 *
 * It is delivered as a command rather than a prompt template because the helper
 * script's absolute path is only known at runtime — the package can be
 * installed anywhere — and templates substitute positional arguments only.
 */

import { join } from "node:path";

/** Absolute path of the helper, resolved against this module's own location. */
export function setupScriptPath(): string {
  return join(import.meta.dirname, "steward-setup.mjs");
}

/**
 * The instructions, with `scriptPath` written into the two commands that need
 * it. Exported separately from the path so it can be tested without a real
 * install layout.
 */
export function buildInitPrompt(scriptPath: string): string {
  return `You are an expert at managing operating systems and services. Set this machine up so that
**Steward** — a Pi plugin that runs a local dashboard for monitoring \`llama.cpp\` — can do its job.

Work in order: find out what is true, show me what you would change, ask before each change, apply
only what I approve, then prove the result. Detection is read-only.

## What Steward needs to work

It reads exactly one file, \`$STEWARD_CONFIG\` if set and non-empty, otherwise
\`~/.config/steward/steward.json\`, and trusts nothing else about this machine. For each capability
below, establish whether this machine already delivers it, and propose the smallest change if not.

1. **A model catalogue, and load/unload.** \`llama-server\` must run in **router mode** — serving a
   models directory and/or a preset file, with no \`-m\`/\`--model\`/\`-hf\`. Pi's llama.cpp provider
   throws outright on a single-model server.
2. **Throughput and request counters.** These come from llama.cpp's Prometheus \`/metrics\`, which is
   **off by default**.
3. **Per-slot context fill and the busy count.** From \`/slots\`, on unless disabled.
4. **A log console.** One file containing the server's **complete** output — see the traps below.
5. **A reachable loopback base URL.**
6. **Host metrics.** Steward spawns one long-lived command you nominate and reads **NDJSON on its
   stdout**, one object per line forever: \`{"schema":"steward.hostmetrics/1","ts":<epoch ms>,…}\`
   with \`gpuUtil\`, \`cpuUtil\` as fractions 0..1, \`gpuTempC\`, \`cpuTempC\`, \`ramUsedGB\`, \`ramTotalGB\`.
   Every field is \`number|null\`; \`null\` means "this machine cannot measure it" and is never a zero.
7. **Start / stop / restart**, recorded as argv arrays. There is no shell: no pipes, no \`&&\`, no
   \`~\`, no \`$UID\` — write absolute paths and real numbers.

## What will lie to you

These are the failure modes you cannot detect by trying them, because each one leaves a machine
that looks healthy. Everything else here you can verify yourself; these you cannot.

- **\`--log-file\` corrupts the log in router mode.** It is a real, documented flag, which is why it
  looks right. The router copies it into every child, each opens it truncate-not-append, and they
  write at independent offsets. Never propose it.
- **stdout alone gives you an empty log.** llama.cpp writes every levelled line — including every
  error — to **stderr**, and only the forwarded child lines to **stdout**. Redirecting stdout only
  yields a running server with a silent, often 0-byte log. Both streams must reach **one** file.
  Confirm it against the running process's file descriptors, not only the launch record.
- **\`/metrics\`, \`/slots\` and \`/props\` return 400 both when the flag is missing and when no model is
  loaded.** They cannot tell you whether the server is configured correctly. Determine compliance
  from the **launch arguments**, never from a request.
- **A hand-written consent hash fails silently.** Steward runs only commands whose sha256 it has
  recorded; a mismatch produces no error, just dark gauges and missing buttons. Always derive it
  with the helper below — never write that map yourself.
- **Consent covers the argv, not the contents of whatever it points at.** Record the collector as a
  self-contained command — \`["sh","-c","…pipeline…"]\` — never as a path to a script you wrote. A
  recorded script path hashes only the path, so its contents can then change without invalidating
  the consent, which is the entire point of the gate. A script file looks tidier and is a valid
  argv array, which is exactly why this one is easy to get wrong.
- **\`launchctl bootout\` unregisters the job**, so Steward's Start stops working afterwards. Stop
  must leave the job registered — \`launchctl kill SIGTERM gui/<uid>/<label>\`.
- **On unified memory (Apple Silicon) there is no VRAM figure to report.** Record
  \`memoryTopology: "unified"\` with RAM only. Any VRAM number there is invented.
- **\`STEWARD_LOG_FILE\`, if set, overrides the log path you record**, and \`/tmp\` logs are purged
  after about three days idle. Say which file the console will actually follow.

## Writing the config

Do not hand-write the artifact. Build a proposal — the same JSON without a \`consent\` map — and:

\`\`\`
node ${scriptPath} plan  --input ./proposal.json
node ${scriptPath} apply --input ./proposal.json
\`\`\`

\`plan\` validates, derives the consent hashes and shows the diff without writing. \`apply\` backs up,
writes atomically at mode 0600, and prints the revert command. Run \`help\` for the rest, including
\`probe-collector\`, which runs a candidate collector and proves it really streams — do that before
recording one.

Proposal shape: \`memoryTopology\`, \`baseUrl\`, \`hostCollector{command,intervalMs}\`, \`log{path}\`,
\`control{start,stop,restart}\`, \`llama{launchArgv,mechanism,label}\`.

## Ground rules

- **Ask per change, not once for the set.** A restart is its own question, separate from the edit
  that motivates it — it drops every resident model and any in-flight request.
- **Back up before editing, and tell me the exact revert command.** If a path is a symlink into a
  dotfiles repo, say so: the edit lands in version control.
- **A missing setup is not damage.** If nothing is running and no service is defined, that is the
  create path — build one and ask me for the directory and port. Never restore a deleted or
  modified configuration from git, a backup, or shell history; that was someone's decision.
- **Current state is what is on disk and running now.** Anything you learn from history, backups or
  scratch files is inferred — label it, and never record it as this machine's configuration.
- **Say what you could not establish** rather than guessing, and finish by telling me plainly what
  is live and what is still missing.
`;
}
