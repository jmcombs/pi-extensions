# @jmcombs/pi-notify

A [Pi coding agent](https://pi.dev) extension that sends a native OS desktop
notification when Pi finishes a turn and is waiting for your input — so you can
switch away while Pi works and get tapped on the shoulder the moment it's done.

## Install

```bash
# Globally (recommended)
pi install npm:@jmcombs/pi-notify

# For a single session, without installing
pi -e npm:@jmcombs/pi-notify
```

## What It Adds

- **Event hook**: `agent_end` — automatically sends an OS notification each time
  the agent finishes a turn and is waiting for input.
- **Command**: `/notify [message]` — sends a one-shot test notification. Useful for
  verifying the extension is working after install. Defaults to
  `"Waiting for your input"` when called with no argument.

No tools are registered. The LLM does not call this extension directly.

## Platform Support

| Platform                      | Mechanism     | Notes                                                                                         |
| ----------------------------- | ------------- | --------------------------------------------------------------------------------------------- |
| macOS (Intel + Apple Silicon) | `osascript`   | Ships with every macOS. Works in any terminal (Terminal.app, iTerm2, Ghostty, VS Code, etc.). |
| Linux (desktop)               | `notify-send` | Requires `libnotify-bin`. Present on any desktop environment with a notification daemon.      |
| Linux (headless/server)       | —             | No notification daemon; degrades silently to a Pi TUI notification.                           |
| Windows                       | —             | Not supported in v1; degrades silently to a Pi TUI notification.                              |

### macOS permissions note

The first notification triggers a one-time system permission dialog. The permission
is granted to the terminal application running Pi (Terminal.app, iTerm2, Ghostty,
etc.), not to Pi itself — this is standard macOS behaviour. Click **Allow** when
prompted. If you miss the dialog, open **System Settings → Notifications**, find
your terminal app, and enable **Allow Notifications**.

### Linux note

`notify-send` is provided by the `libnotify-bin` package on Debian/Ubuntu and
`libnotify` on Arch/Fedora. Most desktop Linux installations include it by default.

```bash
# Debian / Ubuntu
sudo apt install libnotify-bin

# Arch
sudo pacman -S libnotify

# Fedora
sudo dnf install libnotify
```

## Requirements

- Pi `>= 0.72.0`
- Node `>= 22.0.0`
- No API keys or additional configuration required

## Development

This package lives in the [pi-extensions monorepo](https://github.com/jmcombs/pi-extensions).

```bash
# From the repo root
npm ci
npm run check       # full quality gate

# Try local changes against a real Pi session
pi -e ./packages/notify
```

The smoke test in `index.test.ts` verifies registration shape only — no OS calls
are made during testing. Real end-to-end behaviour is exercised via `pi -e`.

## License

[MIT](./LICENSE) © Jeremy Combs
