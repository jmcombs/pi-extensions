# Migration & Revision Plan: pi-qwen-guard

**Status**: Draft — For review  
**Date**: 2026-06-01  
**Owner**: Jeremy Combs (with AI assistance)  
**Related**: PR #56 (feat(qwen-guard): initial release)

## 1. Background & Research Findings

### Current Implementation (v0 in `feat/qwen-guard`)

- Lightweight guard that detects Qwen models via `ctx.model.id`.
- On `before_agent_start`, appends a block of rules to the system prompt:
  - Max ~70-80 lines per response
  - Prefer `edit` tool
  - Small logical chunks
  - Mandatory `🛡️ pi-qwen-guard: ✅ Chunk complete. File is now X lines.` signal
  - Explicit permission to continue without waiting for user input
- Goal: Prevent Ollama streaming terminations ("Stream ended without finish_reason").

### Research Summary (r/LocalLLaMA, GitHub, Pi community — 2026)

- Qwen3.6 (especially 27B/35B coding-optimized and MoE variants) on Ollama is one of the strongest local models for agentic coding when paired with Pi.
- The exact streaming errors the guard targets are **very common** with these models.
- **Community consensus**: Long lists of "do X, never do Y" rules injected into the system prompt have limited effectiveness. Models (especially eager coding variants) tend to ignore soft limits once they gain momentum on a large task.
- **Proven effective pattern** (widely recommended for Pi + Qwen3.6 + Ollama):
  - **Plan-first workflow** using an external `TODO.md` (or `task_plan.md`) artifact.
  - Silent project analysis.
  - Small, atomic, independently verifiable tasks.
  - **Explicit user approval** ("YES") before any code changes.
  - Execute **one task at a time**, update TODO, report completion, and **stop**.
  - If new work is discovered, add it to the TODO and re-ask for approval.
- This approach is more reliable than pure prompt-based chunking because it changes the _workflow_ rather than relying on the model to self-police line counts.
- Pure "max N lines + chunk complete" signals provide good **observability** but are insufficient as a standalone solution.
- **Instruction overload warning**: Very long rule blocks in the system prompt are often treated as boilerplate and reduce effectiveness. High-signal, concise instructions + external structure (TODO.md + gates) perform better.

**Existing Planning Tools in the Pi Ecosystem (researched June 2026)**

