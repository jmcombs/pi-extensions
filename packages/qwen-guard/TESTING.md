# Testing Plan: @jmcombs/pi-qwen-guard

## Goal

Validate whether the revised `pi-qwen-guard` meaningfully reduces streaming terminations ("Stream ended without finish_reason" and "error: terminated") when using Qwen models via Ollama in the Pi coding agent.

This plan uses a **staged approach**:

1. First test the guard **by itself** (no plan+TODO skill or extension).
2. Only if Phase 1 shows clear value, proceed to testing the recommended real-world configuration (guard + a plan-first skill).

## Guiding Principle

We treat the guard as a **thin activator and safety net**, not a complete solution. The most reliable results with Qwen3.6 + Ollama come from combining the guard with a structured plan-first workflow. This plan validates both the standalone value and the combined value.

---

## Phase 1: Standalone Testing (Guard Only)

**Objective**: Measure how much value the guard provides **without** any plan+TODO skill or structured workflow loaded.

### Test Environment

- Use a Qwen3.6 (or equivalent Qwen3 coding) model via Ollama that is known to be prone to streaming terminations on large tasks (e.g. 27B+ coding-optimized variants).
- Fresh Pi session for each major test.
- Load **only** the qwen-guard extension:
  ```bash
  pi -e ./packages/qwen-guard
  ```
- Do **not** load any plan-first, planning-with-files, or similar skill/extension.
- Use the same model settings across comparable tests.

### Recommended Test Prompts

Run these in rough order of difficulty. Start with Prompt A.

**Prompt A — Primary Regression Test (High Priority)**

```
Build a complete, production-ready Express + TypeScript REST API for a "Project Task Board".

Requirements:
- Full CRUD for Projects and Tasks (a project has many tasks)
- Proper input validation using Zod
- Error handling middleware
- Pagination + filtering on the task list endpoint
- Basic authentication via a simple API key middleware (just check a header)
- OpenAPI / Swagger spec generated automatically
- Dockerfile + docker-compose for local dev
- README with setup instructions and example curl commands

Use a clean folder structure (src/, routes/, middleware/, types/, etc.).

Make the code high quality, well typed, and follow modern practices.
```

**Prompt B — Multi-File Feature with Cross-Cutting Concerns**

```
Create a complete user authentication system for a web application, including:
- Registration, login, logout, and password reset flows
- JWT-based authentication with refresh tokens
- Role-based access control (admin vs regular user)
- Protected API routes
- Email verification (mock the email service)
- Proper error handling and input validation

Use Express + TypeScript. Include tests for the auth flows.
```

**Prompt C — Significant Refactoring Task**

```
Take an existing medium-sized TypeScript codebase (provide a small existing project or describe one) and perform a significant refactoring:
- Introduce a clear layered architecture (domain, application, infrastructure)
- Extract business logic from controllers/routes into services
- Add proper dependency injection
- Improve error handling and logging
- Update documentation

Work incrementally and keep the code compiling/runnable at each major step.
```

**Prompt D — Full-Stack Feature (Stretch)**

```
Build a small but complete full-stack feature: a Kanban board with drag-and-drop.
- Backend: Express + TypeScript with in-memory or SQLite storage
- Frontend: Simple React or vanilla JS with real-time feel (can use local state + polling)
- Include CRUD for boards, columns, and cards
- Add basic authorization

Focus on clean separation and incremental delivery.
```

### What to Observe and Record

For each session, capture:

- Did the activation message appear? (`🛡️ pi-qwen-guard: Qwen3.6 incremental mode enabled`)
- Did the model emit any `🛡️ pi-qwen-guard:` prefixed signals?
- Did the model spontaneously create any form of plan or TODO structure?
- How disciplined was the model at staying incremental vs. attempting large changes?
- Did any streaming terminations occur? (Note the exact error and at what point in the task.)
- Overall task completion level (e.g., "70% of requirements implemented before hitting a hard wall").
- Subjective notes on model behavior (e.g., "tried to continue after signaling chunk complete", "became overly hesitant", "ignored the guard after 40 minutes").

### Phase 1 Results (Executed June 2026)

**How Phase 1 was tested:**

- Loaded _only_ the `qwen-guard` extension using `pi -e ./packages/qwen-guard` (no plan-first, planning-with-files, or similar skills were loaded).
- Used the primary test prompt (Prompt A — the full "Project Task Board" Express + TypeScript API).
- Model: `qwen3.6-27b-coding-optimized` via Ollama (the same class of model that had previously triggered streaming terminations in unguarded sessions).
- The session was allowed to run to completion with the model operating under the guard instructions alone.

**Outcome:**

- No streaming terminations ("Stream ended without finish_reason" or equivalent) occurred during the entire build of a substantial multi-file API.
- The model spontaneously created its own `task_plan.md`, broke the work into logical chunks, updated the plan as it progressed, and consistently used the `🛡️ pi-qwen-guard: ✅` prefix to signal completion of chunks.
- The final artifact passed typecheck, lint, build, and smoke tests.
- The model demonstrated clear self-organization into a structured, incremental workflow without any external plan+TODO scaffolding.

**Phase 1 Success Assessment:**
Phase 1 is considered **successful**. The guard enabled the model to complete a large, complex task that had previously caused streaming failures, while producing usable, well-structured code and self-managing its work through its own plan.

**Key Learnings and Settlement:**

