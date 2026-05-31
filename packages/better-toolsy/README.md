# @jmcombs/pi-better-toolsy

**Replace noisy bash commands with compact, cross-platform Node.js file tools.**

Provides six file-oriented tools backed by pure `fs/promises` and `path` — no external npm deps, no shell calls. Includes optional _bash interception_ that maps common shell commands to these safer tools (on by default).

## Tools

| Tool          | Replaces                        | Description                                                                              |
| ------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `list_dir`    | `ls`                            | List files/directories, hides dotfiles by default, respects `.gitignore`                 |
| `read_file`   | `cat`                           | Read file contents with optional `offset`/`limit`                                        |
| `code_search` | `grep`, `rg`                    | Search for patterns in source files (uses `ripgrep` if available, falls back to Node.js) |
| `find_files`  | `find`                          | Find files by name pattern, respects `.gitignore`, auto-crawls subdirectories            |
| `edit_file`   | `sed`                           | Replace exact text in a file (validates uniqueness to prevent ambiguous edits)           |
| `write_file`  | manual `echo >`, shell creation | Write content to a file (auto-creates parent directories via `mkdir -p`)                 |

## Installation

```bash
pi install @jmcombs/pi-better-toolsy
```

## Why this exists

When LLM coding agents use bash for file operations, they produce _verbose_ output:

- `ls -la` dumps permissions, timestamps, and sizes nobody asked for
- `cat big-file.ts` wastes context window on megabytes of text
- `grep -rn 'pattern'` often spews hundreds of lines from node_modules or .git

These tools are **compact** — they return only what the LLM needs, with line counts/metadata in structured `details` so the agent can reason about results without parsing raw shell output.

## Configuration

### Bash Interception (enabled by default)

The extension registers the flag `intercept-bash`. When active, common bash commands (`ls`, `cat`, `grep`, `rg`, `find`, `sed`) are intercepted and mapped to their better-toolsy equivalents:

| Bash command          | Mapped tool     |
| --------------------- | --------------- |
| `ls ...`              | → `list_dir`    |
| `cat ...`             | → `read_file`   |
| `grep ...` / `rg ...` | → `code_search` |
| `find ...`            | → `find_files`  |
| `sed ...`             | → `edit_file`   |

To disable interception:

```
pi flag intercept-bash false
```

### Path Safety

All path inputs go through `safeResolve()` which blocks directory traversal (`../../etc/passwd`). Paths are resolved relative to the working directory.

### .gitignore Awareness

`code_search`, `find_files`, and `list_dir` all respect `.gitignore` at the search root, skipping ignored files.

## License

MIT — Jeremy Combs