- **Plannotator** (`@plannotator/pi-extension`): Visual plan review tool. Intercepts plans and opens a UI (browser or VS Code webview) for annotation, diff review, and one-click approval/feedback. Powerful for collaboration and visual clarity, but introduces UI + setup overhead (this matches the user's experience of it feeling heavy).
- **planning-with-files** (OthmanAdi / @tomxprime): Comprehensive file-based system using `task_plan.md` + `findings.md` + `progress.md`. Includes Pi lifecycle hooks and persistent memory patterns. More complete than a simple TODO but carries some conceptual and file overhead.
- **Lightweight community `plan-first` SKILL.md files**: The most popular approach for local Qwen3.6 users. These are pure Markdown skills (often 80-150 lines) that implement the plan-first discipline directly in the prompt. No extra processes, no UI. Users place them in `~/.pi/agent/skills/plan-first/SKILL.md` or project `.pi/skills/`. Many variants exist (some viral ones from r/LocalLLaMA). These are the lowest-overhead option and what many people pair with Qwen3.6 + Pi for production work.

### Key Design Principles for Revisions

- Respect the original request: silent activation + visible `🛡️ pi-qwen-guard:` signals for observability.
- Prioritize **proven community patterns** over custom prompt engineering.
- Minimize instruction bloat in the injected system prompt.
- Keep the guard lightweight and "install and forget".
- Make the guard complementary to (not a replacement for) a dedicated lightweight `plan-first` skill.
- Maintain compatibility with the existing release process (target 1.0.0 via Release Please after manual OIDC bootstrap).

## 2. Goals of the Revision

1. Make the guard **actually effective** at preventing streaming terminations with Qwen3.6 + Ollama + Pi.
2. Align with real-world best practices instead of a home-grown rule set.
3. Avoid overloading the LLM with long instruction lists (per research).
4. Preserve (and improve) the excellent observability via the `🛡️ pi-qwen-guard:` prefix.
5. Position the package as a high-quality, production-ready extension that complements the Pi ecosystem (lightweight guard + recommended general planning skills).
6. Keep the change small enough that we can still deliver a revised 1.0.0 soon after the current feature PR lands.

## 3. Decisions from User Feedback (2026-06-01)

**1. Prompt Philosophy**  
A **general** lightweight plan-first skill/extension is strongly preferred over embedding heavy planning logic directly into the Qwen guard's system prompt injection.  
Reason: Avoids duplication, reduces instruction bloat in the guard, and lets users choose their preferred planning tool (or none). The guard should act as a **thin activator/nudger** for Qwen models rather than a full planning system.

**Recommended approach**:

- The guard remains very small.
- When a Qwen model is detected, it activates "Qwen-safe plan-first mode" with a short, high-signal directive.
- It encourages (and can lightly enforce) the use of a separate plan-first skill.
- Research shows the lightest and most popular options for Qwen3.6 users are simple community `plan-first` SKILL.md files (far lower overhead than Plannotator or even planning-with-files for many workflows).

**2. Length Target**  
Acceptable as long as the injected prompt does not degrade the model's ability to write high-quality code. Target: Keep the injected block concise (ideally under 15-20 lines of actual instructions).

**3. Signal Format**  
Keep the `🛡️ pi-qwen-guard:` prefix for all guard-originated progress signals. This provides excellent observability and user confirmation that the guard is active. The exact phrasing can evolve slightly (e.g., tying signals to TODO items when a plan-first workflow is in use).

**4. Scope for 1.0.0**  
The revised guard (with the new philosophy) **must be included** in the 1.0.0 release. We will not ship the original softer "chunk rules only" version as the first public release.

## 5. Proposed New Behavior (Aligned with Decisions)

**Role of the Guard**: Thin detector + activator + high-signal nudger. It does **not** contain a full planning system or duplicate general tools.

When a Qwen model (via Ollama) is detected:

- **Activation** (on `session_start`): One-time notification  
  `🛡️ pi-qwen-guard: Qwen3.6 incremental mode enabled`

- **Injected prompt** (on `before_agent_start`): A **short** (target < 18 lines), high-signal block that:
  - Declares that "Qwen-safe plan-first mode" is now active for this session.
  - Directs the model to use structured planning discipline: Create or maintain a `TODO.md` (or equivalent) containing small, atomic, independently verifiable tasks.
  - Requires explicit user approval before performing code changes.
  - Mandates working one task at a time, updating the plan file, and clearly signaling progress using the exact prefix `🛡️ pi-qwen-guard:`.
  - Strongly discourages the specific failure patterns observed in testing.

- The guard is a complete no-op for non-Qwen models.
- It is designed to work _with_ any general plan-first skill the user loads (lightweight community SKILL.md style is recommended for lowest overhead).

This keeps the guard small, respects the research on avoiding instruction overload, and maintains the desired observability prefix while delegating the heavy planning workflow to a separate, reusable skill.

## 6. Migration & Implementation Plan

### Phase 0: Preparation (Current State)

- [x] Research completed (including survey of existing planning tools: Plannotator, planning-with-files, and lightweight community plan-first SKILL.md files).
- [x] User decisions captured (general lightweight planning skill preferred; revised guard included in 1.0.0; keep `🛡️ pi-qwen-guard:` prefix; length acceptable if code quality is preserved).
- [ ] Finalize exact short injected prompt text (see draft in Section 7).

### Phase 1: Core Logic Changes (packages/qwen-guard/)

**Files to modify**:

- `index.ts` — Replace `QWEN_INSTRUCTIONS` with a much shorter, high-signal activation block (see draft in Section 7).
- `README.md` — Significant rewrite of "How It Works" and addition of "Recommended Companion Workflow" + comparison of planning tools.

**Tasks**:

1. Finalize and implement the short injected prompt (guard's only job is detection + activation of Qwen-safe plan-first discipline + strong nudging toward a separate lightweight skill).
2. Preserve activation notification and `🛡️ pi-qwen-guard:` prefix convention for all signals.
3. Update JSDoc header to reflect the new philosophy.
4. Run format + lint.
5. Ensure the guard stays extremely small (no embedded full planning logic).

**Commit style**: `fix(qwen-guard): thin Qwen detector + plan-first activation (research-aligned, low bloat)`

### Phase 2: Documentation & Messaging

- Rewrite `README.md` to accurately describe the new thin-activator role.
- Add sections:
  - "How It Works" (updated, shorter rules)
  - "Recommended Companion Workflow" (plan-first skills)
  - Brief comparison of existing options (lightweight SKILL.md vs Plannotator vs planning-with-files)
- Show realistic example signals using the `🛡️ pi-qwen-guard:` prefix.
- Keep the "just install and forget" tone while setting correct expectations.

**Commit style**: `docs(qwen-guard): update README for thin plan-first activator role`

### Phase 3: Testing & Validation (Critical)

- Primary test: Same Qwen3.6-27b-coding-optimized model + the original failing prompt from the transcript.
- Additional scenarios: Refactors, mixed model sessions, users with/without a plan-first skill loaded.
- Success bar:
  - Activation notification appears.
  - Model reliably uses `🛡️ pi-qwen-guard:` signals.
  - Dramatic reduction (ideally elimination) of streaming terminations on tasks that previously failed.
  - Model does not become overly timid or ask for unnecessary approvals on small changes.
- Capture raw session snippets for the release notes / PR description.

### Phase 4: Release Process Alignment

- The revised behavior will ship in 1.0.0 (per decision).
- Current feature PR (#56) can land as-is or with these changes as a fast follow-up commit on the same branch.
- The upcoming Release Please 1.0.0 PR will carry the final revised guard.
- Clearly document the research-driven design and the "complementary skill" recommendation in the 1.0.0 release notes.

### Phase 5: Post-1.0.0 (Nice to Have)

- Consider publishing a first-party lightweight `plan-first` skill in this monorepo (or as `@jmcombs/pi-plan-first`).
- Optional: Add a tiny configuration mechanism later (e.g. environment variable or flag) if users want "strict chunk only" vs "plan-first nudge" behavior.

## 7. Draft of New Short Injected Prompt (for Review)

Here is a first-cut version of the concise prompt that would replace the current long `QWEN_INSTRUCTIONS` block. It is deliberately high-signal and delegates real planning structure to a separate skill.

```markdown
Qwen-safe plan-first mode is now active for this session (detected via model id).

You must follow strict plan-first discipline:

- Perform silent analysis of the project.
- Create or maintain a TODO.md (or task_plan.md) in the project root containing small, atomic, independently verifiable tasks in dependency order.
- Present the plan and obtain explicit user approval ("YES") before writing code, creating files, or making edits.
- Work on exactly one task at a time. After completing a task, update the plan file, report progress using the exact prefix "🛡️ pi-qwen-guard:", and stop.
- If you discover new work, add it to the plan and ask for re-approval before proceeding.
- Never attempt large changes or multiple steps in a single response.

Use the edit tool by preference. Keep responses focused and incremental.

Only bypass plan-first discipline if the user explicitly says “skip planning” or “write the whole thing at once”.
```

**Notes on this draft**:

- ~14 lines of actual instructions.
- Strongly promotes the proven pattern without embedding the full workflow.
- Mandates the `🛡️ pi-qwen-guard:` prefix for progress signals.
- Keeps an escape hatch.
- Can be tuned further for tone/length once tested.

We can also have the guard optionally mention a recommended lightweight skill name if one becomes canonical in this repo.

## 8. Open Decisions / Next Input Needed

No major open decisions remain after the 2026-06-01 feedback. The main remaining item is:

- Final wording polish on the short prompt above (and whether the guard should name a specific recommended skill on activation).
- Confirmation that we are comfortable shipping this revised (thinner) guard as part of 1.0.0.

## 6. Risks & Mitigations

- **Risk**: The new prompt is still ignored by the model.  
  **Mitigation**: Make it extremely high-signal and tie it to the external TODO artifact (which the model treats as state).
- **Risk**: Existing users of the current guard (if any) see behavior change.  
  **Mitigation**: This is the first release — no users yet. Document the design clearly.
- **Risk**: Over-engineering for v1.0.0.  
  **Mitigation**: Keep the guard itself tiny. Push complexity into recommended skills.

## 7. Success Criteria for the Revision

- Real test sessions with Qwen3.6 no longer produce streaming terminations on tasks that previously failed.
- The guard remains a small, elegant, "just works" extension.
- Documentation clearly sets expectations and points users to the most effective complementary practices.
- The package earns a clean 1.0.0 release with honest claims.

---

**Next Step**: Reply with decisions on the open items in Section 5 (especially #1 and #4). Once aligned, we can execute Phase 1 with a focused PR or as an amendment to the existing feature work.

This plan prioritizes effectiveness and research-backed design while respecting the constraint of not overloading the model with unnecessary instructions.
