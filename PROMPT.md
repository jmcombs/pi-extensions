# Pi Extensions Monorepo - AI Agent Prompt

You are an expert coding assistant helping build and maintain the `pi-extensions` monorepo.

## Core Instructions

1. **Always start by reading the plan**
   - Before doing any work, read `PLAN.md` (located in the root of the repository).
   - Treat `PLAN.md` as the single source of truth for the project structure, standards, and roadmap.

2. **Project Goal**
   - Build a high-quality, public monorepo for Pi coding agent extensions.
   - Extensions built so far:
     - `@jmcombs/pi-tavily-search` — Tavily web search tool
     - `@jmcombs/pi-prompt-enhancer` — Codebase-aware prompt enhancer

   Future extensions should be easy to add while maintaining consistent quality.

3. **Key Standards (from PLAN.md)**
   - Follow Pi’s Node requirement (`>=20.6.0`)
   - Use the same rigorous CI, Release Please, testing, linting, and formatting standards as the `dynamix-claude` project (minus author checks)
   - All extensions must pass `npm run check`
   - Only write meaningful tests (no mocking of external APIs, no coverage theater)
   - Use `packages/_template/` when creating new extensions
   - Publish packages so they appear on https://pi.dev/packages

4. **When Working on This Project**
   - Reference `PLAN.md` frequently.
   - Keep changes consistent with the approved structure and tooling.
   - When adding a new extension, copy from `packages/_template/` and follow the instructions in `TEMPLATE.md`.
   - For the Tavily extension, the source of truth is the existing code in `~/.pi/agent/extensions/tavily-extension/`.
   - For the prompt-enhancer extension, the source of truth is `PLAN.md` Section 12 (no pre-existing code to copy from).

5. **Current Status**
   - The repository has been initialized with git.
   - `PLAN.md` and this prompt exist.
   - Two extensions are planned: `@jmcombs/pi-tavily-search` and `@jmcombs/pi-prompt-enhancer`.
   - Monorepo infrastructure (tooling, CI, Release Please) has not yet been set up.
   - We are ready to begin setting up the root configuration and first extension.

Please confirm you have read `PLAN.md` before proceeding with any implementation work.

---

**How to use this prompt:**
Copy everything above (starting from "You are an expert...") and paste it when starting a new conversation with an AI coding agent (including pi itself) working on this monorepo.
