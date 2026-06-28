# Phase Build Prompt — `@jmcombs/pi-headroom`

Replace every `[N]` with the phase number being built. Send to a **build agent** in the
`pi-extensions` repo. The builder implements one phase, proves every gate, opens a PR, and **stops**.

---

You are implementing **Phase [N]** of `docs/headroom/PLAN.md` in the `pi-extensions` repo. Implement
that phase's Actionable TODOs **exactly**, prove every Testing Gate with **real captured output**,
open a PR with green CI, and **stop**. You do **not** merge and you do **not** tick checkboxes — a
separate adversarial verifier does that, and the user approves the merge.

## 1. Read the spec, in full, first
- Read **`docs/headroom/PLAN.md`** end to end: the Locked Decisions (LD1–LD7), Git & PR conventions,
  Phase **[N]**'s Objectives / Architectural Constraints / Actionable TODOs / Testing Gates, and
  Appendices A (reuse map), B (ADR/deviation policy), C, D (Definition of Done).
- Read **`AGENTS.md`**, **`CONTRIBUTING.md`**, **`TEMPLATE.md`**. Confirm Phase [N]'s **Entry** phases
  are already **merged to `main`** before you start.
- **TODO file paths and names are literal specs.** Build exactly what they say, where they say it.

## 2. The deviation rule is STRICT (Appendix B)
- You are **not** authorized to deviate, relocate, rename, or invent an ADR. There is no standing ADR
  mechanism.
- If a TODO or Locked Decision cannot be implemented as written: **exhaust all reasonable paths**
  (different API usage, ordering, reading the `headroom-ai` / `@earendil-works/*` types empirically,
  etc.), documenting what you tried. If still blocked, **STOP and escalate to the user** with the
  evidence. Do **not** work around it and continue. A roadblock is a pause point, never a detour.

## 3. Branch first — before writing any code
- `git switch -c <type>/headroom-phase-[N]-<slug>` using Phase [N]'s branch type from the summary
  table. Confirm with `git branch --show-current`. **Never commit to `main`.**
- **Symmetry:** branch prefix = commit type (`feat/` → `feat(headroom): …`).

## 4. Implement the TODOs (Phase [N] scope only)
- Do not pull work forward from later phases. Stay within Phase [N].
- Match surrounding idiom; **reuse** the Appendix A patterns rather than hand-rolling
  (`AuthStorage` from `tavily-search`, `registerTool`/renderers from `better-toolsy`, the
  `_template` scaffold + smoke-test shape).
- **Verify library behavior empirically** (run it, read the installed `.d.ts`) — never from memory.
  The Python proxy is the engine; the npm SDK is a thin client (see PLAN Phase 0 findings).

## 5. Standards (hard rules)
- `headroom-ai` in `dependencies`; Pi runtime + `typebox` stay in `peerDependencies: "*"` (LD5).
- Conventional Commits scoped to `headroom`, atomic (ideally one gate-worth per commit).
- **Never disable, comment out, or weaken a check, test, or gate to make it pass.** Never edit
  `.github/CODEOWNERS`, CI job names, or the ruleset.
- The extension must never throw into the agent loop (LD3) and never manage the proxy (LD4).

## 6. Prove every Testing Gate (real output only)
Run **each** row of Phase [N]'s Testing Gates and capture the **real** output (stdout/stderr/exit
code). A gate passes only if real output matches Expected.
- **AUTO** gates: run the exact command, including `npm run check` (the full quality gate).
- **HEADLESS** gates: start the proxy (`~/.headroom-venv/bin/headroom proxy --port 8787`; confirm
  `GET http://127.0.0.1:8787/health` → `"status":"healthy"`), then run the ad-hoc Node script that
  imports your exported functions and capture output. Test the proxy-**down** rows too.
- **MANUAL** gates: run `pi -e ./packages/headroom`, exercise the step, and **capture the real
  result** (paste the transcript / screenshot). The verifier cannot self-run these; if you do not
  provide real evidence the verifier will mark the gate UNVERIFIED and the phase will not pass.

If the **same** gate fails **3 times**, stop and escalate to the user with the evidence — do not loop
or redesign the phase.

## 7. Finish — open a PR and STOP
- Push the branch and open a PR (Conventional Commit title, e.g. `feat(headroom): <phase title>`).
  Ensure the three required checks are green: `Quality Gate (Node 22)`, `Quality Gate (Node 24)`,
  `Commit Messages`.
- **Do not merge. Do not edit `docs/headroom/PLAN.md`. Do not tick any checkbox.**
- Post a final report containing:
  - PR number / branch name.
  - Each Testing Gate: Method, the exact command, and the real observed output (AUTO/HEADLESS); for
    MANUAL, the captured transcript/screenshot evidence.
  - `npm run check` result (exit code + tail).
  - One line per Actionable TODO confirming the literal path/name now exists.
  - Anything you could not complete as specified → an explicit escalation block (per §2), not a
    silent workaround.

Hand off to the verifier (`docs/prompts/verify-phase.md`).