- **Prompt-only nature of the guard**: The guard instructions are fundamentally a system-prompt behavioral contract. Much of the bug-catching and architectural quality in the session came from other loaded skills (e.g. `typescript-standards`, `repo-layout`). This was acknowledged as largely out of scope for the guard itself. Its primary responsibility is controlling response size and enforcing incremental signaling to prevent streaming death, not acting as a general code reviewer or architect.
- **Occasional large responses**: The model still produced some responses larger than the target (e.g. a 134-line tasks route in one go). After discussion, we settled that for cohesive logical units, forcing extremely small artificial chunks can harm code quality and coherence more than it helps with streaming reliability. Since no streaming failure occurred, this was accepted as acceptable for Phase 1, with the pragmatic ~60-line target remaining the guideline.
- **Model building its own plan**: This was viewed as a clear win. The instructions successfully prompted the model to create and manage its own structured plan (`task_plan.md`) and use the required signaling, even without an external skill. This validated the effectiveness of the stronger single-version instructions in the "guard alone" scenario.

---

## Phase 2: Combined Testing (Guard + Plan+TODO Workflow)

---

## Phase 2: Combined Testing (Guard + Plan+TODO Workflow)

**Trigger**: Only begin Phase 2 if Phase 1 meets the success criteria above.

**Objective**: Validate the **recommended** real-world usage pattern — the guard working together with a proper plan-first / TODO-based workflow.

### Phase 2 Evaluation Context Prompt

Use the prompt below when you want an agent to analyze and evaluate the _results_ of a Phase 2 test session (i.e., after you have already run the actual Phase 2 test prompt with both the guard and a plan+TODO skill loaded). Paste the full session transcript/output after this prompt.

```
You are an expert evaluator analyzing the results of a Phase 2 test of @jmcombs/pi-qwen-guard used together with a plan+TODO skill.

Context:
- We have already completed Phase 1 testing of the guard in isolation (no plan+TODO skill). Phase 1 was successful: the guard alone enabled a large implementation task to complete without streaming terminations, and the model spontaneously created its own structured plan.
- In this Phase 2 test, the same guard instructions were active, but the user also loaded a proper plan-first / TODO-based skill or workflow.
- The guard instructions are intentionally designed to provide real protection both with and without an external plan+TODO workflow. They enforce small responses (~60 lines), mandatory progress signaling using the exact prefix "🛡️ pi-qwen-guard: ✅" or "🛡️ pi-qwen-guard: ❌", preference for the edit tool, and incremental work. They strongly recommend a plan-first approach but do not require the user to approve every single chunk.

Your task:
Analyze the provided session transcript/output from the Phase 2 test. Produce a structured evaluation covering:

1. **Overall Effectiveness** — Did the combination of guard + plan+TODO workflow produce more reliable, higher-quality incremental behavior than Phase 1 (guard alone)? Be specific.
2. **Signaling Quality** — How consistently and usefully did the model use the `🛡️ pi-qwen-guard: ✅ / ❌` prefix? Did the signals provide good visibility into the model's progress and self-correction?
3. **Interaction with the Plan** — How did the external plan+TODO workflow interact with the guard's rules? Did the model stay within the approved tasks? Did the guard's signaling complement or conflict with the plan updates?
4. **Streaming Reliability** — Were there any streaming terminations or near-misses? How does this compare to Phase 1?
5. **Friction or Overhead** — Did the combination introduce any new problems (e.g., the model becoming overly rigid, asking for unnecessary approvals, or struggling with the dual constraints)?
6. **Recommendations** — What specific improvements (to the guard instructions, to recommended plan+TODO skills, or to testing methodology) would you suggest based on this run?

Be evidence-based and quote relevant sections of the transcript where helpful. Output your analysis in clear Markdown with headings.
```

### Phase 2 Test Prompt (Run This With Guard + Plan+TODO Skill)

Copy and paste the prompt below into a fresh Pi session that has **both** the qwen-guard extension **and** a plan-first / TODO-based skill loaded. This is the actual prompt you run to generate the Phase 2 test data.

```
You are building a complete, production-ready Express + TypeScript REST API for a "Project Task Board" while operating under qwen-guard constraints and using a plan-first workflow.

Requirements:
- Full CRUD for Projects and Tasks (a project has many tasks)
- Proper input validation using Zod
- Error handling middleware
- Pagination + filtering on the task list endpoint
- Basic authentication via a simple API key middleware (just check a header)
- OpenAPI / Swagger spec generated automatically
- Dockerfile + docker-compose for local dev
- README with setup instructions and example curl commands

Use a clean folder structure (src/, routes/, middleware/, types/, etc.).

Make the code high quality, well typed, and follow modern practices.

Operating Rules (enforced by qwen-guard):
- Never output more than ~60 lines of code or changes in a single response.
- After any meaningful piece of work, immediately output a progress signal starting with exactly "🛡️ pi-qwen-guard: " followed by ✅ (for successful progress) or ❌ (for self-correction or limit issues).
- You may continue to the next small chunk after signaling. You do not need explicit user approval after every single signal.
- Prefer the edit tool over write for existing files.

You must also follow the loaded plan-first / TODO skill:
- Begin by performing silent analysis.
- Create or update a clear plan (TODO.md or equivalent) with small, atomic, independently verifiable tasks.
- Present the plan and obtain explicit user approval ("YES") before beginning major implementation work.
- Execute one task at a time. Update the plan after each task. Use the qwen-guard signaling for progress within tasks.
- If you discover new work, add it to the plan and seek re-approval before proceeding.

Start by creating your plan and presenting it for approval.
```

---

## After Phase 2

- Compare results between Phase 1 and Phase 2.
- Document whether the combination delivers the expected step-change improvement.
- Use the combined results to inform the final claims made in the 1.0.0 release notes and README.

## Notes for Evaluators

- Always start fresh sessions when switching between Phase 1 and Phase 2.
- Record model name, quant, Ollama version, and Pi version for every session.
- Capture raw terminal output or session transcripts when possible, especially around any failures or interesting guard signals.
