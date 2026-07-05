#!/usr/bin/env node
/**
 * live-session.mjs — DEPRECATED (superseded in Phase 3).
 *
 * In Phases 1–2 relay was a TOOL (`verify_phase`/`dispatch`) that returned
 * `PENDING` and delivered its result via a bespoke
 * `pi.sendMessage(…, { triggerTurn: true })` pushback. This script proved that
 * async follow-up-turn delivery against a live `pi --mode rpc` session.
 *
 * Phase 3 (Relay Roles) removed that bespoke substrate. Relay is now a registered
 * pi PROVIDER (`relay-claude`): a subagent runs on an external agent by setting
 * `model: relay-claude/opus`, and pi's OWN native subagent-async layer delivers
 * the result — there is no relay-side `triggerTurn` pushback left to prove here.
 *
 * The live provider path (one completion == one full `claude -p` run) is proven by
 * `scripts/harness.mjs` and by the Phase-3 Gate 3.1 subagent run. This file is
 * retained only so the Phase-2 path is not silently deleted; it performs no test.
 */

process.stdout.write(
  "live-session.mjs is deprecated: relay's async pushback was replaced by pi's " +
    "native subagent-async layer in Phase 3. See scripts/harness.mjs for the " +
    "provider proof.\n",
);
process.exit(0);
