/**
 * The `/steward_initialize` instructions.
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

Find out what is true, tell me briefly, propose a plan, get my approval, carry it out, prove it
worked. Detection is read-only. Nothing is applied without my approval.

## How to report

**Be brief.** No tables of evidence, no capability scorecards, no recap of the commands you ran.
I want to read the answer, not the investigation. Two short sections:

**Current state** — a handful of lines. What is running, what already works, what does not.
**Plan** — a numbered list, one line per change, each with the exact command or diff. Mark any
step that restarts the service or drops loaded models as **disruptive**.

Then ask exactly one question: **approve the whole plan, or go one change at a time?**

- If I approve the whole plan, carry it out end to end without stopping to re-ask. The plan told me
  what was disruptive, so approving it is my consent for those steps too. Report once at the end.
- If I ask to go one at a time, do that instead — one change, then stop.
- Either way: if reality turns out differently from the plan mid-flight — a command fails, a file is
  not what you expected, a step would now do something the plan did not describe — stop and tell me.
  Approval covers the plan you showed me, not a different one.

## First, learn the machine

Nothing below names an operating system, a service manager, or a sensor tool, because you are
better at recognising those than any list I could write. Establish them yourself before you propose
anything:

- **The OS and the hardware** — enough to know whether the GPU has its own memory or shares the
  system's.
- **How this machine supervises long-running services**, and how \`llama-server\` is started under it
  today — the file or unit that defines it, the label it runs as, how it is stopped and reloaded. If
  nothing supervises it, say so: that is the create path, and you write the definition.
- **What can measure this host** — whichever tool is already installed for GPU, CPU and temperature.

Say what you found in one line. Then translate every requirement below into that environment's own
terms. The requirements are the contract; the mechanism is yours to choose.

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
5. **A reachable loopback base URL — and it must be the one Pi already uses.**
   Find where Pi's \`llama.cpp\` provider points (\`LLAMA_BASE_URL\` in its provider
   auth, or the provider's \`baseUrl\`) **before** you propose anything. If the
   server you are configuring is not at that address, Pi cannot talk to it: chat
   fails with "llama.cpp unavailable" while Steward reports a perfectly healthy
   router, which is worse than both being broken because nothing looks wrong.
   Do not finish with the two diverged. Say so plainly and ask which way to
   reconcile — move Pi's provider to this server, or move this server to Pi's
   address — then carry out the answer.
6. **Host metrics.** Steward spawns one long-lived command you nominate and reads **NDJSON on its
   stdout**, one object per line forever: \`{"schema":"steward.hostmetrics/1","ts":<epoch ms>,…}\`
   with \`gpuUtil\`, \`cpuUtil\` as fractions 0..1, \`gpuTempC\`, \`cpuTempC\`, \`ramUsedGB\`, \`ramTotalGB\`.
   Every field is \`number|null\`; \`null\` means "this machine cannot measure it" and is never a zero.
   **Use the tool this machine already has before writing your own.** Whatever it is, it will
   report figures a hand-rolled collector cannot reach — temperature in particular usually needs
   privileged access or a vendor tool. Assembling one from general-purpose utilities works and
   silently gives up those readings, leaving permanent no-reading gauges on a machine that could
   have filled them. Check first; say which tool you found, or that you found none and what that
   costs.
7. **Start / stop / restart**, recorded as argv arrays. There is no shell: no pipes, no \`&&\`, no
   \`~\`, no \`$UID\` — write absolute paths and real numbers.

## Pi will not notice what you changed

Pi reads its provider config **once, at startup**, and keeps it in memory. If you
edit \`LLAMA_BASE_URL\` — or restart llama.cpp underneath the open connection —
the running session does not find out. Chat keeps dialling the old address and
fails with "Connection error" while the server answers \`curl\` perfectly.

There is no reload for this. So when you have changed the provider URL or
restarted the server, **end by telling me to restart Pi**, in those words, as the
last line of your report — not as a footnote. Say what will not work until I do:

> Pi is still using the old address in this session. Restart Pi for chat to
> reach the server.

A setup that reports success and leaves chat broken reads as "the setup broke
Pi". The one sentence is what makes it read as "the setup finished, and here is
the last step."

## What will lie to you

These are the failure modes you cannot detect by trying them, because each one leaves a machine
that looks healthy. Everything else here you can verify yourself; these you cannot.

- **\`--log-file\` corrupts the log in router mode.** It is a real, documented flag, which is why it
  looks right. The router copies it into every child, each opens it truncate-not-append, and they
  write at independent offsets. Never propose it.
- **stdout alone gives you an empty log.** llama.cpp writes every levelled line — including every
  error — to **stderr**, and only the forwarded child lines to **stdout**. Redirecting stdout only
  yields a running server with a silent, often 0-byte log. Both streams must reach **one** file, however this
  machine's service manager expresses that. Confirm it against the running process's file
  descriptors, not only the launch record — the descriptors are the same question on every platform,
  and they are the answer that cannot be stale.
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
- **Restarting a service does not reload its definition.** Every service manager keeps the loaded
  job separate from the file that describes it, and the restart verb usually acts on the loaded
  copy: the process comes back with a new pid and exit 0, running the *old* definition, and nothing
  in the output says so. Measured on one machine whose service file had gained \`--metrics\` and a
  second redirect while the running process had neither and its log stayed at 0 bytes.
  Find this machine's reload path and use it. Then **prove the change reached the process** — read
  the live argv and the live file descriptors, not the file you edited. A restart that reports
  success is not evidence.
- **A stop that deregisters the service breaks Start.** Some managers have two kinds of stop: one
  halts the process and leaves the job known, the other removes it entirely. Steward's Stop must be
  the first kind, or Start has nothing left to start. Record the halting form, not the removing
  one — and if reloading a definition requires the removing form, that is a separate step you
  perform yourself, not the command you record.
- **On unified-memory hardware there is no VRAM figure to report.** Where the GPU shares system
  memory there is no separate pool and no readable ceiling, so record \`memoryTopology: "unified"\`
  with RAM only. Any VRAM number there is invented. A discrete GPU is the other case, not the
  default — decide from the hardware you found, not from the operating system.
- **\`STEWARD_LOG_FILE\`, if set, overrides the log path you record.** Say which file the console will
  actually follow. And prefer a durable location for the log over a temporary one: systems clear
  their scratch directories on their own schedule, and a server stopped over a long weekend can come
  back to find its history gone.

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

- **Name the disruption in the plan, not after it.** A restart drops every resident model and any
  in-flight request — say so on the line that proposes it, so approving the plan is informed.
- **Back up before editing, and tell me the exact revert command.** An exact command is one you
  have checked will run on this machine in its current state — not a choice between two forms you
  are unsure about. If you do not know which applies, find out before you offer it: a revert that
  errors when I reach for it is worse than saying you don't know.
  If a path is a symlink into a dotfiles repo, say so: the edit lands in version control.
- **A missing setup is not damage.** If nothing is running and no service is defined, that is the
  create path — build one and ask me for the directory and port. Never restore a deleted or
  modified configuration from git, a backup, or shell history; that was someone's decision.
- **Current state is what is on disk and running now.** Anything you learn from history, backups or
  scratch files is inferred — label it, and never record it as this machine's configuration.
- **Say what you could not establish** rather than guessing, and finish by telling me plainly what
  is live and what is still missing.
`;
}
