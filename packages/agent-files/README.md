# @jmcombs/pi-agent-files

Shared locked writers for the Pi coding agent's `auth.json` and `settings.json`.
This is a library, not a Pi extension: it does not register tools or commands,
and it is not a `pi-package`.

## Install

```bash
npm install @jmcombs/pi-agent-files
```

`@earendil-works/pi-coding-agent` is a peer dependency (Pi provides it at
runtime). `proper-lockfile` is a direct dependency.

## Usage

```ts
import {
  agentAuthPath,
  agentSettingsPath,
  updateAuthJson,
  updateSettingsJson,
} from "@jmcombs/pi-agent-files";

const authPath = agentAuthPath();
const settingsPath = agentSettingsPath();

await updateAuthJson((current) => ({
  ...(current ?? {}),
  GH_TOKEN: "!op read 'op://Vault/Item/credential'",
}));

await updateSettingsJson((current) => {
  if (!current) return { theme: "dark" };
  return { ...current, theme: "dark" };
});
```

`agentAuthPath()` and `agentSettingsPath()` call `getAgentDir()` when `agentDir`
is omitted. `mutate` receives the current object, or `undefined` when the file
is missing. Return `undefined` to skip the write. A missing file is not created
unless `mutate` returns an object.

Writes use `writeFile` on the exact path (`JSON.stringify(next, null, 2)`, no
extra trailing newline). An existing symlink stays a symlink; the target is
updated. A new `auth.json` is mode `0o600` and its new parent directory is
`0o700`. A new settings parent has no mode and is created only when writing.
Existing paths are not chmod'd. The lock is a `proper-lockfile` directory at
`<path>.lock` with `realpath: false` and a stale limit of at least 30000 ms.

The writers do not run Pi's settings migration, do not reject top-level strings
or non-credential objects, and do not execute `!op read`.

## Publishing

Do not `npm publish` this package from a workstation.

Before the first release, the maintainer must configure npm Trusted Publishing
for `@jmcombs/pi-agent-files` (GitHub Actions publisher: organization `jmcombs`,
repository `pi-extensions`, workflow filename `release-please.yml`). Release
Please publishes after that one-time setup. Until Trusted Publishing is
configured, the release workflow cannot publish this package.
