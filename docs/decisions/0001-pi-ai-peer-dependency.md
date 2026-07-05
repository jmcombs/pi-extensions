# 0001 — Add `@earendil-works/pi-ai` as a relay peer-dependency

- Status: Accepted
- Phase: 3 (Relay Roles — provider seam)
- Date: 2026-07-05

## Context

`@jmcombs/pi-relay`'s provider (`streamSimple`) must return pi's
`AssistantMessageEventStream` so pi's agent loop can consume the relayed
`claude -p` completion (`for await (event of stream)` + `await stream.result()`).

The Phase-3 build hand-rolled that contract in `packages/relay/stream.ts`
(`RelayEventStream`). The stated reason was that the root-hoisted
`@earendil-works/pi-ai` did not expose the stream factory. On re-inspection that
is not true: `@earendil-works/pi-ai` ships
`export declare function createAssistantMessageEventStream(): AssistantMessageEventStream`
in `dist/utils/event-stream`, re-exported from the package root
(`export * from "./utils/event-stream.js"`) and documented "for use in
extensions". Re-implementing it by hand violates **D11 (use pi's public
extension APIs — never reinvent a pi contract)**.

## Decision

- Add `@earendil-works/pi-ai` to `packages/relay/package.json`
  `peerDependencies` as `"*"`. This is the **official** `@earendil-works`
  package, not the forbidden `@mariozechner` fork — permitted by D11 and
  consistent with D5 (template peer-deps are all `"*"`).
- Import `createAssistantMessageEventStream()` from `@earendil-works/pi-ai` in
  `provider.ts` and use it for the relay completion stream.
- Delete `packages/relay/stream.ts` and its `RelayEventStream` entirely.

## Consequences

- Relay no longer maintains a parallel copy of pi's event-stream contract; drift
  against pi's runtime is impossible by construction.
- The root `package-lock.json` gains exactly one line (the pi-ai peer-dep entry);
  no new resolved dependency is installed (pi-ai is already present transitively),
  so `npm ci` parity (Gate 4) holds and no fork is introduced.
- `package.json` `files` drops `stream.ts`; the published tarball shrinks by one
  module.
