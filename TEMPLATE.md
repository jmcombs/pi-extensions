# Extension Template — Step-by-Step

This is the canonical guide for creating a new pi-extensions package. The
scaffold itself lives at `packages/_template/` and is **excluded from all
build, lint, test, type-check, format, and version-validation tooling** by
virtue of its `_`-prefix; you can copy it freely without breaking the
quality gate.

> Read `CONTRIBUTING.md` and `VERSIONING.md` at the repo root before starting.

## 0. Decide on a name

Pick a short, lowercase, hyphen-delimited name. The directory name and the
"slug" portion of the npm name must match.

- Directory name: `packages/<slug>/` — e.g. `tavily-search`
- npm name: `@jmcombs/pi-<slug>` — e.g. `@jmcombs/pi-tavily-search`

Throughout this guide the placeholder `EXTENSION_NAME` refers to your slug.

## 1. Copy the template

From the repository root:

```bash
cp -R packages/_template packages/EXTENSION_NAME
```

The template already contains a copy of the repo's MIT `LICENSE`. Each
published package needs its own copy because npm `pack` does not pull files
from outside the package directory and we want the LICENSE visible on the
npm and GitHub package pages.

## 2. Replace placeholders

Search and replace **every** occurrence of `EXTENSION_NAME` inside
`packages/EXTENSION_NAME/` with your slug:

```bash
# Preview the matches first
grep -r "EXTENSION_NAME" packages/EXTENSION_NAME

# Then rewrite (BSD/macOS sed)
LC_ALL=C find packages/EXTENSION_NAME -type f \
  -exec sed -i '' "s/EXTENSION_NAME/<your-slug>/g" {} +
```

After the rewrite, also resolve every `TODO:` comment in:

- `package.json` — `description`, `keywords`, optional `pi.video`
- `README.md` — top description, tool/command bullets, requirements section,
  Configuration section (delete entirely if your extension needs no secrets)
- `index.ts` — replace the `example_echo` tool and `example-hello` command with
  your real implementation
- `index.test.ts` — replace the example expectations with your real tool and
  command names

## 3. Implement the extension

The default-exported factory in `index.ts` receives an `ExtensionAPI`. Use it to
register tools, commands, shortcuts, flags, and event handlers. See
[`docs/extensions.md`](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/extensions.md)
for the full surface, and the existing extensions in `packages/` for working
examples.

Conventions:

- TypeBox schemas for tool parameters; `Static<typeof schema>` for the input
  type. Export the input type if other extensions might want to type a
  `tool_call` event for your tool.
- Return objects of shape `{ content, details }` from tools.
- For secrets, **always** read through `AuthStorage` with a `process.env`
  fallback (see `README.md` template).
- Pi-runtime packages (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`,
  `@mariozechner/pi-agent-core`, `@mariozechner/pi-tui`, `typebox`) go in
  `peerDependencies` with `"*"`. **Do not bundle them.**
- Other npm runtime deps go in `dependencies`. They are installed automatically
  when a user runs `pi install`.

## 4. Add a smoke test

The template's `index.test.ts` is a real, non-mocking smoke test that builds a
minimal `ExtensionAPI` stub and asserts your factory registers the resources it
claims. Update the expectations to match your real tool/command names.

If your extension does end-to-end work that you want to test against the real
service, prefer a manual `pi -e` workflow over network mocks. Coverage theater
is explicitly discouraged (see `CONTRIBUTING.md` → Testing Philosophy).

## 5. Add an asset for the gallery

Assets live at **the repo root** under `assets/<slug>/`, not inside the
package. This keeps the npm tarball small (assets aren't bundled in the
tarball) and lets the pi.dev gallery card pick them up via the `pi.image`
raw-GitHub URL in `package.json`.

```bash
mkdir -p assets/EXTENSION_NAME
# drop preview.png (or .jpg/.gif/.webp) into assets/EXTENSION_NAME/
# optionally drop preview.mp4 there too
```

The template's `package.json` already references the right URL
(`https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/<slug>/preview.png`).
Add a `pi.video` field with the matching `.mp4` URL if you also ship a video.

## 6. Register with Release Please

Add an entry to **both** files at the repo root:

`release-please-config.json` — under `packages`:

```json
"packages/EXTENSION_NAME": {
  "release-type": "node",
  "component": "EXTENSION_NAME",
  "package-name": "@jmcombs/pi-EXTENSION_NAME",
  "changelog-path": "CHANGELOG.md"
}
```

`.release-please-manifest.json`:

```json
"packages/EXTENSION_NAME": "0.0.0"
```

Keep the package's `package.json` `"version"` at `"0.0.0"` and remove
`"private": true`. The first releasable commit (`feat:`, `fix:`, etc.) will
trigger a `1.0.0` release — see `VERSIONING.md` for the rationale.

## 7. Verify locally

```bash
# From the repo root
npm install            # picks up the new workspace
npm run check          # must be green
pi -e ./packages/EXTENSION_NAME    # smoke test against a real pi session
```

## 8. Open a PR

Use a Conventional Commit title scoped to your package, for example:

```
feat(EXTENSION_NAME): initial release
```

After merge, Release Please will open a release PR for the package. Merging
that release PR tags `EXTENSION_NAME/v1.0.0` and triggers the npm publish.
