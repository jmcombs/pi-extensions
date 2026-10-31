<div align="center">
  <img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/agent-files/preview.png" width="250" alt="Agent Files">
  <br>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-agent-files"><img src="https://img.shields.io/npm/v/@jmcombs/pi-agent-files.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-agent-files"><img src="https://img.shields.io/npm/dm/@jmcombs/pi-agent-files.svg" alt="npm downloads"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/jmcombs/pi-extensions/stargazers"><img src="https://img.shields.io/github/stars/jmcombs/pi-extensions?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/jmcombs/pi-extensions/issues"><img src="https://img.shields.io/github/issues/jmcombs/pi-extensions" alt="Open issues"></a>
  <a href="https://github.com/sponsors/jmcombs"><img src="https://img.shields.io/badge/Sponsor-30363D?style=flat&logo=GitHub-Sponsors&logoColor=EA4AAA" alt="Sponsor"></a>
</div>

# @jmcombs/pi-agent-files

Locked writers for the Pi coding agent's `auth.json` and `settings.json`. This is a library, not a Pi extension. It does not register tools or commands, and it is not listed on the pi.dev gallery.

Other packages in this repo depend on it so they can save their own keys without replacing a symlink or chmod'ing a file that already exists.

## Install

```bash
npm install @jmcombs/pi-agent-files
```

`@earendil-works/pi-coding-agent` is a peer. Pi provides it when an extension loads. `proper-lockfile` is a normal dependency and installs with the package.

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

`agentAuthPath()` and `agentSettingsPath()` call `getAgentDir()` when `agentDir` is omitted. `mutate` receives the current object, or `undefined` when the file is missing. Return `undefined` to skip the write. A missing file is not created unless `mutate` returns an object.

Writes use `writeFile` on the exact path (`JSON.stringify(next, null, 2)`, no extra trailing newline). An existing symlink stays a symlink. The target is updated. A new `auth.json` is mode `0o600` and its new parent directory is `0o700`. A new settings parent has no mode and is created only when writing. Existing paths are not chmod'd. The lock is a `proper-lockfile` directory at `<path>.lock` with `realpath: false` and a stale limit of 30000 ms.

The writers do not run Pi's settings migration, do not reject top-level strings or non-credential objects, and do not execute `!op read`.

## Publishing

Release Please cannot create this package on npm. OIDC cannot create a brand-new package, and npm will not let you attach a Trusted Publisher to a name that does not exist yet. After this package is on `main` at version `0.0.0`, do the one-time bootstrap from `CONTRIBUTING.md`, then let Release Please publish `1.0.0`.

1. Bootstrap publish, once, from `main`, with your own npm login:

   ```bash
   git checkout main
   git pull --ff-only
   npm whoami
   npm publish --workspace=packages/agent-files --access public
   ```

   `npm whoami` must print your npm user. If it does not, run `npm login` and publish again. This `0.0.0` is throwaway. Release Please's first managed release (`1.0.0`) supersedes it.

2. Configure the Trusted Publisher now that the package exists. Sign in to npmjs.com as the package owner, open `@jmcombs/pi-agent-files` → **Settings → Publishing access → Trusted Publishers**, and add a GitHub Actions publisher:
   - **Organization or user:** `jmcombs`
   - **Repository:** `pi-extensions`
   - **Workflow filename:** `release-please.yml`
   - **Environment:** leave blank

After that, merging the Release Please PR publishes the package with `--provenance --access public`. No `NPM_TOKEN` is stored in GitHub.

## License

[MIT](./LICENSE) © Jeremy Combs
