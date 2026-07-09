<div align="center">
  <img src="https://raw.githubusercontent.com/jmcombs/pi-extensions/main/assets/better-toolsy/preview.png" width="250" alt="pi-better-toolsy">
  <br>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-better-toolsy"><img src="https://img.shields.io/npm/v/@jmcombs/pi-better-toolsy.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@jmcombs/pi-better-toolsy"><img src="https://img.shields.io/npm/dm/@jmcombs/pi-better-toolsy.svg" alt="npm downloads"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/jmcombs/pi-extensions/stargazers"><img src="https://img.shields.io/github/stars/jmcombs/pi-extensions?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/jmcombs/pi-extensions/issues"><img src="https://img.shields.io/github/issues/jmcombs/pi-extensions" alt="Open issues"></a>
  <a href="https://github.com/sponsors/jmcombs"><img src="https://img.shields.io/badge/Sponsor-30363D?style=flat&logo=GitHub-Sponsors&logoColor=EA4AAA" alt="Sponsor"></a>
</div>

# @jmcombs/pi-better-toolsy

Drop-in replacements for Pi's built-in `ls`, `read`, `grep`, `find`, `edit`, and `write` tools — transparently adds `.gitignore` awareness, path-traversal protection, and injection-safe edits without changing how the agent works. It also normalizes shell-unsafe `gh` PR/issue/release bodies so Markdown backticks don't get command-substituted.

## Quick Start

```bash
pi install npm:@jmcombs/pi-better-toolsy
```

That's it. The agent uses its normal tool names and your implementations run automatically.

## How It Works

Pi exposes six built-in file tools that the LLM is trained to call by name. This extension overrides all six with Node.js implementations that add correctness and safety guarantees the originals lack.

| Tool    | What's added                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ls`    | `.gitignore` filtering, dotfile suppression, directories listed as `name/`                                                                 |
| `read`  | 50 KB size guard, accurate line-number prefixes when using `offset`                                                                        |
| `grep`  | Relative paths in all results, ripgrep fast-path with Node.js fallback, `ignoreCase` / `literal` / `context` flags, `.gitignore` filtering |
| `find`  | `.gitignore` filtering, path-based gitignore patterns (`dist/**`), reliable result cap                                                     |
| `edit`  | `$`-injection-safe replacement (slice arithmetic, not `String.replace`), uniqueness validation, multiple edits in one call                 |
| `write` | Path-traversal guard, automatic parent directory creation                                                                                  |

Because the overrides use the same tool names, the agent's trained behavior is completely unchanged — it calls `grep`, `edit`, etc. as always, and the improvements are invisible.

### Path Safety

Every tool resolves user-supplied paths through `safeResolve()`, which blocks directory traversal attacks (`../../etc/passwd`). Paths are always resolved relative to the current working directory.

### .gitignore Awareness

`ls`, `grep`, and `find` load `.gitignore` at the search root and skip ignored entries. Path-based patterns (`dist/**`, `packages/*/node_modules/`) are matched against the full relative path, not just the basename, so nested ignores work correctly.

### $ Injection Safety

The built-in `edit` tool uses `String.prototype.replace`, which silently expands special `$`-patterns in replacement text (`$&`, `` $` ``, `$'`, `$$`). This is especially dangerous in TypeScript source files full of template literals and `$`-prefixed identifiers. The override uses slice arithmetic so replacement text is always treated as a literal string.

### Multi-Edit Support

The `edit` tool accepts an array of `{ oldText, newText }` pairs and applies them in sequence within a single call. Each edit is validated for uniqueness before any change is written to disk.

### Shell-Safe `gh` Bodies

When a model writes `gh pr create --body "## Notes about \`ci.yml\` built by $(date)"`, bash performs command substitution on the backticks and `$(…)` **inside the double quotes**, silently garbling the PR body. A `tool_call` hook rewrites the `--body`, `--title`, and `--notes` values of `gh pr`, `gh issue`, and `gh release` commands to single-quoted form (which disables all expansion) before the built-in `bash` tool runs — so the body lands verbatim on the first try instead of relying on the model noticing and re-issuing an edit.

It only acts when the value is double-quoted **and** contains an unescaped backtick or `$`, and it is deliberately fail-safe: any parsing ambiguity (e.g. nested quotes inside `$(…)`) leaves the command untouched. Generic `-n`/`-b`/`-t` flags on non-`gh` commands (`grep -n`, `sort -n`) are never affected. Each rewrite surfaces an in-session `🔧 bt` notification naming the flags it normalized (the same signature the other tools carry), and is also logged for non-interactive runs.

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).

```bash
# From the repo root
npm ci
npm run check
```

To test changes locally against a real Pi session:

```bash
pi -e ./packages/better-toolsy
```

## License

[MIT](./LICENSE) © Jeremy Combs
