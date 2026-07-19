# relay ↔ oh-my-pi — live-dispatch results (Phase 8, narrowed per ADR 0009)

Phase 8 is narrowed to its unique, non-automatable value: a **live subscription-Opus
dispatch of `relay` under stock oh-my-pi** — the human `claude-sub` gate. The
automated "relay loads + registers its providers under stock omp" proof is
**superseded by Phase 11** (relay is one of P11's auto-discovered packages); the
current confirmation is recorded below.

## Environment

| Field | Value |
| --- | --- |
| oh-my-pi (`omp`) | `@oh-my-pi/pi-coding-agent@17.0.5` (pinned, under Bun) |
| claude CLI | `@anthropic-ai/claude-code@2.1.215` (`claude`) |
| pi (reference) | `@earendil-works/pi-coding-agent@0.80.9` |
| Isolation | op **absent**; throwaway `PI_CODING_AGENT_DIR` (never the host `~/.pi`) |
| Rig | `docker/interactive-onboarding.Dockerfile` + `docker/run-relay-ohmypi.sh` |

## Automated load + registration (confirmed — P11-covered)

Confirmed on the `pi-ext-interactive` image (stock omp, op absent):

- omp's own loader (`loadExtensions(["/app/packages/relay/index.ts"])`) loads relay
  with **`errors: []`** — relay links and loads clean under stock omp, including its
  `createAssistantMessageEventStream` import from `@earendil-works/pi-ai` (resolved
  through omp's compat shim). **No feature-detect needed.**
- Relay's factory registers providers **`["relay-claude", "relay-grok"]`** (stub
  `ExtensionAPI` capturing `registerProvider`, mirroring
  `packages/relay/index.test.ts`).
- omp launches with `--model relay-claude/opus` preselected: the status bar shows
  `⬢ Relay Claude Opus` and reaches a usable prompt.

This regression proof will be generalized into Phase 11's package-agnostic harness.

## Live dispatch (human `claude-sub` gate — TODO: fill after the maintainer runs it)

The maintainer runs a real turn through relay to subscription Opus under omp; the
turn routes `omp -> resolveModel(relay-claude/opus) -> relay streamSimple ->
claude -p <task> --output-format json --model opus` and streams the final Opus text
back. relay passes **no** auth; `claude` authenticates via its own login.

- **Auth path used:** `TODO` — one of: (A) mounted `~/.claude:ro` (subscription
  oauthAccount = the `claude-sub` gate), (B) `claude login` inside the container,
  or (C) `ANTHROPIC_API_KEY` (proves the same omp/relay mechanics, **not** the
  subscription path).
- **Exact dispatch performed:** `TODO` — the prompt sent (e.g. `Reply with exactly:
  RELAY-OMP-OK`) and the model (`relay-claude/opus`).
- **Outcome — did subscription Opus return a result under omp?** `TODO: PASS / FAIL`
  — the final assistant text relay streamed back (verbatim), and whether it matched
  the prompt.
- **Latency / notes:** `TODO` (a single `claude -p` verify is ~50-80 s; relay's
  heartbeat keeps the run visibly active under omp's stall detection).
- **Any gap found under omp:** `TODO` — e.g. did the provider stream, heartbeat, or
  wall-cap behave differently under omp vs pi? If a real break is found, file a
  follow-up issue and link it here (relay code is modified only for a genuine break,
  D14 / `memory/use-pi-public-apis`).

## Maintainer recipe (exact commands)

```bash
# Build the rig image (from the repo root):
docker build -f docker/interactive-onboarding.Dockerfile -t pi-ext-interactive:latest .

# (A) RECOMMENDED — subscription (claude-sub) gate, host ~/.claude mounted READ-ONLY
#     (exposes only the Claude login, never ~/.pi):
docker run --rm -it -v "$HOME/.claude:/root/.claude:ro" \
  pi-ext-interactive:latest bash docker/run-relay-ohmypi.sh

# (C) API-key path (lower friction; same omp/relay mechanics, not the subscription):
docker run --rm -it -e ANTHROPIC_API_KEY=sk-ant-... \
  pi-ext-interactive:latest bash docker/run-relay-ohmypi.sh

# Inside omp: press enter to skip the intro; the model is already Relay Claude Opus.
# Type a prompt (e.g. "Reply with exactly: RELAY-OMP-OK") and submit. The Opus reply
# streams back through relay. (If not active, Ctrl+P -> "Relay Claude Opus".)
```

Fallback (host, no Docker): install `omp` under Bun + the `claude` CLI, set a
throwaway `PI_CODING_AGENT_DIR` (isolates `~/.pi`) and `PI_OFFLINE=1 OMP_SKIP_SETUP=1`,
then `omp -e packages/relay/index.ts --model relay-claude/opus --no-session`. This
uses the host's existing `claude` login but keeps `~/.pi` isolated via the throwaway
agent dir; it does not need to touch the maintainer's pi config.

## Pointer

- Automated cross-platform load/registration (all shipped packages incl. relay):
  **Phase 11** (`docs/1p-credential-api/PLAN.md`) + **ADR 0009**.
- Relay design: `packages/relay/index.ts`, `packages/relay/provider.ts`,
  `packages/relay/drivers/claude.ts`.
