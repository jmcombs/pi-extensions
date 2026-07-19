<div align="center">
  <img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/EXTENSION_NAME/preview.png" width="250" alt="@jmcombs/pi-EXTENSION_NAME">
  <br>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-EXTENSION_NAME"><img src="https://img.shields.io/npm/v/@jmcombs/pi-EXTENSION_NAME.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-EXTENSION_NAME"><img src="https://img.shields.io/npm/dm/@jmcombs/pi-EXTENSION_NAME.svg" alt="npm downloads"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/jmcombs/pi-extensions/stargazers"><img src="https://img.shields.io/github/stars/jmcombs/pi-extensions?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/jmcombs/pi-extensions/issues"><img src="https://img.shields.io/github/issues/jmcombs/pi-extensions" alt="Open issues"></a>
  <a href="https://github.com/sponsors/jmcombs"><img src="https://img.shields.io/badge/Sponsor-30363D?style=flat&logo=GitHub-Sponsors&logoColor=EA4AAA" alt="Sponsor"></a>
</div>

# @jmcombs/pi-EXTENSION_NAME

> TODO: One-paragraph description of what this extension does and who it is
> for. Mention the tools and/or commands it provides.

## Quick Start

Get the extension in under a minute:

1. Install:

   ```bash
   pi install npm:@jmcombs/pi-EXTENSION_NAME
   ```

2. (Optional) Try without installing:

   ```bash
   pi -e ./packages/EXTENSION_NAME
   ```

See the [Pi packages documentation](https://pi.dev/docs/packages) for git, local path, project-scoped install, and filtering options.

## What It Adds

See the [Pi packages documentation](https://pi.dev/docs/packages) for git, local
path, project-scoped install, and filtering options.

## What It Adds

- **Tool**: `example_echo` — TODO: describe the tool, its parameters, and what
  the LLM uses it for.
- **Command**: `/example-hello [name]` — TODO: describe the command and any
  arguments.

## Configuration

<!-- Delete this section — and drop the `@jmcombs/pi-1password` dependency from
     package.json — if your extension needs no secrets. -->

### API Keys / Secrets

If this extension calls a third-party service, handle its credential through the
[`@jmcombs/pi-1password`](https://www.npmjs.com/package/@jmcombs/pi-1password)
credential API. **Never** hard-code API keys or commit them to source control,
and never surface a key (entered or resolved) in LLM-visible text.

`@jmcombs/pi-1password` exports a small, stateless credential surface —
`resolveSecret` reads `~/.pi/agent/auth.json` and resolves the stored entry
(either a literal key or an `!op read 'op://…'` reference) fresh on every call;
`onboardSecret` runs the setup flow, which **branches on 1Password availability**
(a live vault → item → field picker when the `op` CLI is configured, secure
masked manual entry otherwise). Existing `auth.json` keys — literals and
`!op read` references alike — keep resolving unchanged.

This is the same pattern the shipped extensions use;
`packages/context7/index.ts` is the reference implementation.

#### 1. Declare the dependency

Install it as a regular dependency (this records the current version for you):

```bash
npm install @jmcombs/pi-1password
```

It is a hard `dependencies` entry (never a peer): pi installs extensions with
`--omit=peer`, so a peer would not be installed and the import would fail. The
dependency auto-installs, so the credential API is always importable.

#### 2. Register a `<slug>_setup` command

By convention the credential-setup command is named
`{brand-slug}_setup` and delegates to `onboardSecret`:

```ts
import { onboardSecret, resolveSecret } from "@jmcombs/pi-1password";

pi.registerCommand("example_setup", {
  description: "Set up or update your Example API key (never shown to the agent).",
  handler: async (_args, ctx) => {
    const result = await onboardSecret(ctx, { name: "example", label: "Example" });
    ctx.ui.notify(result.message, result.ok ? "info" : "warning");
  },
});
```

#### 3. Resolve on use, with auto-onboard on a miss

Inside a tool's `execute()`, resolve the key; if it is missing, run onboarding
once and re-resolve. This preserves the "prompt on first use" experience without
ever leaking the key to the model:

```ts
async execute(_toolCallId, params, signal, _onUpdate, ctx) {
  let apiKey = await resolveSecret("example");
  if (!apiKey) {
    const r = await onboardSecret(ctx, { name: "example", label: "Example" });
    if (r.ok) {
      apiKey = await resolveSecret("example");
    }
  }
  if (!apiKey) {
    return {
      content: [{ type: "text", text: "Cancelled: no Example API key provided." }],
      details: { error: "missing_api_key" },
    };
  }

  // …use `apiKey` to call the third-party service…
}
```

For the full walkthrough — architecture, the onboarding availability branch, the
resolve sequence, and a worked context7 example with diagrams — see the developer
integration guide: [`INTEGRATION.md`](../../docs/1p-credential-api/INTEGRATION.md).

## Requirements

- Pi `>= TODO: minimum tested pi version`
- Node `>= 20.6.0`

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).
See `CONTRIBUTING.md` at the repo root for project conventions.

```bash
# From the repo root
npm ci
npm run check       # full quality gate
npm run test        # this package's smoke test
```

To try local changes against a real Pi session:

```bash
pi -e ./packages/EXTENSION_NAME
```

## License

[MIT](./LICENSE) © Jeremy Combs
