# @jmcombs/pi-EXTENSION_NAME

> TODO: One-paragraph description of what this extension does and who it is
> for. Mention the tools and/or commands it provides.

## Install

```bash
# Globally (recommended)
pi install npm:@jmcombs/pi-EXTENSION_NAME

# For a single session, without installing
pi -e npm:@jmcombs/pi-EXTENSION_NAME
```

See the [Pi packages documentation](https://pi.dev/docs/packages) for git, local
path, project-scoped install, and filtering options.

## What It Adds

- **Tool**: `example_echo` — TODO: describe the tool, its parameters, and what
  the LLM uses it for.
- **Command**: `/example-hello [name]` — TODO: describe the command and any
  arguments.

## Configuration

<!-- Delete this section if your extension does not need any configuration. -->

### API Keys / Secrets

If this extension calls a third-party service, store the credential using one
of Pi's recommended auth storage methods. **Never** hard-code API keys or commit
them to source control.

#### Option 1 — Environment variable

```bash
export EXAMPLE_API_KEY="…"
```

#### Option 2 — `~/.pi/agent/auth.json`

```json
{
  "example": {
    "type": "api_key",
    "key": "EXAMPLE_API_KEY"
  }
}
```

#### Option 3 — Shell-resolved secret (macOS Keychain, 1Password, pass, etc.)

```json
{
  "example": {
    "type": "api_key",
    "key": "!security find-generic-password -ws 'example'"
  }
}
```

```json
{
  "example": {
    "type": "api_key",
    "key": "!op read 'op://Personal/example/credential'"
  }
}
```

The extension reads the key with:

```ts
import { AuthStorage } from "@mariozechner/pi-coding-agent";
const auth = AuthStorage.create();
const apiKey = (await auth.getApiKey("example")) ?? process.env.EXAMPLE_API_KEY;
```

## Requirements

- Pi `>= TODO: minimum tested pi version`
- Node `>= 20.6.0`

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).
See `CONTRIBUTING.md` and `PLAN.md` at the repo root for project conventions.

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
