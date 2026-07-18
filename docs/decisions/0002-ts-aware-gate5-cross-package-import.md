# 0002 — TS-aware loader for Phase 2 Gate 5 (cross-package import)

- Status: Accepted
- Phase: 2 (1Password credential API + warm-on-load + API reference)
- Date: 2026-07-18

> Note: an unrelated repo ADR also carries the number `0002`
> (`0002-per-role-execution-posture.md`, a relay-project decision). This ADR is
> `0002` within the `docs/1p-credential-api/` plan's Appendix A decision log,
> which numbers its own decisions from `0001`. The filename slug disambiguates
> (the same convention as the two `0001-*` ADRs).

## Context

Phase 2's Testing Gate 5 ("Cross-package import resolves") was authored as a
literal, plain-`node` command:

```bash
node -e "import('@jmcombs/pi-1password').then(m=>console.log(typeof m.resolveSecret, typeof m.is1PasswordAvailable))"
```

expecting output `function function`. Run under plain Node ESM it fails:

```
ERR Cannot find module '…/packages/1password/ui/bordered-popups.js'
    imported from …/packages/1password/index.ts
```

The failure is **not** in the Phase 2 code. `@jmcombs/pi-1password`'s entry
(`index.ts`) imports `./ui/bordered-popups.js`, and the package uses the
standard TypeScript-ESM convention of writing internal import specifiers with a
`.js` suffix that resolve onto sibling `.ts` files at load time. Plain Node's
ESM resolver does **not** remap a `.js` specifier onto a `.ts` file (its
type-stripping loader resolves specifiers literally), so it cannot load any
module in this repo that uses that convention — including the offending
`./ui/bordered-popups.js` line, which is **pre-existing and unchanged** by
Phase 2. The convention is repo-wide: the `.js`-for-`.ts` internal-import
pattern appears ~45× across the packages, and on the integration branch's own
`index.ts`.

pi never loads extensions with plain Node. It loads them via **jiti** with
`moduleCache: false` (`loader.js:314–315`, cited in Locked Decision D3), which
is TS-aware and performs exactly this `.js`→`.ts` resolution. The repo's own
TypeScript runner, `tsx` (a devDependency), resolves the same way. Under either,
the package loads and all six exports resolve:

```bash
$ npx tsx -e "import('@jmcombs/pi-1password').then(m=>console.log(typeof m.resolveSecret, typeof m.is1PasswordAvailable))"
function function
```

So the gate's *intent* — "a consumer can import the API and receive the exported
functions" — is satisfied; only the gate's chosen runner (`node`) was
incompatible with the repo's TS-ESM convention and with how pi actually loads
extensions.

## Decision

Correct Phase 2's Gate 5 command to run under a **TS-aware loader** that mirrors
pi's jiti runtime, using the repo's existing `tsx`:

```bash
npx tsx -e "import('@jmcombs/pi-1password').then(m=>console.log(typeof m.resolveSecret, typeof m.is1PasswordAvailable))"
```

run from the repo root, Expected `function function`. All other Phase 2 gates
are unchanged. The maintainer explicitly approved this correction after the
verifier proved the code is correct (all six exports import as `function` under
jiti/tsx).

## Consequences

- Gate 5 now tests the property it was meant to test, through the same class of
  TS-aware loader pi uses in production (jiti), rather than through a plain-Node
  path that no pi extension is ever loaded by.
- No production code changes: the `.js`-for-`.ts` internal-import convention is
  repo-wide and correct for pi/jiti; "fixing" it for plain Node would diverge
  from the established repo pattern and is unnecessary.
- The plan's Appendix A gains a row for this ADR, and the Phase 2 Gate 5 row's
  Command cell is updated to the `npx tsx …` form.
